/**
 * Crypto Scalping Signal Engine — signals-only, no database.
 *
 * Scans the top-N most-liquid USDT markets and emits trend-following trade
 * signals: direction, confidence, entry zone, stop, TP1/2/3 (R-multiples) with
 * an ATR-based ETA, and a short-horizon price forecast.
 *
 * Design informed by how freqtrade (regime filter + entry/exit + time-based
 * targets), hummingbot (multi-pair scanning), ccxt (unified market data) and
 * QuantDinger (indicator-driven markers) work — reimplemented from scratch in
 * Node with only free, keyless market data (Binance primary, Coinbase fallback).
 * Only optional paid key: none. Telegram is optional.
 */
"use strict";

require("dotenv").config();
const path = require("path");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const QUOTE = (process.env.QUOTE || "USDT").toUpperCase();
const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE || 50);
const SIGNAL_TF = process.env.SIGNAL_TF || "1h";
const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const MIN_CONFIDENCE = Number(process.env.SIGNAL_MIN_CONFIDENCE || 45);
const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL_MIN || 5);
const FALLBACK_USD_LKR = Number(process.env.FALLBACK_USD_LKR || 300);

const TF_BINANCE = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h" };
const TF_COINBASE = { "5m": 300, "15m": 900, "1h": 3600 };
const TF_MINUTES = { "5m": 5, "15m": 15, "1h": 60, "4h": 240 };

// Stablecoins / wrapped bases to exclude from the tradable universe.
const EXCLUDE_BASES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "GBP", "USDT"]);
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;

const http = axios.create({ timeout: 12000, headers: { "User-Agent": "signal-engine/2.0" } });

// ---------------------------------------------------------------------------
// Indicators (dependency-free)
// ---------------------------------------------------------------------------
const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

