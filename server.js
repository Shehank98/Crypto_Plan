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
const AUTO_DCA = (process.env.AUTO_DCA ?? "true") !== "false";
const HISTORY_YEARS = Number(process.env.HISTORY_YEARS || 5); // long-run backtest window
const PROJECTION_YEARS = Number(process.env.PROJECTION_YEARS || 3); // forward projection horizon
// Coins are configurable: set COINS="BTC,ETH,SOL,BNB,ADA,..." (comma-separated symbols).
const DEFAULT_COINS = ["BTC", "ETH", "SOL", "BNB"];
const COINS = (process.env.COINS ? process.env.COINS.split(",") : DEFAULT_COINS)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const RESERVE = ["USDT", "USDC"];
const ALL_SYMBOLS = [...COINS, "USDT"];
// Symbol -> CoinGecko id (for the keyless fallback). Extend via COIN_IDS env
// (JSON), e.g. COIN_IDS='{"FOO":"foo-token"}'. Binance (SYMUSDT) is primary and
// works for any listed symbol regardless of this map.
const CG_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  USDT: "tether", USDC: "usd-coin", ADA: "cardano", XRP: "ripple",
  DOGE: "dogecoin", DOT: "polkadot", AVAX: "avalanche-2", LINK: "chainlink",
  MATIC: "matic-network", POL: "polygon-ecosystem-token", LTC: "litecoin",
  TRX: "tron", ATOM: "cosmos", UNI: "uniswap", ARB: "arbitrum", OP: "optimism",
  APT: "aptos", NEAR: "near", FIL: "filecoin", ICP: "internet-computer",
  ETC: "ethereum-classic", XLM: "stellar", ALGO: "algorand", VET: "vechain",
  HBAR: "hedera-hashgraph", SUI: "sui", SEI: "sei-network", TIA: "celestia",
  INJ: "injective-protocol", RNDR: "render-token", SHIB: "shiba-inu", PEPE: "pepe",
};
try {
  if (process.env.COIN_IDS) Object.assign(CG_IDS, JSON.parse(process.env.COIN_IDS));
} catch (e) {
  console.warn("[config] COIN_IDS parse failed:", e.message);
}
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

// --- Professional decision-support: extra indicators & a composite score ---
function stddev(values) {
  if (!values || values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
}
function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < (closes || []).length; i++) if (closes[i - 1] > 0) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}
function emaArray(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, sig = 9) {
  if (!closes || closes.length < slow + sig) return null;
  const ef = emaArray(closes, fast);
  const es = emaArray(closes, slow);
  const line = [];
  for (let i = 0; i < closes.length; i++) if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]);
  const signal = emaArray(line, sig);
  const macdVal = line[line.length - 1];
  const sigVal = signal[signal.length - 1];
  if (macdVal == null || sigVal == null) return null;
  return { macd: macdVal, signal: sigVal, hist: macdVal - sigVal };
}
function bollinger(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = stddev(slice);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const price = closes[closes.length - 1];
  const pctB = upper > lower ? (price - lower) / (upper - lower) : 0.5;
  return { upper, lower, mid, pctB };
}
function annualizedVol(closes) {
  const r = dailyReturns(closes);
  const sd = stddev(r);
  return sd == null ? null : sd * Math.sqrt(365);
}
function maxDrawdown(equity) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

