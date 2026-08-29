/**
 * Crypto DCA & Intelligent Portfolio Engine
 * Monolithic Express server: REST API + static dashboard + PostgreSQL +
 * free data feeds + Gemini analyst + Telegram bot + cron automation.
 *
 * Only paid key: GEMINI_API_KEY (optional — a rule-based analyst is used when absent).
 */
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const { Pool } = require("pg");

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONTHLY_LKR = Number(process.env.MONTHLY_BUDGET_LKR || 10000);
const DCA_DAY = Number(process.env.DCA_DAY_OF_MONTH || 1);
const COINS = ["BTC", "ETH", "SOL", "BNB"];
const RESERVE = ["USDT", "USDC"];
const ALL_SYMBOLS = [...COINS, "USDT"];
const CG_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  USDT: "tether",
  USDC: "usd-coin",
};
const binancePair = (s) => `${s}USDT`;

const http = axios.create({ timeout: 12000, headers: { "User-Agent": "dca-engine/1.0" } });

// ----------------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});
const db = { query: (text, params) => pool.query(text, params) };

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("[db] schema applied");
}

// ----------------------------------------------------------------------------
// Small numeric helpers / indicators
// ----------------------------------------------------------------------------
const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
/** Three tiered support zones from recent range (fib retracements). */
function fibLadder(closes) {
  if (!closes || closes.length < 10) return [];
  const recent = closes.slice(-90);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const span = high - low;
  return [0.382, 0.5, 0.618].map((lvl) => round(high - span * lvl, 2));
}

// ----------------------------------------------------------------------------
// Free data feeds (all defensive — return fallback/null on failure)
// ----------------------------------------------------------------------------
let fxCache = { rate: Number(process.env.FALLBACK_USD_LKR || 300), at: 0 };
async function getUsdLkr() {
  if (Date.now() - fxCache.at < 3600_000) return fxCache.rate;
  try {
    const { data } = await http.get("https://open.er-api.com/v6/latest/USD");
    const lkr = data && data.rates && data.rates.LKR;
    if (lkr) fxCache = { rate: lkr, at: Date.now() };
  } catch (e) {
    console.warn("[fx] using fallback:", e.message);
  }
  return fxCache.rate;
}

async function getSpotUsd(symbol) {
  if (RESERVE.includes(symbol)) return 1;
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbol: binancePair(symbol) },
    });
    return Number(data.price);
  } catch (e) {
    try {
      const { data } = await http.get("https://api.coingecko.com/api/v3/simple/price", {
        params: { ids: CG_IDS[symbol], vs_currencies: "usd" },
      });
      return Number(data[CG_IDS[symbol]].usd);
    } catch (e2) {
      console.warn(`[price] ${symbol} spot failed:`, e2.message);
      return null;
    }
  }
}

async function getKlineCloses(symbol, limit = 200) {
  if (RESERVE.includes(symbol)) return new Array(limit).fill(1);
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/klines", {
      params: { symbol: binancePair(symbol), interval: "1d", limit },
    });
    return data.map((k) => Number(k[4]));
  } catch (e) {
    try {
      const { data } = await http.get(
        `https://api.coingecko.com/api/v3/coins/${CG_IDS[symbol]}/market_chart`,
        { params: { vs_currency: "usd", days: limit, interval: "daily" } },
      );
      return data.prices.map((p) => Number(p[1]));
    } catch (e2) {
      console.warn(`[klines] ${symbol} failed:`, e2.message);
      return [];
    }
  }
}

async function get24hChange(symbol) {
  if (RESERVE.includes(symbol)) return 0;
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/ticker/24hr", {
      params: { symbol: binancePair(symbol) },
    });
    return Number(data.priceChangePercent);
  } catch (e) {
    return null;
  }
}

async function getFearGreed() {
  try {
    const { data } = await http.get("https://api.alternative.me/fng/?limit=1");
    const d = data.data[0];
    return { value: Number(d.value), classification: d.value_classification };
  } catch (e) {
    return { value: null, classification: "Unknown" };
  }
}