function sma(v, p) {
  if (!v || v.length < p) return null;
  return v.slice(-p).reduce((a, b) => a + b, 0) / p;
}
function ema(v, p) {
  if (!v || v.length < p) return null;
  const k = 2 / (p + 1);
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}
function emaArray(v, p) {
  if (!v || v.length < p) return [];
  const k = 2 / (p + 1);
  const out = new Array(v.length).fill(null);
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = e;
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(v, p = 14) {
  if (!v || v.length < p + 1) return null;
  let g = 0;
  let l = 0;
  for (let i = v.length - p; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function macd(v, f = 12, s = 26, sig = 9) {
  if (!v || v.length < s + sig) return null;
  const ef = emaArray(v, f);
  const es = emaArray(v, s);
  const line = [];
  for (let i = 0; i < v.length; i++) if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]);
  const signal = emaArray(line, sig);
  const m = line[line.length - 1];
  const sg = signal[signal.length - 1];
  if (m == null || sg == null) return null;
  return { macd: m, signal: sg, hist: m - sg };
}
function stddev(v) {
  if (!v || v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}
function bollinger(v, p = 20, mult = 2) {
  if (!v || v.length < p) return null;
  const s = v.slice(-p);
  const mid = s.reduce((a, b) => a + b, 0) / p;
  const sd = stddev(s);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const price = v[v.length - 1];
  return { upper, lower, mid, pctB: upper > lower ? (price - lower) / (upper - lower) : 0.5 };
}
function atr(highs, lows, closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  const tr = [];
  for (let i = 1; i < closes.length; i++) tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  return sma(tr, p);
}
function vwap(highs, lows, closes, vols) {
  let pv = 0;
  let v = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    pv += tp * (vols[i] || 0);
    v += vols[i] || 0;
  }
  return v ? pv / v : null;
}
function mfi(highs, lows, closes, vols, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  let pos = 0;
  let neg = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const ptp = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
    const mf = tp * (vols[i] || 0);
    if (tp > ptp) pos += mf; else if (tp < ptp) neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

// ---------------------------------------------------------------------------
// FX (USD -> LKR), cached
// ---------------------------------------------------------------------------
let fxCache = { rate: FALLBACK_USD_LKR, at: 0 };
async function getUsdLkr() {
  if (Date.now() - fxCache.at < 3600_000) return fxCache.rate;
  try {
    const { data } = await http.get("https://open.er-api.com/v6/latest/USD");
    if (data && data.rates && data.rates.LKR) fxCache = { rate: data.rates.LKR, at: Date.now() };
  } catch (e) { /* keep last/fallback */ }
  return fxCache.rate;
}

// ---------------------------------------------------------------------------
// Market data — universe + OHLCV (Binance primary, Coinbase fallback)
// ---------------------------------------------------------------------------
let universeCache = { at: 0, list: [] };
async function getUniverse(n) {
  if (Date.now() - universeCache.at < 3600_000 && universeCache.list.length) return universeCache.list.slice(0, n);
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/ticker/24hr");
    const list = data
      .filter((t) => t.symbol.endsWith(QUOTE))
      .map((t) => ({ pair: t.symbol, base: t.symbol.slice(0, -QUOTE.length), quoteVolume: Number(t.quoteVolume), changePct: Number(t.priceChangePercent) }))
      .filter((t) => t.base && !EXCLUDE_BASES.has(t.base) && !LEVERAGED.test(t.base) && Number.isFinite(t.quoteVolume))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
    if (list.length) universeCache = { at: Date.now(), list };
  } catch (e) {
    console.warn("[universe] Binance 24hr failed:", e.message);
    if (!universeCache.list.length) {
      // Minimal fallback so the app still returns something if Binance is blocked.
      universeCache = { at: Date.now(), list: ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX"].map((b) => ({ pair: b + QUOTE, base: b, quoteVolume: 0, changePct: 0 })) };
    }
  }
  return universeCache.list.slice(0, n);
}

async function getOHLCV(base, interval, limit = 210) {
  const pair = base + QUOTE;
  try {
    const { data } = await http.get("https://api.binance.com/api/v3/klines", { params: { symbol: pair, interval: TF_BINANCE[interval] || "1h", limit } });
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
        const { data } = await http.get(`https://api.exchange.coinbase.com/products/${base}-USD/candles`, { params: { granularity: g } });
        const rows = [...data].reverse();
        return { highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[1]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
      } catch (e2) { /* fall through */ }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trend-following signal
// ---------------------------------------------------------------------------
function humanizeEta(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `~${Math.round(minutes)}m`;
  if (minutes < 1440) return `~${(minutes / 60).toFixed(1)}h`;
  return `~${(minutes / 1440).toFixed(1)}d`;
}

function computeSignal(base, tf, d, fx) {
  const { highs, lows, closes, volumes } = d;
  if (!closes || closes.length < 60) return { base, symbol: base, tf, error: "insufficient data" };
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200) ?? sma(closes, Math.min(closes.length, 120));
  const r = rsi(closes, 14);
  const mac = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const a = atr(highs, lows, closes, 14);
  const vw = vwap(highs, lows, closes, volumes);
  const mf = mfi(highs, lows, closes, volumes, 14);
  const e20arr = emaArray(closes, 20);
  const slopePerCandle = e20arr.length > 6 && e20arr[e20arr.length - 6] ? (e20arr[e20arr.length - 1] - e20arr[e20arr.length - 6]) / 5 / price : 0;
  const swingHigh = Math.max(...highs.slice(-20));
  const swingLow = Math.min(...lows.slice(-20));

  // Trend regime (freqtrade-style filter).
  const up = ema200 != null && price > ema200 && ema50 > ema200;
  const down = ema200 != null && price < ema200 && ema50 < ema200;
  let direction = up ? "LONG" : down ? "SHORT" : "NEUTRAL";

  const reasons = [];
  let conf = 0;
  if (direction !== "NEUTRAL") {
    const long = direction === "LONG";
    conf += 32;
    reasons.push(long ? "Uptrend (price>EMA200, EMA50>EMA200)" : "Downtrend (price<EMA200, EMA50<EMA200)");
    if ((long && ema20 > ema50) || (!long && ema20 < ema50)) { conf += 14; reasons.push("Fast EMAs aligned with trend"); }
    if (mac && ((long && mac.hist > 0) || (!long && mac.hist < 0))) { conf += 14; reasons.push("MACD momentum with trend"); }
    if (vw != null && ((long && price > vw) || (!long && price < vw))) { conf += 8; reasons.push("On trend side of VWAP"); }
    const sep = a ? Math.abs(ema50 - ema200) / a : 0;
    conf += Math.min(18, sep * 9);
    if (sep > 1.2) reasons.push("Strong trend (EMA separation)");
    if (r != null) {
      if (long) { if (r > 85) { conf -= 12; reasons.push("RSI stretched — prefer a pullback"); } else if (r > 50) conf += 8; }
      else if (r < 15) { conf -= 12; reasons.push("RSI stretched — prefer a bounce"); } else if (r < 50) conf += 8;
    }
    conf = Math.max(0, Math.min(100, Math.round(conf)));
  }
  if (conf < MIN_CONFIDENCE) direction = "NEUTRAL";

  const indicators = {
    price: round(price, 6),
    rsi14: round(r, 1),
    macdHist: mac ? round(mac.hist, 6) : null,
    bollingerPctB: boll ? round(boll.pctB, 3) : null,
    vwap: round(vw, 6),
    mfi: round(mf, 1),
    atr: round(a, 6),
    ema20: round(ema20, 6), ema50: round(ema50, 6), ema200: round(ema200, 6),
  };

  // Short-horizon price forecast (drift from EMA20 slope, band from ATR).
  const H = 24; // candles ahead
  const drift = Math.max(-0.02, Math.min(0.02, slopePerCandle));
  const predicted = price * (1 + drift * H);
  const bandFrac = a ? (a * Math.sqrt(H)) / price : 0.05;
  const forecast = {
    horizon: humanizeEta(H * (TF_MINUTES[tf] || 60)),
    priceUsd: round(predicted, 6),
    lowUsd: round(predicted * (1 - bandFrac), 6),
    highUsd: round(predicted * (1 + bandFrac), 6),
    priceLkr: round(predicted * fx, 2),
  };

  const base_out = {
    base, symbol: base, tf, direction, confidence: conf,
    priceUsd: round(price, 6), priceLkr: round(price * fx, 2),
    changePct: null, indicators, forecast, reasons, generatedAt: new Date().toISOString(),
  };
  if (direction === "NEUTRAL" || !a) return { ...base_out, note: "No trend / setup — stand aside." };

  const long = direction === "LONG";
  const anchor = long ? Math.min(ema20 || price, vw || price) : Math.max(ema20 || price, vw || price);
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
  const perCandle = a * 0.6;
  const targets = [1, 2, 3].map((k) => {
    const tp = long ? entryMid + k * risk : entryMid - k * risk;
    const candles = perCandle > 0 ? Math.abs(tp - entryMid) / perCandle : Infinity;
    return { name: `TP${k}`, priceUsd: round(tp, 6), priceLkr: round(tp * fx, 2), rr: k, etaLabel: humanizeEta(candles * tfMin) };
  });
  // Entry readiness: are we in the zone, or is a pullback needed?
  const inZone = price >= entryLow && price <= entryHigh;
  const status = inZone ? "READY" : long ? "WAIT for pullback to entry" : "WAIT for bounce to entry";

  return {
    ...base_out,
    entry: { low: round(entryLow, 6), high: round(entryHigh, 6), mid: round(entryMid, 6), status, lowLkr: round(entryLow * fx, 2), highLkr: round(entryHigh * fx, 2) },
    stop: { priceUsd: round(stop, 6), priceLkr: round(stop * fx, 2), riskPct: round((risk / entryMid) * 100, 2) },
    targets,
    invalidation: long ? `Close below ${round(stop, 6)} invalidates the long.` : `Close above ${round(stop, 6)} invalidates the short.`,
  };
}

async function signalFor(base, tf, fx) {
  try {
    const d = await getOHLCV(base, tf, 210);
    if (!d) return { base, symbol: base, tf, error: "no data" };
    return computeSignal(base, tf, d, fx);
  } catch (e) {
    return { base, symbol: base, tf, error: e.message };
  }
}

// Concurrency-limited market scan with a short cache per timeframe.
const scanCache = {};
let scanning = false;
async function scanMarket(tf) {
  const cached = scanCache[tf];
  if (cached && Date.now() - cached.at < 60_000) return cached.data;
  if (scanning && cached) return cached.data;
  scanning = true;
  try {
    const [fx, universe] = await Promise.all([getUsdLkr(), getUniverse(UNIVERSE_SIZE)]);
    const results = [];
    const batchSize = 8;
    for (let i = 0; i < universe.length; i += batchSize) {
      const batch = universe.slice(i, i + batchSize);
      const sigs = await Promise.all(batch.map((u) => signalFor(u.base, tf, fx)));
      sigs.forEach((s, j) => {
        if (batch[j]) s.changePct = round(batch[j].changePct, 2);
      });
      results.push(...sigs);
    }
    const rankable = (s) => (s.error || s.direction === "NEUTRAL" ? -1 : s.confidence);
    results.sort((a, b) => rankable(b) - rankable(a));
    const data = {
      tf,
      fx,
      generatedAt: new Date().toISOString(),
      universe: universe.length,
      actionable: results.filter((s) => s.direction === "LONG" || s.direction === "SHORT").length,
      signals: results,
    };
    scanCache[tf] = { at: Date.now(), data };
    return data;
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error("[api]", e.message); res.status(e.statusCode || 500).json({ error: e.message }); });

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/config", (_req, res) => res.json({ quote: QUOTE, universeSize: UNIVERSE_SIZE, tf: SIGNAL_TF, timeframes: TIMEFRAMES, minConfidence: MIN_CONFIDENCE }));

app.get("/api/signals", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  const data = await scanMarket(tf);
  let signals = data.signals;
  if (req.query.only === "actionable") signals = signals.filter((s) => s.direction === "LONG" || s.direction === "SHORT");
  if (req.query.dir === "LONG" || req.query.dir === "SHORT") signals = signals.filter((s) => s.direction === req.query.dir);
  if (req.query.limit) signals = signals.slice(0, Number(req.query.limit));
  res.json({ ...data, signals });
}));

app.get("/api/signal/:symbol", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  const fx = await getUsdLkr();
  res.json(await signalFor(req.params.symbol.toUpperCase().replace(QUOTE, ""), tf, fx));
}));