// --- Scalping indicators: ATR, VWAP, MFI (volume-weighted) ---
function atr(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return sma(tr, period);
}
function vwap(highs, lows, closes, volumes) {
  let pv = 0;
  let v = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    pv += tp * (volumes[i] || 0);
    v += volumes[i] || 0;
  }
  return v ? pv / v : null;
}
function mfi(highs, lows, closes, volumes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let pos = 0;
  let neg = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const ptp = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
    const mf = tp * (volumes[i] || 0);
    if (tp > ptp) pos += mf;
    else if (tp < ptp) neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

/**
 * Composite 0–100 "accumulation attractiveness" score blending valuation
 * (Mayer), momentum (RSI, MACD), mean-reversion (Bollinger %B) and trend
 * (vs 200 SMA). Transparent, rules-based — surfaced and fed to the AI analyst.
 */
function compositeSignal({ mayer, rsi14, pctB, macdHist, price, sma200 }) {
  const scoreMayer = mayer == null ? 50 : mayer < 0.8 ? 100 : mayer < 1.0 ? 82 : mayer <= 1.4 ? 58 : mayer <= 2.0 ? 30 : 10;
  const scoreRsi = rsi14 == null ? 50 : rsi14 < 30 ? 90 : rsi14 < 45 ? 70 : rsi14 <= 55 ? 50 : rsi14 <= 70 ? 33 : 15;
  const scoreB = pctB == null ? 50 : pctB < 0 ? 95 : pctB < 0.2 ? 85 : pctB < 0.5 ? 60 : pctB < 0.8 ? 40 : 20;
  const scoreMacd = macdHist == null ? 50 : macdHist > 0 ? 62 : 42;
  const scoreTrend = price == null || sma200 == null ? 50 : price < sma200 ? 68 : 45;
  const weights = { scoreMayer: 0.34, scoreB: 0.22, scoreRsi: 0.2, scoreTrend: 0.14, scoreMacd: 0.1 };
  const parts = { scoreMayer, scoreB, scoreRsi, scoreTrend, scoreMacd };
  let score = 0;
  for (const k of Object.keys(weights)) score += parts[k] * weights[k];
  score = Math.round(score);
  const label = score >= 75 ? "STRONG_ACCUMULATE" : score >= 60 ? "ACCUMULATE" : score >= 45 ? "NEUTRAL" : score >= 30 ? "REDUCE" : "TAKE_PROFIT";
  return { score, label, components: parts };
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
  // Try several free, keyless sources in order — Binance is geo-blocked in some
  // hosting regions (HTTP 451), so Coinbase/CoinGecko keep prices flowing.
  // 1) Binance
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/ticker/price", { params: { symbol: binancePair(symbol) } });
    const p = Number(data.price);
    if (p > 0) return p;
  } catch (e) {
    /* try next */
  }
  // 2) Coinbase (global, keyless)
  try {
    const { data } = await http.get(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`);
    const p = Number(data.data.amount);
    if (p > 0) return p;
  } catch (e) {
    /* try next */
  }
  // 3) CoinGecko
  try {
    const { data } = await http.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: CG_IDS[symbol], vs_currencies: "usd" } });
    const p = Number(data[CG_IDS[symbol]] && data[CG_IDS[symbol]].usd);
    if (p > 0) return p;
  } catch (e) {
    /* give up below */
  }
  console.warn(`[price] ${symbol} spot: all sources failed`);
  return null;
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

// Monthly closes for multi-year history. Binance 1M klines (up to ~decades),
// CoinGecko daily->monthly fallback. Returns [{ ym: "YYYY-MM", close }].
async function getMonthlyCloses(symbol, months) {
  if (RESERVE.includes(symbol)) return [];
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/klines", {
      params: { symbol: binancePair(symbol), interval: "1M", limit: Math.min(1000, months + 2) },
    });
    return data.map((k) => ({ ym: new Date(k[0]).toISOString().slice(0, 7), close: Number(k[4]) }));
  } catch (e) {
    try {
      const { data } = await http.get(
        `https://api.coingecko.com/api/v3/coins/${CG_IDS[symbol]}/market_chart`,
        { params: { vs_currency: "usd", days: "max", interval: "daily" } },
      );
      const byMonth = new Map();
      for (const [ms, price] of data.prices) byMonth.set(new Date(ms).toISOString().slice(0, 7), Number(price));
      return [...byMonth.entries()].map(([ym, close]) => ({ ym, close }));
    } catch (e2) {
      console.warn(`[monthly] ${symbol} failed:`, e2.message);
      return [];
    }
  }
}

// Intraday OHLCV for scalping signals. Binance -> Coinbase fallback.
const TF_BINANCE = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h" };
const TF_COINBASE = { "5m": 300, "15m": 900, "1h": 3600 };
const TF_MINUTES = { "5m": 5, "15m": 15, "1h": 60, "4h": 240 };