let newsCache = { items: [], at: 0 };
async function getNews() {
  if (Date.now() - newsCache.at < 900_000 && newsCache.items.length) return newsCache.items;
  const Parser = require("rss-parser");
  const parser = new Parser({ timeout: 10000 });
  const feeds = [
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
  ];
  const items = [];
  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items.slice(0, 5)) {
        items.push({ title: it.title, link: it.link, source: feed.title || url, date: it.pubDate });
      }
    } catch (e) {
      console.warn("[news] feed failed:", url, e.message);
    }
  }
  if (items.length) newsCache = { items, at: Date.now() };
  return items;
}

let onchainCache = { data: null, at: 0 };
async function getOnchain() {
  if (Date.now() - onchainCache.at < 1800_000 && onchainCache.data) return onchainCache.data;
  try {
    const [{ data: chains }, { data: hist }] = await Promise.all([
      http.get("https://api.llama.fi/v2/chains"),
      http.get("https://api.llama.fi/v2/historicalChainTvl"),
    ]);
    const totalTvl = chains.reduce((a, c) => a + (c.tvl || 0), 0);
    const top = [...chains].sort((a, b) => b.tvl - a.tvl).slice(0, 5).map((c) => ({ name: c.name, tvl: c.tvl }));
    let growth7d = null;
    if (Array.isArray(hist) && hist.length > 8) {
      const now = hist[hist.length - 1].tvl;
      const prev = hist[hist.length - 8].tvl;
      if (prev) growth7d = ((now - prev) / prev) * 100;
    }
    onchainCache = { data: { totalTvl, growth7d, top }, at: Date.now() };
  } catch (e) {
    console.warn("[onchain] failed:", e.message);
  }
  return onchainCache.data || { totalTvl: null, growth7d: null, top: [] };
}

// ----------------------------------------------------------------------------
// Market snapshot (in-memory + price_cache table)
// ----------------------------------------------------------------------------
const MARKET = { fx: fxCache.rate, updatedAt: null, coins: {}, fearGreed: { value: null }, closes: {} };

function mayerBand(m) {
  if (m == null) return { multiplier: 1, label: "Unknown" };
  if (m < 0.8) return { multiplier: 1.3, label: "Undervalued dip" };
  if (m <= 1.4) return { multiplier: 1.0, label: "Baseline" };
  if (m <= 2.0) return { multiplier: 0.8, label: "Extended" };
  return { multiplier: 0.5, label: "Overextended top" };
}

async function refreshMarket() {
  const fx = await getUsdLkr();
  MARKET.fx = fx;
  MARKET.fearGreed = await getFearGreed();
  for (const sym of COINS) {
    try {
      const closes = await getKlineCloses(sym, 200);
      const spot = (await getSpotUsd(sym)) ?? (closes.length ? closes[closes.length - 1] : null);
      const sma200 = sma(closes, 200);
      const sma50 = sma(closes, 50);
      const ema20 = ema(closes, 20);
      const rsi14 = rsi(closes, 14);
      const change24h = await get24hChange(sym);
      const mayer = spot && sma200 ? spot / sma200 : null;
      const ladderUsd = fibLadder(closes);
      MARKET.closes[sym] = closes;
      MARKET.coins[sym] = {
        symbol: sym,
        spotUsd: round(spot, 4),
        priceLkr: spot ? round(spot * fx, 2) : null,
        sma200: round(sma200, 4),
        sma50: round(sma50, 4),
        ema20: round(ema20, 4),
        rsi14: round(rsi14, 2),
        mayer: round(mayer, 4),
        change24h: round(change24h, 2),
        band: mayerBand(mayer),
        ladderUsd,
        ladderLkr: ladderUsd.map((p) => round(p * fx, 2)),
      };
      await db.query(
        `INSERT INTO price_cache (symbol, price_usd, price_lkr, sma_200, sma_50, ema_20, rsi_14, mayer_multiple, change_24h, ladder_json, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           price_usd=$2, price_lkr=$3, sma_200=$4, sma_50=$5, ema_20=$6,
           rsi_14=$7, mayer_multiple=$8, change_24h=$9, ladder_json=$10, updated_at=NOW()`,
        [sym, spot, spot ? spot * fx : null, sma200, sma50, ema20, rsi14, mayer, change24h, JSON.stringify(ladderUsd)],
      ).catch((e) => console.warn("[cache] upsert failed:", e.message));
    } catch (e) {
      console.warn(`[market] ${sym} refresh failed:`, e.message);
    }
  }
  MARKET.updatedAt = new Date().toISOString();
  console.log("[market] refreshed at", MARKET.updatedAt);
}