app.post("/api/rescan", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  delete scanCache[tf];
  res.json(await scanMarket(tf));
}));

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------------------------------------------------------------------
// Telegram (optional)
// ---------------------------------------------------------------------------
let bot = null;
const chats = new Set();
if (process.env.TELEGRAM_CHAT_ID) chats.add(String(process.env.TELEGRAM_CHAT_ID));
function fmtUsd(n) { return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 }); }

function startTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.log("[telegram] disabled (no token)"); return; }
  try {
    const TelegramBot = require("node-telegram-bot-api");
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    bot.on("message", (m) => chats.add(m.chat.id));
    bot.onText(/\/start/, (m) => bot.sendMessage(m.chat.id, "📡 *Signal Engine*\n/signals – top setups\n/signal <SYMBOL> – one coin", { parse_mode: "Markdown" }));
    bot.onText(/\/signals?$/, async (m) => {
      const { tf, signals } = await scanMarket(SIGNAL_TF);
      const top = signals.filter((s) => s.direction !== "NEUTRAL" && !s.error).slice(0, 8);
      const txt = top.length
        ? top.map((s) => `*${s.symbol}* ${s.direction} ${s.confidence}% (${s.entry.status})\nEntry ${fmtUsd(s.entry.low)}–${fmtUsd(s.entry.high)} · SL ${fmtUsd(s.stop.priceUsd)}\n${s.targets.map((t) => `${t.name} ${fmtUsd(t.priceUsd)} ${t.etaLabel}`).join(", ")}`).join("\n\n")
        : `No ${tf} setups right now.`;
      bot.sendMessage(m.chat.id, `📡 *Signals* (${tf})\n\n${txt}`, { parse_mode: "Markdown" });
    });
    bot.onText(/\/signal\s+(\w+)/i, async (m, match) => {
      const fx = await getUsdLkr();
      const s = await signalFor(match[1].toUpperCase().replace(QUOTE, ""), SIGNAL_TF, fx);
      if (s.error) return bot.sendMessage(m.chat.id, `⚠️ ${s.symbol}: ${s.error}`);
      if (s.direction === "NEUTRAL") return bot.sendMessage(m.chat.id, `*${s.symbol}* NEUTRAL — ${s.note}`, { parse_mode: "Markdown" });
      bot.sendMessage(m.chat.id, `*${s.symbol}* ${s.direction} ${s.confidence}% (${s.entry.status})\nEntry ${fmtUsd(s.entry.low)}–${fmtUsd(s.entry.high)} · SL ${fmtUsd(s.stop.priceUsd)}\n${s.targets.map((t) => `${t.name} ${fmtUsd(t.priceUsd)} ${t.etaLabel}`).join("\n")}\nForecast ${s.forecast.horizon}: ${fmtUsd(s.forecast.priceUsd)}`, { parse_mode: "Markdown" });
    });
    bot.on("polling_error", (e) => console.warn("[telegram]", e.message));
    console.log("[telegram] started");
  } catch (e) {
    console.warn("[telegram] failed:", e.message);
  }
}