async function getOHLCV(symbol, interval, limit = 200) {
  if (RESERVE.includes(symbol)) return null;
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/klines", {
      params: { symbol: binancePair(symbol), interval: TF_BINANCE[interval] || "1h", limit },
    });
    return {
      highs: data.map((k) => Number(k[2])),
      lows: data.map((k) => Number(k[3])),
      closes: data.map((k) => Number(k[4])),
      volumes: data.map((k) => Number(k[5])),
    };
  } catch (e) {
    const g = TF_COINBASE[interval];
    if (g) {
      try {
        const { data } = await http.get(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles`, {
          params: { granularity: g },
        });
        const rows = [...data].reverse(); // Coinbase returns newest-first: [time, low, high, open, close, volume]
        return {
          highs: rows.map((r) => Number(r[2])),
          lows: rows.map((r) => Number(r[1])),
          closes: rows.map((r) => Number(r[4])),
          volumes: rows.map((r) => Number(r[5])),
        };
      } catch (e2) {
        /* fall through */
      }
    }
    console.warn(`[ohlcv] ${symbol} ${interval} failed`);
    return null;
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
const MARKET = { fx: fxCache.rate, updatedAt: null, coins: {}, fearGreed: { value: null }, closes: {}, monthly: {} };
let monthlyFetchedAt = 0;

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
      const macdV = macd(closes);
      const boll = bollinger(closes);
      const vol = annualizedVol(closes);
      const signal = compositeSignal({
        mayer,
        rsi14,
        pctB: boll ? boll.pctB : null,
        macdHist: macdV ? macdV.hist : null,
        price: spot,
        sma200,
      });
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
        macd: macdV ? { macd: round(macdV.macd, 4), signal: round(macdV.signal, 4), hist: round(macdV.hist, 4) } : null,
        bollingerPctB: boll ? round(boll.pctB, 3) : null,
        volatilityAnnPct: vol != null ? round(vol * 100, 1) : null,
        band: mayerBand(mayer),
        signal,
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
  // Monthly multi-year history changes slowly — refresh at most every 12h.
  if (Date.now() - monthlyFetchedAt > 12 * 3600_000) {
    for (const sym of COINS) {
      try {
        const m = await getMonthlyCloses(sym, HISTORY_YEARS * 12);
        if (m.length) MARKET.monthly[sym] = m;
      } catch (e) {
        console.warn(`[monthly] ${sym}:`, e.message);
      }
    }
    monthlyFetchedAt = Date.now();
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
// Projection & history — month/year-wise over a multi-year window.
// Uses monthly closes (Binance 1M) so labels are real YYYY-MM dates. Historical
// values are approximated in LKR at the current fx (no historical fx feed).
// ----------------------------------------------------------------------------
function alignedMonthly() {
  // month -> { SYM: close } across all coins, keeping only fully-covered months.
  const per = {};
  for (const s of COINS) {
    for (const { ym, close } of MARKET.monthly[s] || []) {
      (per[ym] = per[ym] || {})[s] = close;
    }
  }
  const months = Object.keys(per)
    .sort()
    .filter((m) => COINS.every((s) => per[m][s] != null && per[m][s] > 0));
  return { per, months };
}

/** Historical DCA vs lump backtest, one point per month with a real date. */
function historyBacktest(years) {
  const fx = MARKET.fx;
  const { per, months: all } = alignedMonthly();
  const months = all.slice(-(years * 12));
  if (months.length < 3) return { labels: [], series: [], summary: null };

  const usdMonthly = MONTHLY_LKR / fx; // approximate LKR budget in USD
  const usdPerCoin = usdMonthly / COINS.length;
  const unitsDca = Object.fromEntries(COINS.map((s) => [s, 0]));
  // Lump: deploy the full multi-year budget at the first month.
  const totalUsd = usdMonthly * months.length;
  const unitsLump = Object.fromEntries(COINS.map((s) => [s, totalUsd / COINS.length / per[months[0]][s]]));

  let invested = 0;
  const series = months.map((m) => {
    for (const s of COINS) unitsDca[s] += usdPerCoin / per[m][s];
    invested += MONTHLY_LKR;
    const dcaUsd = COINS.reduce((a, s) => a + unitsDca[s] * per[m][s], 0);
    const lumpUsd = COINS.reduce((a, s) => a + unitsLump[s] * per[m][s], 0);
    return {
      date: m,
      invested: Math.round(invested),
      dcaValue: Math.round(dcaUsd * fx),
      lumpValue: Math.round(lumpUsd * fx),
    };
  });
  const last = series[series.length - 1];
  const summary = {
    months: series.length,
    investedLkr: last.invested,
    dcaValueLkr: last.dcaValue,
    lumpValueLkr: last.lumpValue,
    dcaRoiPct: round(((last.dcaValue - last.invested) / last.invested) * 100, 1),
    lumpRoiPct: round(((last.lumpValue - last.invested) / last.invested) * 100, 1),
  };
  return { labels: series.map((x) => x.date), series, summary };
}

function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Forward projection, month/year-wise, from monthly-return statistics. */
function forwardProjection(years, startValueLkr) {
  const rets = [];
  for (const s of COINS) {
    const arr = (MARKET.monthly[s] || []).map((x) => x.close);
    for (let i = 1; i < arr.length; i++) if (arr[i - 1] > 0) rets.push(arr[i] / arr[i - 1] - 1);
  }
  let mean = 0.02;
  let sigma = 0.2;
  if (rets.length > 12) {
    mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    sigma = Math.sqrt(v);
  }
  const nowYm = new Date().toISOString().slice(0, 7);
  const scenarios = { bear: mean - sigma, base: mean, bull: mean + sigma };
  const labels = [];
  const out = { bear: [], base: [], bull: [] };
  const totalMonths = years * 12;
  for (let m = 1; m <= totalMonths; m++) labels.push(addMonths(nowYm, m));
  for (const key of Object.keys(scenarios)) {
    let v = startValueLkr || 0;
    const r = Math.max(-0.35, Math.min(0.45, scenarios[key]));
    let invested = startValueLkr || 0;
    for (let m = 1; m <= totalMonths; m++) {
      v = v * (1 + r) + MONTHLY_LKR;
      invested += MONTHLY_LKR;
      out[key].push(Math.round(v));
    }
  }
  const invLine = [];
  let inv = startValueLkr || 0;
  for (let m = 1; m <= totalMonths; m++) {
    inv += MONTHLY_LKR;
    invLine.push(Math.round(inv));
  }
  return {
    labels,
    ...out,
    invested: invLine,
    assumptions: { monthlyMeanPct: round(mean * 100, 2), monthlySigmaPct: round(sigma * 100, 2), years, dataMonths: rets.length + 1 },
  };
}

// ----------------------------------------------------------------------------
// Professional analytics: portfolio risk, correlation, risk-parity targets,
// rebalancing, DCA discount.
// ----------------------------------------------------------------------------
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

function portfolioAnalytics(portfolio) {
  const held = portfolio.holdings.filter((h) => !h.isReserve && h.valueLkr > 0);
  const returnsBySym = {};
  for (const s of COINS) {
    const r = dailyReturns(MARKET.closes[s]);
    if (r.length > 20) returnsBySym[s] = r;
  }
  const symbols = Object.keys(returnsBySym);

  // Correlation matrix across all coins with data.
  const correlation = { symbols, matrix: symbols.map((a) => symbols.map((b) => round(pearson(returnsBySym[a], returnsBySym[b]), 2))) };

  // Value-weighted blended portfolio returns (held coins only).
  const totalVal = held.reduce((s, h) => s + h.valueLkr, 0);
  let risk = null;
  if (held.length && totalVal > 0) {
    const heldSyms = held.filter((h) => returnsBySym[h.symbol]).map((h) => h.symbol);
    if (heldSyms.length) {
      const n = Math.min(...heldSyms.map((s) => returnsBySym[s].length));
      const blended = [];
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (const h of held) {
          if (!returnsBySym[h.symbol]) continue;
          const w = h.valueLkr / totalVal;
          r += w * returnsBySym[h.symbol][returnsBySym[h.symbol].length - n + i];
        }
        blended.push(r);
      }
      const mean = blended.reduce((s, v) => s + v, 0) / blended.length;
      const sd = stddev(blended);
      const downside = stddev(blended.filter((v) => v < 0)) || 0;
      const annReturn = mean * 365;
      const annVol = sd * Math.sqrt(365);
      let eq = 1;
      const curve = blended.map((r) => (eq *= 1 + r));
      risk = {
        annualizedReturnPct: round(annReturn * 100, 1),
        annualizedVolPct: round(annVol * 100, 1),
        sharpe: annVol ? round(annReturn / annVol, 2) : null,
        sortino: downside ? round(annReturn / (downside * Math.sqrt(365)), 2) : null,
        maxDrawdownPct: round(maxDrawdown(curve) * 100, 1),
        windowDays: blended.length,
      };
    }
  }

  // Inverse-volatility (risk-parity) target weights across all coins.
  const vols = {};
  for (const s of COINS) {
    const v = annualizedVol(MARKET.closes[s]);
    if (v && v > 0) vols[s] = v;
  }
  const invSum = Object.values(vols).reduce((s, v) => s + 1 / v, 0);
  const targets = {};
  for (const s of Object.keys(vols)) targets[s] = round((1 / vols[s] / invSum) * 100, 1);

  // Rebalance suggestion vs current value weights.
  const rebalance = held.map((h) => {
    const targetPct = targets[h.symbol] ?? null;
    const curPct = totalVal > 0 ? (h.valueLkr / totalVal) * 100 : 0;
    const targetVal = targetPct != null ? (targetPct / 100) * totalVal : null;
    const deltaLkr = targetVal != null ? targetVal - h.valueLkr : null;
    return {
      symbol: h.symbol,
      currentPct: round(curPct, 1),
      targetPct,
      action: deltaLkr == null ? "—" : deltaLkr > totalVal * 0.03 ? "BUY" : deltaLkr < -totalVal * 0.03 ? "TRIM" : "HOLD",
      deltaLkr: round(deltaLkr, 0),
    };
  });

  // DCA discount: current price vs VWAP (negative = you're buying below cost).
  const dcaDiscount = held.map((h) => ({
    symbol: h.symbol,
    vwapLkr: h.vwapLkr,
    priceLkr: h.priceLkr,
    discountPct: h.priceLkr != null && h.vwapLkr > 0 ? round(((h.priceLkr - h.vwapLkr) / h.vwapLkr) * 100, 2) : null,
  }));

  return { risk, correlation, targetWeights: targets, rebalance, dcaDiscount };
}

// ----------------------------------------------------------------------------
// Analyst accuracy: score each stored report against subsequent price moves.
// ----------------------------------------------------------------------------
function scoreAction(action, changePct) {
  const a = String(action || "").toUpperCase();
  if (changePct == null) return null;
  if (["STRONG_BUY", "ACCUMULATE", "STRONG_ACCUMULATE", "BUY"].includes(a)) return changePct > 0;
  if (["TAKE_PROFIT", "REDUCE", "SELL"].includes(a)) return changePct <= 0;
  return Math.abs(changePct) < 5; // HOLD / NEUTRAL — correct if roughly flat
}

async function analystAccuracy() {
  const { rows } = await db.query(
    "SELECT id, report_json, snapshot_json, source, created_at FROM ai_reports WHERE snapshot_json IS NOT NULL ORDER BY created_at DESC LIMIT 100",
  );
  const reports = [];
  const byAction = {};
  let totHits = 0;
  let totScored = 0;
  for (const row of rows) {
    const rep = row.report_json;
    const snap = row.snapshot_json;
    const details = [];
    for (const al of rep.allocations || []) {
      const past = snap.prices && snap.prices[al.symbol] ? snap.prices[al.symbol].spotUsd : null;
      const now = MARKET.coins[al.symbol] ? MARKET.coins[al.symbol].spotUsd : null;
      if (past == null || now == null) continue;
      const changePct = round(((now - past) / past) * 100, 2);
      const hit = scoreAction(al.action, changePct);
      if (hit == null) continue;
      details.push({ symbol: al.symbol, action: al.action, pastUsd: past, nowUsd: now, changePct, hit });
      byAction[al.action] = byAction[al.action] || { n: 0, hits: 0 };
      byAction[al.action].n += 1;
      if (hit) byAction[al.action].hits += 1;
      totScored += 1;
      if (hit) totHits += 1;
    }
    if (details.length) {
      const hits = details.filter((d) => d.hit).length;
      reports.push({
        id: row.id,
        source: row.source,
        created_at: row.created_at,
        horizonDays: round((Date.now() - new Date(row.created_at).getTime()) / 86400000, 1),
        scored: details.length,
        hits,
        accuracyPct: round((hits / details.length) * 100, 1),
        details,
      });
    }
  }
  const byActionOut = {};
  for (const k of Object.keys(byAction)) byActionOut[k] = { n: byAction[k].n, hitRatePct: round((byAction[k].hits / byAction[k].n) * 100, 1) };
  return {
    aggregate: { reportsScored: reports.length, decisionsScored: totScored, overallAccuracyPct: totScored ? round((totHits / totScored) * 100, 1) : null, byAction: byActionOut },
    reports,
  };
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
      return {
        symbol: s,
        price: c.spotUsd,
        sma200: c.sma200,
        mayer: c.mayer,
        rsi14: c.rsi14,
        macdHist: c.macd ? c.macd.hist : null,
        bollingerPctB: c.bollingerPctB,
        volatilityAnnPct: c.volatilityAnnPct,
        change24h: c.change24h,
        signalScore: c.signal ? c.signal.score : null,
        signalLabel: c.signal ? c.signal.label : null,
      };
    }),
    risk: (() => {
      try {
        return portfolioAnalytics(portfolio).risk;
      } catch (e) {
        return null;
      }
    })(),
    onchain,
    news: (news || []).slice(0, 6).map((n) => n.title),
    monthlyBudgetLkr: MONTHLY_LKR,
  };
}

function ruleBasedAnalyst(ctx) {
  const fg = ctx.fearGreed.value;
  const risk = fg == null ? "MODERATE" : fg < 25 ? "LOW" : fg < 55 ? "MODERATE" : fg < 80 ? "HIGH" : "EXTREME";
  const base = MONTHLY_LKR / COINS.length;
  // Map composite signal → allowed action enum; size by the score around the base.
  const LABEL_TO_ACTION = { STRONG_ACCUMULATE: "STRONG_BUY", ACCUMULATE: "ACCUMULATE", NEUTRAL: "HOLD", REDUCE: "TAKE_PROFIT", TAKE_PROFIT: "TAKE_PROFIT" };
  const allocations = ctx.indicators.map((ind) => {
    const band = mayerBand(ind.mayer);
    // Blend Mayer multiplier with the composite score for position sizing.
    const scoreMult = ind.signalScore != null ? 0.5 + ind.signalScore / 100 : 1; // 0.5x–1.5x
    const suggested = Math.max(0, Math.round(base * ((band.multiplier + scoreMult) / 2)));
    const action = LABEL_TO_ACTION[ind.signalLabel] || (ind.mayer != null && ind.mayer < 0.8 ? "STRONG_BUY" : "HOLD");
    const ladder = (MARKET.coins[ind.symbol] || {}).ladderUsd || [];
    return {
      symbol: ind.symbol,
      suggested_lkr: suggested,
      action,
      ladder_entry_prices_usd: ladder,
      reasoning: `Signal ${ind.signalScore ?? "n/a"}/100 (${ind.signalLabel ?? "n/a"}); Mayer ${ind.mayer ?? "n/a"} (${band.label}), RSI ${ind.rsi14 ?? "n/a"}, %B ${ind.bollingerPctB ?? "n/a"}, MACD ${ind.macdHist ?? "n/a"}.`,
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
  if (priceLkr == null || priceLkr <= 0) {
    const err = new Error(`Couldn't fetch a live price for ${symbol} right now. Hit "Refresh prices" and retry, or enter a price (LKR) override in the form.`);
    err.statusCode = 422;
    throw err;
  }

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
// Scalping signals: multi-indicator confluence -> direction, confidence,
// entry zone, stop, TP1/2/3 (R-multiples) with R:R and an ATR-based ETA.
// Inspired by the indicator set in CryptoSignal/Crypto-Signal (RSI, EMA, MACD,
// MFI, VWAP, Bollinger) — computed here in Node with no external deps.
// ----------------------------------------------------------------------------
const SIGNAL_TF = process.env.SIGNAL_TF || "15m";
const SIGNAL_MIN_CONFIDENCE = Number(process.env.SIGNAL_MIN_CONFIDENCE || 45);

function humanizeEta(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `~${Math.round(minutes)}m`;
  if (minutes < 1440) return `~${(minutes / 60).toFixed(1)}h`;
  return `~${(minutes / 1440).toFixed(1)}d`;
}

async function scalpSignal(symbol, tf, preloaded) {
  const d = preloaded || (await getOHLCV(symbol, tf, 200));
  if (!d || d.closes.length < 60) return { symbol, tf, error: "insufficient data" };
  const { highs, lows, closes, volumes } = d;
  const price = closes[closes.length - 1];
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const mac = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const a = atr(highs, lows, closes, 14);
  const vw = vwap(highs, lows, closes, volumes);
  const mf = mfi(highs, lows, closes, volumes, 14);
  const swingHigh = Math.max(...highs.slice(-20));
  const swingLow = Math.min(...lows.slice(-20));

  // Confluence voting.
  let score = 0;
  const reasons = [];
  if (ema9 != null && ema21 != null && ema50 != null) {
    if (ema9 > ema21 && ema21 > ema50) { score += 2; reasons.push("EMA stack bullish (9>21>50)"); }
    else if (ema9 < ema21 && ema21 < ema50) { score -= 2; reasons.push("EMA stack bearish (9<21<50)"); }
  }
  if (mac) { if (mac.hist > 0) { score += 1; reasons.push("MACD momentum up"); } else if (mac.hist < 0) { score -= 1; reasons.push("MACD momentum down"); } }
  if (r != null) {
    if (r < 30) { score += 1.5; reasons.push(`RSI oversold (${r.toFixed(0)})`); }
    else if (r > 70) { score -= 1.5; reasons.push(`RSI overbought (${r.toFixed(0)})`); }
    else score += r > 50 ? 0.5 : -0.5;
  }
  if (vw != null) { if (price > vw) { score += 0.5; reasons.push("Above VWAP"); } else { score -= 0.5; reasons.push("Below VWAP"); } }
  if (boll) { if (boll.pctB < 0.1) { score += 1; reasons.push("At lower Bollinger band"); } else if (boll.pctB > 0.9) { score -= 1; reasons.push("At upper Bollinger band"); } }
  if (mf != null) { if (mf < 20) { score += 1; reasons.push(`MFI oversold (${mf.toFixed(0)})`); } else if (mf > 80) { score -= 1; reasons.push(`MFI overbought (${mf.toFixed(0)})`); } }

  const MAX = 7;
  const confidence = Math.min(100, Math.round((Math.abs(score) / MAX) * 100));
  const direction = confidence >= SIGNAL_MIN_CONFIDENCE ? (score > 0 ? "LONG" : "SHORT") : "NEUTRAL";

  const fx = MARKET.fx;
  const indicators = {
    price: round(price, 4),
    rsi14: round(r, 1),
    macdHist: mac ? round(mac.hist, 4) : null,
    bollingerPctB: boll ? round(boll.pctB, 3) : null,
    vwap: round(vw, 4),
    mfi: round(mf, 1),
    atr: round(a, 4),
    ema9: round(ema9, 4), ema21: round(ema21, 4), ema50: round(ema50, 4),
    swingHigh: round(swingHigh, 4), swingLow: round(swingLow, 4),
  };

  const base = { symbol, tf, direction, confidence, priceUsd: round(price, 4), priceLkr: round(price * fx, 2), reasons, indicators, generatedAt: new Date().toISOString() };
  if (direction === "NEUTRAL" || !a) {
    return { ...base, note: "No high-quality setup — stand aside." };
  }

  const long = direction === "LONG";
  const anchor = long ? Math.min(ema21 || price, vw || price) : Math.max(ema21 || price, vw || price);
  let entryLow;
  let entryHigh;
  if (long) {
    entryHigh = price;
    entryLow = Math.max(swingLow, Math.min(anchor, price - 0.6 * a));
    if (entryLow >= entryHigh) entryLow = price - 0.4 * a;
  } else {
    entryLow = price;
    entryHigh = Math.min(swingHigh, Math.max(anchor, price + 0.6 * a));
    if (entryHigh <= entryLow) entryHigh = price + 0.4 * a;
  }
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = long ? Math.min(swingLow, entryLow - a) : Math.max(swingHigh, entryHigh + a);
  const risk = Math.abs(entryMid - stop);
  const tfMin = TF_MINUTES[tf] || 60;
  const perCandle = a * 0.6; // net expected progress per candle (< full ATR)

  const targets = [1, 2, 3].map((k) => {
    const tp = long ? entryMid + k * risk : entryMid - k * risk;
    const dist = Math.abs(tp - entryMid);
    const candles = perCandle > 0 ? dist / perCandle : Infinity;
    return {
      name: `TP${k}`,
      priceUsd: round(tp, 4),
      priceLkr: round(tp * fx, 2),
      rr: k,
      etaLabel: humanizeEta(candles * tfMin),
    };
  });

  return {
    ...base,
    entry: { low: round(entryLow, 4), high: round(entryHigh, 4), mid: round(entryMid, 4), lowLkr: round(entryLow * fx, 2), highLkr: round(entryHigh * fx, 2) },
    stop: { priceUsd: round(stop, 4), priceLkr: round(stop * fx, 2), riskPct: round((risk / entryMid) * 100, 2) },
    targets,
    invalidation: long ? `Close below ${round(stop, 4)} (below swing low) invalidates the long.` : `Close above ${round(stop, 4)} (above swing high) invalidates the short.`,
  };
}

// Cache signals briefly so UI refreshes don't hammer the exchanges.
const signalCache = {};
async function getSignals(tf) {
  const key = tf;
  const cached = signalCache[key];
  if (cached && Date.now() - cached.at < 45_000) return cached.data;
  const signals = [];
  for (const sym of COINS) {
    try {
      signals.push(await scalpSignal(sym, tf));
    } catch (e) {
      signals.push({ symbol: sym, tf, error: e.message });
    }
  }
  // Rank: actionable setups first, by confidence.
  const rank = (s) => (s.direction === "NEUTRAL" || s.error ? -1 : s.confidence);
  signals.sort((x, y) => rank(y) - rank(x));
  const data = { tf, generatedAt: new Date().toISOString(), signals };
  signalCache[key] = { at: Date.now(), data };
  return data;
}

// ----------------------------------------------------------------------------
// Automated monthly DCA: log the Mayer-scaled allocation as real transactions,
// once per calendar month. Idempotent via a note tag.
// ----------------------------------------------------------------------------
function autoDcaTag(d = new Date()) {
  return `auto-dca ${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function runAutoDca(force = false) {
  const tag = autoDcaTag();
  if (!force) {
    const { rows } = await db.query("SELECT 1 FROM transactions WHERE note = $1 LIMIT 1", [tag]);
    if (rows.length) return { skipped: true, reason: "already ran this month", tag };
  }
  const plan = allocationPlan();
  const logged = [];
  for (const c of plan.perCoin) {
    if (c.suggestedLkr <= 0) continue;
    try {
      const tx = await logTransaction({ symbol: c.symbol, amount_lkr: c.suggestedLkr, note: tag });
      logged.push({ symbol: c.symbol, lkr: c.suggestedLkr, units: Number(tx.units) });
    } catch (e) {
      console.warn(`[auto-dca] ${c.symbol} skipped:`, e.message);
    }
  }
  if (plan.reserveDivertLkr > 0) {
    try {
      await logTransaction({ symbol: "USDT", amount_lkr: plan.reserveDivertLkr, note: tag });
      logged.push({ symbol: "USDT", lkr: plan.reserveDivertLkr, reserve: true });
    } catch (e) {
      console.warn("[auto-dca] reserve skipped:", e.message);
    }
  }
  if (logged.length) {
    const summary = logged.map((l) => `${l.symbol}: ${fmtLkr(l.lkr)}`).join("\n");
    await broadcast(`🤖 *Auto-DCA executed* (${tag})\n${summary}\nTotal: ${fmtLkr(logged.reduce((a, l) => a + l.lkr, 0))}`);
  }
  return { ran: logged.length > 0, tag, logged };
}

// ----------------------------------------------------------------------------
// Express app
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error("[api]", e.message);
  res.status(e.statusCode || 500).json({ error: e.message });
});

app.get("/api/health", (_req, res) => res.json({ status: "ok", market: MARKET.updatedAt }));

app.get("/api/config", (_req, res) =>
  res.json({
    coins: COINS,
    reserve: RESERVE,
    monthlyBudgetLkr: MONTHLY_LKR,
    dcaDay: DCA_DAY,
    nextDcaDate: nextDcaDate(),
    historyYears: HISTORY_YEARS,
    projectionYears: PROJECTION_YEARS,
    signalTf: SIGNAL_TF,
    timeframes: Object.keys(TF_MINUTES),
  }),
);

app.post("/api/refresh", wrap(async (_req, res) => {
  await refreshMarket();
  res.json({ ok: true, updatedAt: MARKET.updatedAt });
}));

// Scalping signals with entry/TP/ETA. ?tf=5m|15m|1h|4h
app.get("/api/signals", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  res.json(await getSignals(tf));
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

app.get("/api/projection", wrap(async (req, res) => {
  const p = await computePortfolio();
  const historyYears = Number(req.query.years) || HISTORY_YEARS;
  const projectionYears = Number(req.query.projYears) || PROJECTION_YEARS;
  res.json({
    history: historyBacktest(historyYears),
    projection: forwardProjection(projectionYears, p.totals.valueLkr),
    startValueLkr: p.totals.valueLkr,
  });
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

// Manually trigger this month's auto-DCA (force=true re-runs even if already done).
app.post("/api/auto-dca", wrap(async (req, res) => res.json(await runAutoDca(req.body && req.body.force === true))));

app.get("/api/analytics", wrap(async (_req, res) => {
  const p = await computePortfolio();
  res.json(portfolioAnalytics(p));
}));

app.get("/api/analyst/accuracy", wrap(async (_req, res) => res.json(await analystAccuracy())));

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

async function rememberChat(chatId) {
  await db
    .query("INSERT INTO telegram_chats (chat_id) VALUES ($1) ON CONFLICT DO NOTHING", [chatId])
    .catch((e) => console.warn("[telegram] remember chat:", e.message));
}

async function getBroadcastChats() {
  const set = new Set();
  if (process.env.TELEGRAM_CHAT_ID) set.add(String(process.env.TELEGRAM_CHAT_ID));
  try {
    const { rows } = await db.query("SELECT chat_id FROM telegram_chats");
    for (const r of rows) set.add(String(r.chat_id));
  } catch (e) {
    /* table may not exist yet */
  }
  return [...set];
}

async function broadcast(text) {
  if (!bot) return;
  const chats = await getBroadcastChats();
  for (const id of chats) {
    await bot.sendMessage(id, text, { parse_mode: "Markdown" }).catch((e) => console.warn("[broadcast]", e.message));
  }
}

function startTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }
  try {
    const TelegramBot = require("node-telegram-bot-api");
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

    // Remember every chat that talks to the bot, so alerts reach all of them.
    bot.on("message", (msg) => rememberChat(msg.chat.id));

    bot.onText(/\/start/, (msg) =>
      bot.sendMessage(
        msg.chat.id,
        "🤖 *Crypto Signal Engine*\n/signals – scalping signals (entry / TP / ETA)\n/portfolio – holdings & P&L\n/buy <symbol> <lkr> – log a buy\n/analyst – AI allocation\n/dca – run this month's auto-DCA now",
        { parse_mode: "Markdown" },
      ),
    );

    bot.onText(/\/dca/, async (msg) => {
      try {
        const r = await runAutoDca(true);
        const txt = r.logged && r.logged.length
          ? r.logged.map((l) => `${l.symbol}: ${fmtLkr(l.lkr)}`).join("\n")
          : "No buys logged (prices unavailable).";
        await bot.sendMessage(msg.chat.id, `🤖 *Auto-DCA* (${r.tag})\n${txt}`, { parse_mode: "Markdown" });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ ${e.message}`);
      }
    });

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

    bot.onText(/\/signals?/, async (msg) => {
      try {
        const { tf, signals } = await getSignals(SIGNAL_TF);
        const lines = signals
          .filter((s) => s.direction && s.direction !== "NEUTRAL")
          .slice(0, 6)
          .map((s) => {
            const tps = (s.targets || []).map((t) => `${t.name} ${t.priceUsd} (${t.etaLabel})`).join(", ");
            return `*${s.symbol}* ${s.direction} ${s.confidence}%\nEntry ${s.entry.low}–${s.entry.high} · SL ${s.stop.priceUsd}\n${tps}`;
          });
        await bot.sendMessage(
          msg.chat.id,
          lines.length ? `📡 *Signals* (${tf})\n\n${lines.join("\n\n")}` : `📡 No high-quality ${tf} setups right now.`,
          { parse_mode: "Markdown" },
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
  if (!bot) return;
  for (const sym of COINS) {
    const c = MARKET.coins[sym];
    if (c && c.change24h != null && c.change24h <= -5) {
      const ladder = (c.ladderLkr || []).map((p) => fmtLkr(p)).join(" / ");
      await broadcast(
        `🔻 *Dip Alert* ${sym} ${c.change24h}% (24h)\nSpot: ${fmtLkr(c.priceLkr)}\nLadder buys: ${ladder}`,
      );
    }
  }
}

// ----------------------------------------------------------------------------
// Cron jobs
// ----------------------------------------------------------------------------
function startCron() {
  cron.schedule("*/30 * * * *", () => refreshMarket().catch((e) => console.warn("[cron market]", e.message)));
  cron.schedule("0 */6 * * *", () => dipAlert().catch((e) => console.warn("[cron dip]", e.message)));
  if (AUTO_DCA) {
    // Daily check at 09:00 UTC; runs once on the configured DCA day (idempotent).
    cron.schedule("0 9 * * *", async () => {
      if (new Date().getUTCDate() !== DCA_DAY) return;
      try {
        const r = await runAutoDca(false);
        console.log("[cron auto-dca]", JSON.stringify(r));
      } catch (e) {
        console.warn("[cron auto-dca]", e.message);
      }
    });
    console.log(`[cron] auto-DCA enabled (day ${DCA_DAY} of month)`);
  }
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

if (require.main === module) boot();

module.exports = app;
// Exposed for unit testing of the pure decision-support math.
module.exports._test = { macd, bollinger, annualizedVol, compositeSignal, pearson, scoreAction, maxDrawdown, mayerBand, historyBacktest, forwardProjection, atr, vwap, mfi, humanizeEta, scalpSignal, MARKET, COINS };