function priceLkrFor(symbol, fx) {
  if (RESERVE.includes(symbol)) return fx; // 1 USD
  const c = MARKET.coins[symbol];
  return c && c.priceLkr ? c.priceLkr : null;
}

// ----------------------------------------------------------------------------
// Portfolio (VWAP / P&L) from transactions
// ----------------------------------------------------------------------------
async function computePortfolio() {
  const fx = await getUsdLkr();
  const { rows: txs } = await db.query("SELECT * FROM transactions ORDER BY created_at ASC");
  const acc = {}; // symbol -> running state
  for (const t of txs) {
    const s = t.symbol;
    acc[s] = acc[s] || { units: 0, cost: 0, invested: 0, realizedLkr: 0, buys: 0, sells: 0 };
    const a = acc[s];
    const units = Number(t.units);
    const amount = Number(t.amount_lkr);
    if (t.side === "SELL") {
      const vwap = a.units > 0 ? a.cost / a.units : 0;
      const costRemoved = vwap * units;
      a.realizedLkr += amount - costRemoved; // amount = proceeds
      a.units -= units;
      a.cost -= costRemoved;
      a.sells += 1;
    } else {
      a.units += units;
      a.cost += amount;
      a.invested += amount;
      a.buys += 1;
    }
  }

  let totalInvested = 0;
  let totalValue = 0;
  let totalRealized = 0;
  let reserveLkr = 0;
  const holdings = [];
  for (const sym of Object.keys(acc)) {
    const a = acc[sym];
    const priceLkr = priceLkrFor(sym, fx);
    const valueLkr = priceLkr != null ? a.units * priceLkr : 0;
    const vwapLkr = a.units > 0 ? a.cost / a.units : 0;
    const unrealizedLkr = priceLkr != null ? valueLkr - a.cost : 0;
    totalRealized += a.realizedLkr;
    if (RESERVE.includes(sym)) {
      reserveLkr += valueLkr;
    } else {
      totalInvested += a.invested;
      totalValue += valueLkr;
    }
    holdings.push({
      symbol: sym,
      units: round(a.units, 8),
      vwapLkr: round(vwapLkr, 2),
      vwapUsd: round(vwapLkr / fx, 4),
      priceLkr: priceLkr != null ? round(priceLkr, 2) : null,
      investedLkr: round(a.invested, 2),
      valueLkr: round(valueLkr, 2),
      valueUsd: round(valueLkr / fx, 2),
      unrealizedLkr: round(unrealizedLkr, 2),
      unrealizedUsd: round(unrealizedLkr / fx, 2),
      unrealizedPct: a.cost > 0 ? round((unrealizedLkr / a.cost) * 100, 2) : 0,
      realizedLkr: round(a.realizedLkr, 2),
      isReserve: RESERVE.includes(sym),
    });
  }
  holdings.sort((x, y) => y.valueLkr - x.valueLkr);

  const totalUnrealized = totalValue - totalInvested;
  return {
    fx,
    updatedAt: MARKET.updatedAt,
    totals: {
      investedLkr: round(totalInvested, 2),
      valueLkr: round(totalValue, 2),
      valueUsd: round(totalValue / fx, 2),
      unrealizedLkr: round(totalUnrealized, 2),
      unrealizedPct: totalInvested > 0 ? round((totalUnrealized / totalInvested) * 100, 2) : 0,
      realizedLkr: round(totalRealized, 2),
      reserveLkr: round(reserveLkr, 2),
      netProfitPct: totalInvested > 0 ? round(((totalUnrealized + totalRealized) / totalInvested) * 100, 2) : 0,
    },
    holdings,
    nextDcaDate: nextDcaDate(),
    monthlyBudgetLkr: MONTHLY_LKR,
  };
}

function nextDcaDate() {
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), DCA_DAY));
  if (d <= now) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, DCA_DAY));
  return d.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// Module B: Mayer-scaled allocation + ladders