// Alert on newly-appearing high-confidence setups.
const alerted = new Map();
async function signalAlerts() {
  if (!bot || chats.size === 0) return;
  const { signals } = await scanMarket(SIGNAL_TF);
  for (const s of signals) {
    if (s.error || s.direction === "NEUTRAL" || s.confidence < Math.max(60, MIN_CONFIDENCE)) continue;
    const key = `${s.symbol}:${s.direction}`;
    if (Date.now() - (alerted.get(key) || 0) < 6 * 3600_000) continue; // dedupe 6h
    alerted.set(key, Date.now());
    const msg = `🚨 *${s.symbol}* ${s.direction} ${s.confidence}% (${SIGNAL_TF})\nEntry ${fmtUsd(s.entry.low)}–${fmtUsd(s.entry.high)} · SL ${fmtUsd(s.stop.priceUsd)}\n${s.targets.map((t) => `${t.name} ${fmtUsd(t.priceUsd)} ${t.etaLabel}`).join(", ")}`;
    for (const id of chats) bot.sendMessage(id, msg, { parse_mode: "Markdown" }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function startCron() {
  const m = Math.max(2, SCAN_INTERVAL_MIN);
  cron.schedule(`*/${m} * * * *`, () => scanMarket(SIGNAL_TF).catch((e) => console.warn("[cron scan]", e.message)));
  cron.schedule("*/15 * * * *", () => signalAlerts().catch((e) => console.warn("[cron alert]", e.message)));
}

async function boot() {
  app.listen(PORT, () => console.log(`[server] signals on ${PORT}`));
  startTelegram();
  startCron();
  scanMarket(SIGNAL_TF).catch((e) => console.warn("[boot] initial scan:", e.message));
}

if (require.main === module) boot();

module.exports = app;
module.exports._test = { ema, sma, rsi, macd, bollinger, atr, vwap, mfi, computeSignal, humanizeEta };