// ----------------------------------------------------------------------------
function allocationPlan() {
  const base = MONTHLY_LKR / COINS.length;
  let reserveDivert = 0;
  const perCoin = COINS.map((sym) => {
    const c = MARKET.coins[sym] || {};
    const band = c.band || mayerBand(c.mayer);
    const suggested = Math.round(base * band.multiplier);
    if (band.multiplier < 1) reserveDivert += base - suggested;
    return {
      symbol: sym,
      mayer: c.mayer ?? null,
      band: band.label,
      multiplier: band.multiplier,
      baseLkr: Math.round(base),
      suggestedLkr: suggested,
      ladderUsd: c.ladderUsd || [],
      ladderLkr: c.ladderLkr || [],
    };
  });
  const totalSuggested = perCoin.reduce((a, c) => a + c.suggestedLkr, 0);
  return { monthlyBudgetLkr: MONTHLY_LKR, perCoin, reserveDivertLkr: Math.round(reserveDivert), totalSuggestedLkr: totalSuggested };
}

// ----------------------------------------------------------------------------
// Module C: Dollar-cost selling / take-profit
// ----------------------------------------------------------------------------
function dcsTargets(holdings) {
  const fx = MARKET.fx;
  return holdings
    .filter((h) => !h.isReserve && h.units > 0 && h.vwapUsd > 0)
    .map((h) => {
      const priceUsd = h.priceLkr != null ? h.priceLkr / fx : null;
      const multiple = priceUsd && h.vwapUsd ? priceUsd / h.vwapUsd : null;
      const targets = [2, 3, 5].map((x) => ({
        multiple: x,
        priceUsd: round(h.vwapUsd * x, 4),
        priceLkr: round(h.vwapLkr * x, 2),
        hit: multiple != null && multiple >= x,
      }));
      let suggestion = "HOLD — below first take-profit target.";
      if (multiple != null) {
        if (multiple >= 5) suggestion = `Trim ~25% of ${h.symbol}: 5x reached, lock major gains.`;
        else if (multiple >= 3) suggestion = `Sell ~20% of ${h.symbol}: 3x reached.`;
        else if (multiple >= 2) suggestion = `Sell ~15% of ${h.symbol} to recover initial LKR capital.`;
      }
      return { symbol: h.symbol, currentMultiple: round(multiple, 2), targets, suggestion };
    });
}

// ----------------------------------------------------------------------------
// Projection: DCA vs lump sum (historical) + 3-year scenario bands
// ----------------------------------------------------------------------------
function dcaVsLump() {
  // Equal-weight the tracked coins over the last ~12 months of daily closes.
  const series = COINS.map((s) => MARKET.closes[s]).filter((c) => c && c.length >= 30);
  if (series.length === 0) return { labels: [], dca: [], lump: [] };
  const len = Math.min(...series.map((c) => c.length));
  const days = Math.min(len, 365);
  // index basket = average of normalized coin prices.
  const basket = [];
  for (let i = len - days; i < len; i++) {
    let sum = 0;
    for (const c of series) sum += c[i] / c[len - days];
    basket.push(sum / series.length);
  }
  const months = Math.floor(days / 30);
  const labels = [];
  const dca = [];
  const lump = [];
  const lumpTotal = MONTHLY_LKR * months;
  const lumpUnits = lumpTotal / basket[0];
  let dcaUnits = 0;
  let dcaInvested = 0;
  for (let m = 0; m < months; m++) {
    const idx = Math.min(m * 30, basket.length - 1);
    const price = basket[idx];
    dcaUnits += MONTHLY_LKR / price;
    dcaInvested += MONTHLY_LKR;
    labels.push(`M${m + 1}`);
    dca.push(round(dcaUnits * price, 0));
    lump.push(round(lumpUnits * price, 0));
  }
  return { labels, dca, lump, investedFinal: dcaInvested };
}

function projectionBands(currentValueLkr) {
  // Monthly return stats from blended daily returns of tracked coins.
  const rets = [];
  for (const s of COINS) {
    const c = MARKET.closes[s];
    if (!c || c.length < 30) continue;
    for (let i = 1; i < c.length; i++) if (c[i - 1] > 0) rets.push(c[i] / c[i - 1] - 1);
  }
  let mMean = 0.02;
  let mSigma = 0.18;
  if (rets.length > 30) {
    const dMean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const dVar = rets.reduce((a, b) => a + (b - dMean) ** 2, 0) / rets.length;
    mMean = dMean * 30;
    mSigma = Math.sqrt(dVar) * Math.sqrt(30);
  }
  const scenarios = {
    bear: mMean - mSigma,
    base: mMean,
    bull: mMean + mSigma,
  };
  const labels = [];
  const out = { bear: [], base: [], bull: [] };
  const start = currentValueLkr || 0;
  for (const key of Object.keys(scenarios)) {
    let v = start;
    const r = Math.max(-0.4, Math.min(0.5, scenarios[key]));
    for (let m = 1; m <= 36; m++) {
      v = v * (1 + r) + MONTHLY_LKR;
      out[key].push(round(v, 0));
    }
  }
  for (let m = 1; m <= 36; m++) labels.push(`M${m}`);
  return { labels, ...out, assumptions: { monthlyMean: round(mMean, 4), monthlySigma: round(mSigma, 4) } };
}

// ----------------------------------------------------------------------------
// Module D: Gemini analyst (+ rule-based fallback), stored in ai_reports
// ----------------------------------------------------------------------------
function buildAnalystContext(portfolio, onchain, news) {
  return {
    portfolio: portfolio.holdings.map((h) => ({
      symbol: h.symbol,
      units: h.units,
      valueLkr: h.valueLkr,
      unrealizedPct: h.unrealizedPct,
    })),
    totals: portfolio.totals,
    fearGreed: MARKET.fearGreed,
    indicators: COINS.map((s) => {
      const c = MARKET.coins[s] || {};
      return { symbol: s, price: c.spotUsd, sma200: c.sma200, mayer: c.mayer, rsi14: c.rsi14, change24h: c.change24h };
    }),
    onchain,
    news: (news || []).slice(0, 6).map((n) => n.title),
    monthlyBudgetLkr: MONTHLY_LKR,
  };
}

function ruleBasedAnalyst(ctx) {
  const fg = ctx.fearGreed.value;
  const risk = fg == null ? "MODERATE" : fg < 25 ? "LOW" : fg < 55 ? "MODERATE" : fg < 80 ? "HIGH" : "EXTREME";
  const base = MONTHLY_LKR / COINS.length;
  const allocations = ctx.indicators.map((ind) => {
    const band = mayerBand(ind.mayer);
    const suggested = Math.round(base * band.multiplier);
    let action = "HOLD";
    if (ind.mayer != null && ind.mayer < 0.8) action = "STRONG_BUY";
    else if (ind.mayer != null && ind.mayer <= 1.4) action = "ACCUMULATE";
    else if (ind.mayer != null && ind.mayer > 2.0) action = "TAKE_PROFIT";
    const ladder = (MARKET.coins[ind.symbol] || {}).ladderUsd || [];
    return {
      symbol: ind.symbol,
      suggested_lkr: suggested,
      action,
      ladder_entry_prices_usd: ladder,
      reasoning: `Mayer ${ind.mayer ?? "n/a"} (${band.label}), RSI ${ind.rsi14 ?? "n/a"}, 24h ${ind.change24h ?? "n/a"}%.`,
    };
  });
  return {
    market_summary: `Fear & Greed at ${fg ?? "n/a"} (${ctx.fearGreed.classification}). Allocation scaled by each coin's Mayer Multiple around the ${MONTHLY_LKR} LKR monthly budget.`,
    fear_greed_score: fg ?? 0,
    risk_level: risk,
    allocations,
    onchain_health:
      ctx.onchain && ctx.onchain.growth7d != null
        ? `Total DeFi TVL ${(ctx.onchain.totalTvl / 1e9).toFixed(1)}B, 7d ${ctx.onchain.growth7d.toFixed(1)}%.`
        : "On-chain TVL data unavailable.",
    macro_risks: ["Regulatory headlines", "USD liquidity / rate shifts", "Exchange & stablecoin risk"],
  };
}

async function runAnalyst(force) {
  const [portfolio, onchain, news] = await Promise.all([computePortfolio(), getOnchain(), getNews()]);
  const ctx = buildAnalystContext(portfolio, onchain, news);
  let report = null;
  let source = "rule-based";

  if (process.env.GEMINI_API_KEY && (force || true)) {
    try {
      report = await geminiAnalyst(ctx);
      source = "gemini";
    } catch (e) {
      console.warn("[analyst] gemini failed, using fallback:", e.message);
    }
  }
  if (!report) report = ruleBasedAnalyst(ctx);

  const snapshot = { prices: MARKET.coins, fx: MARKET.fx, fearGreed: MARKET.fearGreed, at: MARKET.updatedAt };
  await db
    .query("INSERT INTO ai_reports (report_json, snapshot_json, source) VALUES ($1,$2,$3)", [
      JSON.stringify(report),
      JSON.stringify(snapshot),
      source,
    ])
    .catch((e) => console.warn("[analyst] store failed:", e.message));
  return { report, source };
}

async function geminiAnalyst(ctx) {
  const { GoogleGenAI, Type } = require("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      market_summary: { type: Type.STRING },
      fear_greed_score: { type: Type.NUMBER },
      risk_level: { type: Type.STRING },
      allocations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            symbol: { type: Type.STRING },
            suggested_lkr: { type: Type.NUMBER },
            action: { type: Type.STRING },
            ladder_entry_prices_usd: { type: Type.ARRAY, items: { type: Type.NUMBER } },
            reasoning: { type: Type.STRING },
          },
          required: ["symbol", "suggested_lkr", "action", "reasoning"],
        },
      },
      onchain_health: { type: Type.STRING },
      macro_risks: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ["market_summary", "fear_greed_score", "risk_level", "allocations", "onchain_health", "macro_risks"],
  };
  const prompt =
    `You are a disciplined crypto DCA portfolio analyst. The user invests ${MONTHLY_LKR} LKR per month split across BTC, ETH, SOL, BNB. ` +
    `Using the data below, return allocations whose suggested_lkr sums to about ${MONTHLY_LKR}. Be risk-aware; prefer accumulation when Mayer<1 and caution when Mayer>2.\n\n` +
    JSON.stringify(ctx);
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema },
  });
  const text = typeof resp.text === "string" ? resp.text : resp.text && resp.text();
  return JSON.parse(text);
}

// ----------------------------------------------------------------------------
// Transactions: logging a buy/sell (auto-prices when price omitted)
// ----------------------------------------------------------------------------
async function logTransaction({ symbol, side = "BUY", amount_lkr, price_lkr, units, fee_lkr = 0, note = null }) {
  symbol = String(symbol || "").toUpperCase();
  if (![...COINS, ...RESERVE].includes(symbol)) throw new Error(`Unsupported symbol: ${symbol}`);
  side = side === "SELL" ? "SELL" : "BUY";
  const fx = await getUsdLkr();

  let priceLkr = price_lkr != null ? Number(price_lkr) : priceLkrFor(symbol, fx);
  if (priceLkr == null) {
    const spot = await getSpotUsd(symbol);
    priceLkr = spot != null ? spot * fx : null;
  }
  if (priceLkr == null || priceLkr <= 0) throw new Error(`No price available for ${symbol}`);

  let amt = amount_lkr != null ? Number(amount_lkr) : null;
  let u = units != null ? Number(units) : null;
  if (u == null && amt != null) u = amt / priceLkr;
  else if (amt == null && u != null) amt = u * priceLkr;
  if (amt == null || u == null) throw new Error("Provide amount_lkr or units");

  const { rows } = await db.query(
    `INSERT INTO transactions (symbol, side, amount_lkr, units, price_lkr, fee_lkr, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [symbol, side, amt, u, priceLkr, fee_lkr, note],
  );
  return rows[0];
}

// ----------------------------------------------------------------------------
// Express app
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error("[api]", e);
  res.status(500).json({ error: e.message });
});

app.get("/api/health", (_req, res) => res.json({ status: "ok", market: MARKET.updatedAt }));

app.get("/api/config", (_req, res) =>
  res.json({ coins: COINS, reserve: RESERVE, monthlyBudgetLkr: MONTHLY_LKR, dcaDay: DCA_DAY, nextDcaDate: nextDcaDate() }),
);

app.post("/api/refresh", wrap(async (_req, res) => {
  await refreshMarket();
  res.json({ ok: true, updatedAt: MARKET.updatedAt });
}));

app.get("/api/market", wrap(async (_req, res) => {
  res.json({
    fx: MARKET.fx,
    updatedAt: MARKET.updatedAt,
    fearGreed: MARKET.fearGreed,
    coins: MARKET.coins,
    allocation: allocationPlan(),
  });
}));

app.get("/api/portfolio", wrap(async (_req, res) => {
  const p = await computePortfolio();
  p.dcs = dcsTargets(p.holdings);
  res.json(p);
}));

app.get("/api/transactions", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM transactions ORDER BY created_at DESC");
  res.json({ transactions: rows });
}));

app.post("/api/transactions", wrap(async (req, res) => {
  const tx = await logTransaction(req.body || {});
  res.status(201).json({ transaction: tx });
}));

app.put("/api/transactions/:id", wrap(async (req, res) => {
  const { symbol, side, amount_lkr, units, price_lkr, fee_lkr, note } = req.body || {};
  const { rows } = await db.query(
    `UPDATE transactions SET
       symbol=COALESCE($2,symbol), side=COALESCE($3,side), amount_lkr=COALESCE($4,amount_lkr),
       units=COALESCE($5,units), price_lkr=COALESCE($6,price_lkr), fee_lkr=COALESCE($7,fee_lkr), note=COALESCE($8,note)
     WHERE id=$1 RETURNING *`,
    [req.params.id, symbol ? symbol.toUpperCase() : null, side, amount_lkr, units, price_lkr, fee_lkr, note],
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json({ transaction: rows[0] });
}));

app.delete("/api/transactions/:id", wrap(async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM transactions WHERE id=$1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));

// Bulk import (JSON array or CSV text) and export.
app.post("/api/import", wrap(async (req, res) => {
  const { format = "json", data } = req.body || {};
  let records = [];
  if (format === "csv" && typeof data === "string") {
    const lines = data.trim().split(/\r?\n/);
    const header = lines.shift().split(",").map((h) => h.trim());
    records = lines.filter(Boolean).map((line) => {
      const cells = line.split(",");
      const obj = {};
      header.forEach((h, i) => (obj[h] = cells[i] != null ? cells[i].trim() : undefined));
      return obj;
    });
  } else if (Array.isArray(data)) {
    records = data;
  } else {
    throw new Error("Provide data as a JSON array or CSV string");
  }
  let imported = 0;
  for (const r of records) {
    try {
      await logTransaction({
        symbol: r.symbol,
        side: r.side || "BUY",
        amount_lkr: r.amount_lkr,
        units: r.units,
        price_lkr: r.price_lkr,
        fee_lkr: r.fee_lkr || 0,
        note: r.note || "import",
      });
      imported++;
    } catch (e) {
      console.warn("[import] skipped row:", e.message);
    }
  }
  res.json({ imported, total: records.length });
}));

app.get("/api/export", wrap(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM transactions ORDER BY created_at ASC");
  if (req.query.format === "csv") {
    const header = "id,symbol,side,amount_lkr,units,price_lkr,fee_lkr,note,created_at";
    const body = rows
      .map((r) => [r.id, r.symbol, r.side, r.amount_lkr, r.units, r.price_lkr, r.fee_lkr, JSON.stringify(r.note || ""), r.created_at.toISOString()].join(","))
      .join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=transactions.csv");
    return res.send(`${header}\n${body}`);
  }
  res.setHeader("Content-Disposition", "attachment; filename=transactions.json");
  res.json({ transactions: rows });
}));

app.get("/api/projection", wrap(async (_req, res) => {
  const p = await computePortfolio();
  res.json({ dcaVsLump: dcaVsLump(), bands: projectionBands(p.totals.valueLkr) });
}));

app.get("/api/sentiment", wrap(async (_req, res) => res.json(MARKET.fearGreed)));
app.get("/api/news", wrap(async (_req, res) => res.json({ items: await getNews() })));
app.get("/api/onchain", wrap(async (_req, res) => res.json(await getOnchain())));

app.get("/api/analyst", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM ai_reports ORDER BY created_at DESC LIMIT 1");
  if (!rows.length) return res.json({ report: null });
  res.json({ report: rows[0].report_json, source: rows[0].source, created_at: rows[0].created_at });
}));

app.post("/api/analyst", wrap(async (_req, res) => res.json(await runAnalyst(true))));

app.get("/api/analyst/history", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT id, report_json, source, created_at FROM ai_reports ORDER BY created_at DESC LIMIT 20");
  res.json({ reports: rows });
}));

// SPA fallback to the dashboard.
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ----------------------------------------------------------------------------
// Module E: Telegram bot (optional)
// ----------------------------------------------------------------------------
let bot = null;
function startTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }
  try {
    const TelegramBot = require("node-telegram-bot-api");
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

    bot.onText(/\/start/, (msg) =>
      bot.sendMessage(
        msg.chat.id,
        "🤖 *Crypto DCA Engine*\n/portfolio – holdings & P&L\n/buy <symbol> <lkr> – log a buy\n/analyst – AI allocation\n",
        { parse_mode: "Markdown" },
      ),
    );

    bot.onText(/\/portfolio/, async (msg) => {
      try {
        const p = await computePortfolio();
        const lines = p.holdings.map(
          (h) => `${h.symbol}: ${h.units} • ${fmtLkr(h.valueLkr)} (${h.unrealizedPct >= 0 ? "+" : ""}${h.unrealizedPct}%)`,
        );
        await bot.sendMessage(
          msg.chat.id,
          `📊 *Portfolio*\n${lines.join("\n")}\n\nValue: ${fmtLkr(p.totals.valueLkr)}\nInvested: ${fmtLkr(p.totals.investedLkr)}\nNet P&L: ${p.totals.netProfitPct}%\nReserve: ${fmtLkr(p.totals.reserveLkr)}`,
          { parse_mode: "Markdown" },
        );
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ ${e.message}`);
      }
    });

    bot.onText(/\/buy\s+(\w+)\s+([\d.]+)/i, async (msg, match) => {
      try {
        const tx = await logTransaction({ symbol: match[1], amount_lkr: Number(match[2]), note: "telegram" });
        await bot.sendMessage(
          msg.chat.id,
          `✅ Bought ${Number(tx.units).toFixed(6)} ${tx.symbol} @ ${fmtLkr(Number(tx.price_lkr))}`,
        );
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ ${e.message}`);
      }
    });

    bot.onText(/\/analyst/, async (msg) => {
      try {
        await bot.sendMessage(msg.chat.id, "🧠 Analysing…");
        const { report, source } = await runAnalyst(true);
        const allocs = report.allocations.map((a) => `${a.symbol}: ${a.action} ${fmtLkr(a.suggested_lkr)}`).join("\n");
        await bot.sendMessage(
          msg.chat.id,
          `🧠 *Analyst* (${source})\n${report.market_summary}\nRisk: ${report.risk_level}\n\n${allocs}`,
          { parse_mode: "Markdown" },
        );
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ ${e.message}`);
      }
    });

    bot.on("polling_error", (e) => console.warn("[telegram] polling:", e.message));
    console.log("[telegram] bot started (polling)");
  } catch (e) {
    console.warn("[telegram] failed to start:", e.message);
  }
}

function fmtLkr(n) {
  return `LKR ${Number(n || 0).toLocaleString("en-LK", { maximumFractionDigits: 0 })}`;
}

async function dipAlert() {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) return;
  for (const sym of COINS) {
    const c = MARKET.coins[sym];
    if (c && c.change24h != null && c.change24h <= -5) {
      const ladder = (c.ladderLkr || []).map((p) => fmtLkr(p)).join(" / ");
      await bot
        .sendMessage(
          process.env.TELEGRAM_CHAT_ID,
          `🔻 *Dip Alert* ${sym} ${c.change24h}% (24h)\nSpot: ${fmtLkr(c.priceLkr)}\nLadder buys: ${ladder}`,
          { parse_mode: "Markdown" },
        )
        .catch((e) => console.warn("[dip] send failed:", e.message));
    }
  }
}

// ----------------------------------------------------------------------------
// Cron jobs
// ----------------------------------------------------------------------------
function startCron() {
  cron.schedule("*/30 * * * *", () => refreshMarket().catch((e) => console.warn("[cron market]", e.message)));
  cron.schedule("0 */6 * * *", () => dipAlert().catch((e) => console.warn("[cron dip]", e.message)));
  console.log("[cron] scheduled market refresh (30m) + dip alerts (6h)");
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
async function boot() {
  try {
    await initDb();
  } catch (e) {
    console.error("[db] init failed (continuing, API will degrade):", e.message);
  }
  // Warm the market snapshot (best-effort) before serving.
  await refreshMarket().catch((e) => console.warn("[boot] market warm failed:", e.message));

  app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
  startTelegram();
  startCron();
}

boot();

module.exports = app;
