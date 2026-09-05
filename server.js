/**
 * Crypto Scalping Signal Engine - signals + live outcome tracking.
 *
 * - Scans the top-N most-liquid markets across whichever exchange is reachable
 *   (Binance -> Bybit -> OKX, Coinbase per-coin fallback) - a minimal ccxt-style
 *   unified layer so it works even where Binance is geo-blocked.
 * - Trend-following signals: direction, confidence, entry zone, stop, TP1/2/3
 *   (R-multiples) with ETA, and a price forecast.
 * - Logs every high-quality signal and continuously checks whether it reaches
 *   entry -> TP1/2/3 or stop, producing a real win-rate / track record so you
 *   can trust it. Durable when DATABASE_URL is set; in-memory otherwise.
 *
 * Free, keyless market data. Telegram + Postgres are optional.
 */
"use strict";

require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const createForex = require("./forex");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const QUOTE = (process.env.QUOTE || "USDT").toUpperCase();
const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE || 60);
const SIGNAL_TF = process.env.SIGNAL_TF || "1h";
const TIMEFRAMES = ["15m", "1h", "4h", "1d"]; // 5m dropped (too noisy); 1d added for higher-TF confirmation
const MIN_CONFIDENCE = Number(process.env.SIGNAL_MIN_CONFIDENCE || 45);
const TRACK_MIN_CONFIDENCE = Number(process.env.TRACK_MIN_CONFIDENCE || 95); // only track very-high-conviction setups
const SCAN_INTERVAL_SEC = Math.max(3, Number(process.env.SCAN_INTERVAL_SEC || 5)); // live price/monitor tick
const INDICATOR_REFRESH_SEC = Math.max(15, Number(process.env.INDICATOR_REFRESH_SEC || 60)); // heavy indicator rescan
const FALLBACK_USD_LKR = Number(process.env.FALLBACK_USD_LKR || 300);
const MAX_WAIT_CANDLES = Number(process.env.MAX_WAIT_CANDLES || 12); // wait for entry fill
const MAX_HOLD_CANDLES = Number(process.env.MAX_HOLD_CANDLES || 60); // max time in trade
const EXCHANGE_ORDER = (process.env.EXCHANGES || "binance").split(",").map((s) => s.trim().toLowerCase());
// Binance public hosts tried in order - data-api.binance.vision is the market-data
// mirror that usually works even where api.binance.com is geo-blocked.
const BINANCE_HOSTS = (process.env.BINANCE_HOSTS || "https://data-api.binance.vision,https://api.binance.com,https://api-gcp.binance.com,https://api1.binance.com").split(",").map((h) => h.trim());

const TF_MINUTES = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
const EXCLUDE_BASES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "GBP", "USDT", "USD", "WBTC", "WETH"]);
const LEVERAGED = /(UP|DOWN|BULL|BEAR|[0-9]+L|[0-9]+S)$/;

const http = axios.create({ timeout: 12000, headers: { "User-Agent": "signal-engine/3.0" } });
const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
// Price rounding by SIGNIFICANT figures, not fixed decimals - otherwise sub-cent
// coins (PEPE ~0.0000012, SHIB, BONK…) collapse to the same value at 6 decimals,
// making entry/stop/targets identical (risk 0) so the trade never fills and always
// EXPIRES. 8 sig figs keeps precision across both huge and tiny prices.
const rp = (n) => (Number.isFinite(n) ? Number(n.toPrecision(8)) : null);

// ===========================================================================
// Indicators
// ===========================================================================
function sma(v, p) { if (!v || v.length < p) return null; return v.slice(-p).reduce((a, b) => a + b, 0) / p; }
function ema(v, p) { if (!v || v.length < p) return null; const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function emaArray(v, p) { if (!v || v.length < p) return []; const k = 2 / (p + 1); const out = new Array(v.length).fill(null); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; out[p - 1] = e; for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; } return out; }
function rsi(v, p = 14) { if (!v || v.length < p + 1) return null; let g = 0, l = 0; for (let i = v.length - p; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; } if (l === 0) return 100; return 100 - 100 / (1 + g / l); }
function macd(v) { if (!v || v.length < 35) return null; const ef = emaArray(v, 12), es = emaArray(v, 26); const line = []; for (let i = 0; i < v.length; i++) if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]); const sig = emaArray(line, 9); const m = line[line.length - 1], s = sig[sig.length - 1]; if (m == null || s == null) return null; return { macd: m, signal: s, hist: m - s }; }
function stddev(v) { if (!v || v.length < 2) return null; const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); }
function bollinger(v, p = 20, mult = 2) { if (!v || v.length < p) return null; const s = v.slice(-p); const mid = s.reduce((a, b) => a + b, 0) / p; const sd = stddev(s); const upper = mid + mult * sd, lower = mid - mult * sd; const price = v[v.length - 1]; return { upper, lower, mid, pctB: upper > lower ? (price - lower) / (upper - lower) : 0.5 }; }
function atr(h, l, c, p = 14) { if (!c || c.length < p + 1) return null; const tr = []; for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); return sma(tr, p); }
function vwap(h, l, c, vol) { let pv = 0, v = 0; for (let i = 0; i < c.length; i++) { const tp = (h[i] + l[i] + c[i]) / 3; pv += tp * (vol[i] || 0); v += vol[i] || 0; } return v ? pv / v : null; }
function mfi(h, l, c, vol, p = 14) { if (!c || c.length < p + 1) return null; let pos = 0, neg = 0; for (let i = c.length - p; i < c.length; i++) { const tp = (h[i] + l[i] + c[i]) / 3, ptp = (h[i - 1] + l[i - 1] + c[i - 1]) / 3; const mf = tp * (vol[i] || 0); if (tp > ptp) pos += mf; else if (tp < ptp) neg += mf; } if (neg === 0) return 100; return 100 - 100 / (1 + pos / neg); }
// ADX (Wilder) - trend strength; filters choppy markets.
function adx(h, l, c, p = 14) {
  if (!c || c.length < p * 2 + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < c.length; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const wilder = (arr) => { let s = arr.slice(0, p).reduce((a, b) => a + b, 0); const out = [s]; for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); } return out; };
  const trS = wilder(tr), pS = wilder(pdm), mS = wilder(mdm);
  const dx = [];
  for (let i = 0; i < trS.length; i++) { if (!trS[i]) { dx.push(0); continue; } const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i]; dx.push(pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi)); }
  if (dx.length < p) return null;
  let a = dx.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p;
  return a;
}
// Stochastic RSI (0..1) - momentum timing.
function stochRsi(c, p = 14) {
  if (!c || c.length < p * 2) return null;
  const rs = [];
  for (let i = p; i < c.length; i++) rs.push(rsi(c.slice(0, i + 1), p));
  if (rs.length < p) return null;
  const recent = rs.slice(-p), mn = Math.min(...recent), mx = Math.max(...recent), last = rs[rs.length - 1];
  return mx > mn ? (last - mn) / (mx - mn) : 0.5;
}
// --- More TA-Lib-style indicators (reimplemented natively, no ta-lib dep) ---
// CCI - Commodity Channel Index; >100 overbought, <-100 oversold.
function cci(h, l, c, p = 20) {
  if (!c || c.length < p) return null;
  const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3);
  const recent = tp.slice(-p), ma = recent.reduce((a, b) => a + b, 0) / p;
  const md = recent.reduce((a, b) => a + Math.abs(b - ma), 0) / p;
  return md === 0 ? 0 : (tp[tp.length - 1] - ma) / (0.015 * md);
}
// Williams %R - -20 overbought, -80 oversold.
function williamsR(h, l, c, p = 14) {
  if (!c || c.length < p) return null;
  const hh = Math.max(...h.slice(-p)), ll = Math.min(...l.slice(-p)), last = c[c.length - 1];
  return hh === ll ? -50 : (-100 * (hh - last)) / (hh - ll);
}
// OBV - On-Balance Volume; return the series so we can read its slope.
function obv(c, vol) {
  if (!c || c.length < 2) return null;
  let o = 0; const arr = [0];
  for (let i = 1; i < c.length; i++) { if (c[i] > c[i - 1]) o += vol[i] || 0; else if (c[i] < c[i - 1]) o -= vol[i] || 0; arr.push(o); }
  return arr;
}
// Normalized slope of a series over the last n points (-1..1-ish).
function slopeOf(arr, n = 10) {
  if (!arr || arr.length < n + 1) return 0;
  const a = arr[arr.length - 1 - n], b = arr[arr.length - 1];
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return (b - a) / denom;
}
// Parabolic SAR - trailing stop-and-reverse; returns {sar, bull}.
function psar(h, l, step = 0.02, max = 0.2) {
  if (!h || h.length < 5) return null;
  let bull = true, af = step, ep = h[0], sar = l[0];
  for (let i = 1; i < h.length; i++) {
    sar = sar + af * (ep - sar);
    if (bull) {
      if (l[i] < sar) { bull = false; sar = ep; ep = l[i]; af = step; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(max, af + step); }
    } else {
      if (h[i] > sar) { bull = true; sar = ep; ep = h[i]; af = step; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(max, af + step); }
    }
  }
  return { sar, bull };
}
// Candlestick patterns on the latest bar (needs opens). TA-Lib-style reads.
function candlePatterns(o, h, l, c) {
  const n = c.length;
  if (!o || o.length !== n || n < 2) return [];
  const i = n - 1, out = [];
  const body = Math.abs(c[i] - o[i]), range = (h[i] - l[i]) || 1e-9;
  const upper = h[i] - Math.max(c[i], o[i]), lower = Math.min(c[i], o[i]) - l[i];
  if (c[i] > o[i] && c[i - 1] < o[i - 1] && c[i] >= o[i - 1] && o[i] <= c[i - 1]) out.push({ name: "Bullish engulfing", bias: "bull" });
  if (c[i] < o[i] && c[i - 1] > o[i - 1] && o[i] >= c[i - 1] && c[i] <= o[i - 1]) out.push({ name: "Bearish engulfing", bias: "bear" });
  if (lower > 2 * body && upper < body && body / range < 0.4) out.push({ name: "Hammer", bias: "bull" });
  if (upper > 2 * body && lower < body && body / range < 0.4) out.push({ name: "Shooting star", bias: "bear" });
  if (body / range < 0.1) out.push({ name: "Doji (indecision)", bias: "neutral" });
  return out;
}

// ===========================================================================
// FX (USD -> LKR)
// ===========================================================================
let fxCache = { rate: FALLBACK_USD_LKR, at: 0 };
async function getUsdLkr() {
  if (Date.now() - fxCache.at < 3600_000) return fxCache.rate;
  try { const { data } = await http.get("https://open.er-api.com/v6/latest/USD"); if (data?.rates?.LKR) fxCache = { rate: data.rates.LKR, at: Date.now() }; } catch (e) { /* keep */ }
  return fxCache.rate;
}

// ===========================================================================
// Exchange adapters (minimal, ccxt-style). Each returns normalized data.
// ===========================================================================
// Binance GET with host failover; remembers the working host.
let binanceHost = null;
async function binanceGet(pathname, params) {
  const hosts = binanceHost ? [binanceHost, ...BINANCE_HOSTS.filter((h) => h !== binanceHost)] : BINANCE_HOSTS;
  let err;
  for (const h of hosts) {
    try { const r = await http.get(h + pathname, { params, ...proxyCfg() }); binanceHost = h; return r.data; }
    catch (e) { err = e; }
  }
  throw err || new Error("all Binance hosts failed");
}
// Set of Binance-listed, TRADING, spot USDT base assets - the tradable universe.
let binanceBases = { at: 0, set: null };
async function getBinanceBases() {
  if (Date.now() - binanceBases.at < 6 * 3600_000 && binanceBases.set) return binanceBases.set;
  try {
    const info = await binanceGet("/api/v3/exchangeInfo");
    const set = new Set((info.symbols || []).filter((s) => s.quoteAsset === QUOTE && s.status === "TRADING" && s.isSpotTradingAllowed).map((s) => s.baseAsset));
    if (set.size) binanceBases = { at: Date.now(), set };
  } catch (e) { console.warn("[binance] exchangeInfo:", e.message); }
  return binanceBases.set;
}

const adapters = {
  binance: {
    name: "binance",
    async tickers() {
      const data = await binanceGet("/api/v3/ticker/24hr");
      return data.filter((t) => t.symbol.endsWith(QUOTE)).map((t) => ({ base: t.symbol.slice(0, -QUOTE.length), quoteVolume: +t.quoteVolume, last: +t.lastPrice, changePct: +t.priceChangePercent }));
    },
    async klines(base, tf, limit) {
      const data = await binanceGet("/api/v3/klines", { symbol: base + QUOTE, interval: tf, limit });
      return { times: data.map((k) => +k[0]), opens: data.map((k) => +k[1]), highs: data.map((k) => +k[2]), lows: data.map((k) => +k[3]), closes: data.map((k) => +k[4]), volumes: data.map((k) => +k[5]) };
    },
  },
  bybit: {
    name: "bybit",
    async tickers() {
      const { data } = await http.get("https://api.bybit.com/v5/market/tickers", { params: { category: "spot" } });
      return (data.result?.list || []).filter((t) => t.symbol.endsWith(QUOTE)).map((t) => ({ base: t.symbol.slice(0, -QUOTE.length), quoteVolume: +t.turnover24h, last: +t.lastPrice, changePct: +t.price24hPcnt * 100 }));
    },
    async klines(base, tf, limit) {
      const iv = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" }[tf];
      const { data } = await http.get("https://api.bybit.com/v5/market/kline", { params: { category: "spot", symbol: base + QUOTE, interval: iv, limit } });
      const rows = [...(data.result?.list || [])].reverse(); // [start,open,high,low,close,volume,turnover]
      return { times: rows.map((r) => +r[0]), opens: rows.map((r) => +r[1]), highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[3]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
    },
  },
  okx: {
    name: "okx",
    async tickers() {
      const { data } = await http.get("https://www.okx.com/api/v5/market/tickers", { params: { instType: "SPOT" } });
      return (data.data || []).filter((t) => t.instId.endsWith("-" + QUOTE)).map((t) => { const last = +t.last, open = +t.open24h; return { base: t.instId.split("-")[0], quoteVolume: +t.volCcy24h, last, changePct: open ? ((last - open) / open) * 100 : 0 }; });
    },
    async klines(base, tf, limit) {
      const bar = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" }[tf];
      const { data } = await http.get("https://www.okx.com/api/v5/market/candles", { params: { instId: base + "-" + QUOTE, bar, limit } });
      const rows = [...(data.data || [])].reverse(); // [ts,o,h,l,c,vol,...]
      return { times: rows.map((r) => +r[0]), opens: rows.map((r) => +r[1]), highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[3]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
    },
  },
};

let ACTIVE = null;
async function detectSource() {
  if (ACTIVE) return ACTIVE;
  for (const name of EXCHANGE_ORDER) {
    const a = adapters[name];
    if (!a) continue;
    try {
      const t = await a.tickers();
      if (t && t.length > 20) { ACTIVE = a; console.log(`[data] using ${a.name} (${t.length} ${QUOTE} markets)`); return ACTIVE; }
    } catch (e) { console.warn(`[data] ${name} unreachable:`, e.message); }
  }
  console.warn("[data] no exchange reachable");
  return null;
}

// Coinbase per-coin kline fallback (spot USD).
const CB_G = { "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
async function coinbaseKlines(base, tf) {
  const g = CB_G[tf];
  if (!g) return null;
  try {
    const { data } = await http.get(`https://api.exchange.coinbase.com/products/${base}-USD/candles`, { params: { granularity: g } });
    const rows = [...data].reverse(); // [time(s),low,high,open,close,vol]
    return { times: rows.map((r) => +r[0] * 1000), opens: rows.map((r) => +r[3]), highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[1]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
  } catch (e) { return null; }
}

let tickersCache = { at: 0, list: [] };
async function fetchTickers() {
  // Short cache = live prices every ~5s (one request for the whole market).
  if (Date.now() - tickersCache.at < SCAN_INTERVAL_SEC * 1000 && tickersCache.list.length) return tickersCache.list;
  const src = await detectSource();
  if (!src) return tickersCache.list;
  try {
    let list = (await src.tickers())
      .filter((t) => t.base && !EXCLUDE_BASES.has(t.base) && !LEVERAGED.test(t.base) && Number.isFinite(t.quoteVolume))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
    // Restrict to coins actually listed & trading on Binance (you trade on Binance).
    const bset = await getBinanceBases().catch(() => null);
    if (bset && bset.size) list = list.filter((t) => bset.has(t.base));
    if (list.length) tickersCache = { at: Date.now(), list };
  } catch (e) { console.warn("[tickers]", e.message); ACTIVE = null; }
  return tickersCache.list;
}

async function getUniverse(n) { return (await fetchTickers()).slice(0, n); }
async function getTickerMap() { const m = new Map(); for (const t of await fetchTickers()) m.set(t.base, t.last); return m; }

async function getOHLCV(base, tf, limit = 210) {
  const src = await detectSource();
  if (src) {
    try { const d = await src.klines(base, tf, limit); if (d && d.closes.length) return d; } catch (e) { /* fallback */ }
  }
  return coinbaseKlines(base, tf);
}

// ===========================================================================
// Signal (trend-following)
// ===========================================================================
function humanizeEta(minutes) { if (!Number.isFinite(minutes) || minutes <= 0) return "-"; if (minutes < 60) return `~${Math.round(minutes)}m`; if (minutes < 1440) return `~${(minutes / 60).toFixed(1)}h`; return `~${(minutes / 1440).toFixed(1)}d`; }

function computeSignal(base, tf, d, fx, opts = {}) {
  const { opens, highs, lows, closes, volumes } = d;
  if (!closes || closes.length < 60) return { base, symbol: base, tf, error: "insufficient data" };
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200) ?? sma(closes, Math.min(closes.length, 120));
  const r = rsi(closes, 14), mac = macd(closes), boll = bollinger(closes, 20, 2);
  const a = atr(highs, lows, closes, 14), vw = vwap(highs, lows, closes, volumes), mf = mfi(highs, lows, closes, volumes, 14);
  const adxV = adx(highs, lows, closes, 14), srsi = stochRsi(closes, 14);
  // Extra confirmations (TA-Lib-style, native)
  const cciV = cci(highs, lows, closes, 20), wr = williamsR(highs, lows, closes, 14);
  const obvArr = obv(closes, volumes), obvSlope = slopeOf(obvArr, 10);
  const ps = psar(highs, lows), patterns = candlePatterns(opens, highs, lows, closes);
  const e20 = emaArray(closes, 20);
  const slope = e20.length > 6 && e20[e20.length - 6] ? (e20[e20.length - 1] - e20[e20.length - 6]) / 5 / price : 0;
  const swingHigh = Math.max(...highs.slice(-20)), swingLow = Math.min(...lows.slice(-20));

  const up = ema200 != null && price > ema200 && ema50 > ema200;
  const down = ema200 != null && price < ema200 && ema50 < ema200;
  let direction = up ? "LONG" : down ? "SHORT" : "NEUTRAL";
  const reasons = [];
  let conf = 0;
  if (direction !== "NEUTRAL") {
    const long = direction === "LONG";
    conf += 32; reasons.push(long ? "Uptrend (price>EMA200, EMA50>EMA200)" : "Downtrend (price<EMA200, EMA50<EMA200)");
    if ((long && ema20 > ema50) || (!long && ema20 < ema50)) { conf += 14; reasons.push("Fast EMAs aligned"); }
    if (mac && ((long && mac.hist > 0) || (!long && mac.hist < 0))) { conf += 14; reasons.push("MACD momentum with trend"); }
    if (vw != null && ((long && price > vw) || (!long && price < vw))) { conf += 8; reasons.push("On trend side of VWAP"); }
    const sep = a ? Math.abs(ema50 - ema200) / a : 0; conf += Math.min(14, sep * 7); if (sep > 1.2) reasons.push("Strong trend");
    if (r != null) { if (long) { if (r > 85) { conf -= 12; reasons.push("RSI stretched - prefer pullback"); } else if (r > 50) conf += 6; } else if (r < 15) { conf -= 12; reasons.push("RSI stretched - prefer bounce"); } else if (r < 50) conf += 6; }
    // ADX: only trust a trend when it's actually trending (filters chop).
    if (adxV != null) { if (adxV >= 25) { conf += 10; reasons.push(`ADX ${adxV.toFixed(0)} (strong trend)`); } else if (adxV < 18) { conf -= 14; reasons.push(`ADX ${adxV.toFixed(0)} (weak/choppy)`); } }
    // Stochastic RSI: momentum timing for the entry.
    if (srsi != null) { if (long && srsi < 0.2) { conf += 8; reasons.push("StochRSI oversold (entry timing)"); } else if (!long && srsi > 0.8) { conf += 8; reasons.push("StochRSI overbought (entry timing)"); } }
    // OBV: is volume flowing with the trend? (accumulation vs distribution)
    if (obvArr) { if ((long && obvSlope > 0.02) || (!long && obvSlope < -0.02)) { conf += 6; reasons.push("OBV volume confirms trend"); } else if ((long && obvSlope < -0.02) || (!long && obvSlope > 0.02)) { conf -= 6; reasons.push("OBV volume diverging (caution)"); } }
    // Parabolic SAR: trailing stop on the trend side?
    if (ps) { if ((long && ps.bull) || (!long && !ps.bull)) { conf += 6; reasons.push("Parabolic SAR on trend side"); } else { conf -= 6; reasons.push("Parabolic SAR flipped against"); } }
    // CCI: dip/rally timing within the trend.
    if (cciV != null) { if (long && cciV < -100) { conf += 4; reasons.push("CCI oversold - good dip entry"); } else if (!long && cciV > 100) { conf += 4; reasons.push("CCI overbought - good rally entry"); } }
    // Candlestick confirmation on the latest bar.
    const patBias = patterns.find((p) => p.bias !== "neutral");
    if (patBias) { if ((long && patBias.bias === "bull") || (!long && patBias.bias === "bear")) { conf += 6; reasons.push(`${patBias.name} confirms`); } else { conf -= 4; reasons.push(`${patBias.name} against the trade`); } }
    // Higher-timeframe confluence - the biggest accuracy lever.
    if (opts.htfDir) { if (opts.htfDir === direction) { conf += 8; reasons.push(`Higher timeframe (${opts.htf}) trend agrees`); } else if (opts.htfDir !== "NEUTRAL") { conf -= 16; reasons.push(`Higher timeframe (${opts.htf}) trend conflicts - risky`); } }
    conf = Math.max(0, Math.min(100, Math.round(conf)));
  }
  if (conf < MIN_CONFIDENCE) direction = "NEUTRAL";

  const obvTrend = obvArr ? (obvSlope > 0.02 ? "up" : obvSlope < -0.02 ? "down" : "flat") : null;
  const indicators = { price: rp(price), rsi14: round(r, 1), macdHist: rp(mac ? mac.hist : null), bollingerPctB: boll ? round(boll.pctB, 3) : null, vwap: rp(vw), mfi: round(mf, 1), atr: rp(a), atrPct: a && price ? round((a / price) * 100, 2) : null, adx: round(adxV, 1), stochRsi: round(srsi, 2), cci: round(cciV, 1), williamsR: round(wr, 1), obvTrend, psar: ps ? (ps.bull ? "bull" : "bear") : null, ema20: rp(ema20), ema50: rp(ema50), ema200: rp(ema200) };
  const H = 24, drift = Math.max(-0.02, Math.min(0.02, slope)), predicted = price * (1 + drift * H), bandFrac = a ? (a * Math.sqrt(H)) / price : 0.05;
  const forecast = { horizon: humanizeEta(H * (TF_MINUTES[tf] || 60)), priceUsd: rp(predicted), lowUsd: rp(predicted * (1 - bandFrac)), highUsd: rp(predicted * (1 + bandFrac)) };

  const out = { base, symbol: base, tf, direction, confidence: conf, priceUsd: rp(price), priceLkr: round(price * fx, 2), changePct: null, indicators, forecast, reasons, patterns, htf: opts.htf || null, htfDir: opts.htfDir || null, generatedAt: new Date().toISOString() };
  if (direction === "NEUTRAL" || !a) return { ...out, note: "No trend / setup - stand aside." };

  const long = direction === "LONG";
  const anchor = long ? Math.min(ema20 || price, vw || price) : Math.max(ema20 || price, vw || price);
  let entryLow, entryHigh;
  if (long) { entryHigh = price; entryLow = Math.max(swingLow, Math.min(anchor, price - 0.6 * a)); if (entryLow >= entryHigh) entryLow = price - 0.4 * a; }
  else { entryLow = price; entryHigh = Math.min(swingHigh, Math.max(anchor, price + 0.6 * a)); if (entryHigh <= entryLow) entryHigh = price + 0.4 * a; }
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = long ? Math.min(swingLow, entryLow - a) : Math.max(swingHigh, entryHigh + a);
  const risk = Math.abs(entryMid - stop);
  const tfMin = TF_MINUTES[tf] || 60, perCandle = a * 0.6;
  const targets = [1, 2, 3].map((k) => { const tp = long ? entryMid + k * risk : entryMid - k * risk; const candles = perCandle > 0 ? Math.abs(tp - entryMid) / perCandle : Infinity; const etaMin = Number.isFinite(candles) ? Math.round(candles * tfMin) : null; return { name: `TP${k}`, priceUsd: rp(tp), priceLkr: round(tp * fx, 2), rr: k, gainPct: round((Math.abs(tp - entryMid) / entryMid) * 100, 2), etaMin, etaLabel: humanizeEta(candles * tfMin) }; });
  const inZone = price >= entryLow && price <= entryHigh;
  const status = inZone ? "READY" : long ? "WAIT for pullback to entry" : "WAIT for bounce to entry";
  // Plain-English rationale for each drawn level (shown on the chart's "why" panel).
  const riskPct = round((risk / entryMid) * 100, 2);
  const entryWhy = long
    ? `Buy the pullback into the EMA20/VWAP zone (${rp(entryLow)}–${rp(entryHigh)}) instead of chasing price. The trend is up, so a dip gives a better price with the stop closer - a tighter, higher-reward entry.`
    : `Sell the bounce into the EMA20/VWAP zone (${rp(entryLow)}–${rp(entryHigh)}) instead of shorting the low. The trend is down, so a pop gives a better price with the stop closer.`;
  const stopWhy = long
    ? `Set below the recent 20-bar swing low, minus 1×ATR (ATR≈${rp(a)}). A close under here breaks the higher-low structure - the uptrend idea is wrong, so exit.`
    : `Set above the recent 20-bar swing high, plus 1×ATR (ATR≈${rp(a)}). A close over here breaks the lower-high structure - the downtrend idea is wrong, so exit.`;
  const targetsWhy = `TP1/TP2/TP3 sit at 1×/2×/3× the ${riskPct}% risked to the stop (R-multiples). ETAs are projected from recent ATR speed (~${rp(perCandle)}/candle).`;

  // --- Entry timing / window: is it still worth entering from HERE? ---
  // The entry is a LIMIT at the pullback mid (entryMid), so plan R:R to TP1/2/3 is
  // 1:1 / 2:1 / 3:1 by construction. rrNow is only the "buy at market right now"
  // R:R (worse near the top of the zone) - shown for context, never to gate.
  const rewardNow = long ? targets[0].priceUsd - price : price - targets[0].priceUsd;
  const riskNow = long ? price - stop : stop - price;
  const rrNow = riskNow > 0 ? round(rewardNow / riskNow, 2) : null;
  const pastTp1 = long ? price >= targets[0].priceUsd : price <= targets[0].priceUsd;
  const beyondZone = long ? price > entryHigh : price < entryLow;     // ran ABOVE the pullback zone
  const belowZone = long ? price < entryLow : price > entryHigh;      // still deep in the pullback
  let window, enterMsg;
  if (pastTp1) { window = "CLOSED"; enterMsg = "Price already reached TP1 - too late to enter, wait for the next setup."; }
  else if (inZone) { window = "OPEN"; enterMsg = long ? `In the buy zone. Set a limit near ${rp(entryMid)} (buy the pullback) for the best price; entering right at market is the top of the zone.` : `In the sell zone. Set a limit near ${rp(entryMid)} on the bounce.`; }
  else if (belowZone) { window = "OPEN"; enterMsg = long ? `Price dipped into the lower zone (near/under ${rp(entryLow)}) - a strong pullback entry as long as the ${rp(stop)} stop holds.` : `Price popped into the upper zone - a strong short entry while ${rp(stop)} holds.`; }
  else if (beyondZone) { window = rrNow != null && rrNow >= 1.2 ? "CHASE" : "CLOSED"; enterMsg = window === "CHASE" ? "Price is just above the zone - only enter on a small pullback, don't chase the candle." : "Price ran above the entry zone - chasing here is poor risk:reward. Wait for a pullback or the next setup."; }
  else { window = "WAIT"; enterMsg = "Wait for price to reach the entry zone."; }

  // --- Fibonacci retracement (pullback) + extension (targets) from the swing ---
  const range = swingHigh - swingLow || (a || 1);
  const fibRetr = (r) => rp(long ? swingHigh - range * r : swingLow + range * r);
  const fibExt = (r) => rp(long ? swingLow + range * r : swingHigh - range * (r));
  const fib = {
    swingLow: rp(swingLow), swingHigh: rp(swingHigh), direction: long ? "up" : "down",
    retr: { "0.382": fibRetr(0.382), "0.5": fibRetr(0.5), "0.618": fibRetr(0.618), "0.786": fibRetr(0.786) },
    ext: { "1.272": fibExt(1.272), "1.618": fibExt(1.618) },
    goldenLow: fibRetr(0.618), goldenHigh: fibRetr(0.5), // the 0.5-0.618 "golden pocket"
  };
  const inGolden = price >= Math.min(fib.goldenLow, fib.goldenHigh) && price <= Math.max(fib.goldenLow, fib.goldenHigh);

  // --- Trading psychology / discipline checklist ---
  const discipline = [
    `Risk only 1-2% of your account on this trade. At the ${riskPct}% stop, that sets your position size - don't oversize.`,
    "Take partial profit at TP1 and move your stop to break-even - securing TP1 turns the trade risk-free.",
    "Never move your stop further away to avoid a loss. The plan is the plan; a stopped trade is a small, expected cost.",
  ];
  if (window === "CLOSED" || window === "CHASE") discipline.unshift("FOMO check: price already moved. Chasing wrecks your risk:reward - there's always another setup.");
  if (inGolden) discipline.unshift("Price is in the 0.5-0.618 Fibonacci 'golden pocket' - a high-probability pullback entry.");
  if (r != null && ((long && r > 78) || (!long && r < 22))) discipline.push("Momentum is stretched (RSI) - wait for a pullback rather than buying the top / selling the bottom.");
  if (opts.htfDir && opts.htfDir !== direction && opts.htfDir !== "NEUTRAL") discipline.push(`Higher timeframe (${opts.htf}) disagrees - reduce size or skip; trade with the bigger trend.`);

  const rr = { toTp1: `${targets[0].rr}:1`, toTp2: `${targets[1].rr}:1`, toTp3: `${targets[2].rr}:1`, riskPct };
  // Exit plan depends on the chosen style. Default (tp1) banks the full +1R at
  // the first target - best when TP1 is where the edge is.
  const exitPlan = settings.exitStyle === "scaleout"
    ? [
        { at: "TP1", action: "Sell 50%", note: "Move stop to break-even - the trade is now risk-free." },
        { at: "TP2", action: "Sell 25%", note: "Trail the stop up to TP1 to lock more in." },
        { at: "TP3", action: "Sell last 25%", note: "Full run banks about +1.75R blended." },
      ]
    : [
        { at: "TP1", action: "Take full profit", note: "Bank the whole +1R here - TP1 is the reliable edge; don't wait for TP2/TP3." },
        { at: "Stop", action: "Cut the trade", note: `Exit at ${rp(stop)} if price goes the other way first (-1R).` },
      ];
  return { ...out, entry: { low: rp(entryLow), high: rp(entryHigh), mid: rp(entryMid), status, window, rrNow, enterMsg, inGolden, why: entryWhy, lowLkr: round(entryLow * fx, 2), highLkr: round(entryHigh * fx, 2) }, stop: { priceUsd: rp(stop), priceLkr: round(stop * fx, 2), riskPct, why: stopWhy }, targets, targetsWhy, rr, exitPlan, fib, discipline, invalidation: long ? `Close below ${rp(stop)} invalidates the long.` : `Close above ${rp(stop)} invalidates the short.` };
}

async function signalFor(base, tf, fx, opts = {}) {
  try { const d = await getOHLCV(base, tf, 210); if (!d) return { base, symbol: base, tf, error: "no data" }; return computeSignal(base, tf, d, fx, opts); }
  catch (e) { return { base, symbol: base, tf, error: e.message }; }
}

// The next timeframe up - used for multi-timeframe confluence (chains up to 1D).
const HTF_OF = { "15m": "1h", "1h": "4h", "4h": "1d", "1d": null };
// Build base -> trend direction from a recent higher-TF scan cache (no extra fetches).
function htfTrendMap(htf) {
  const c = scanCache[htf];
  if (!c || Date.now() - c.at > INDICATOR_REFRESH_SEC * 3000) return null; // stale/absent -> skip HTF
  const m = new Map();
  for (const s of c.data.signals) if (!s.error) m.set(s.base, s.direction);
  return m;
}

// Historical backtest: replay the exact signal rules over past candles and
// simulate each trade forward using real intrabar highs/lows (pessimistic when
// stop and target share a bar). Returns win rate / TP rates / avg R.
async function backtest(base, tf, bars, preloaded) {
  const d = preloaded || (await getOHLCV(base, tf, Math.min(1000, Math.max(300, bars || 1000))));
  if (!d || d.closes.length < 220) return { symbol: base, tf, error: "not enough data" };
  const { highs, lows, closes, volumes } = d;
  const N = closes.length;
  const trades = [];
  let i = 200;
  while (i < N - 2) {
    const sig = computeSignal(base, tf, { highs: highs.slice(0, i + 1), lows: lows.slice(0, i + 1), closes: closes.slice(0, i + 1), volumes: volumes.slice(0, i + 1) }, 1);
    if (sig.direction === "NEUTRAL" || !sig.entry) { i++; continue; }
    const long = sig.direction === "LONG";
    const eLow = sig.entry.low, eHigh = sig.entry.high, eMid = sig.entry.mid, stop = sig.stop.priceUsd;
    const tp = sig.targets.map((t) => t.priceUsd);
    let entered = false, enterBar = -1, tp1 = false, tp2 = false, outcome = null, j = i + 1;
    for (; j < N; j++) {
      const hi = highs[j], lo = lows[j];
      if (!entered) {
        if (long ? lo <= stop : hi >= stop) { outcome = { status: "EXPIRED", r: 0 }; break; }
        if (long ? lo <= eHigh : hi >= eLow) { entered = true; enterBar = j; }
        else if (j - i > MAX_WAIT_CANDLES) { outcome = { status: "EXPIRED", r: 0 }; break; }
        if (!entered) continue;
      }
      // Full take-profit at TP1 (default): stop first (pessimistic), else TP1 = +1R.
      if (settings.exitStyle === "tp1") {
        if (long ? lo <= stop : hi >= stop) { outcome = { status: "LOSS", r: -1 }; break; }
        if (long ? hi >= tp[0] : lo <= tp[0]) { outcome = { status: "WIN", r: 1, tp1: true }; break; }
        if (j - enterBar > MAX_HOLD_CANDLES) { outcome = { status: "EXPIRED", r: 0 }; break; }
        continue;
      }
      // Scale-out: stop trails to break-even after TP1, to TP1 after TP2 (check
      // pessimistically against the level set by already-confirmed TPs).
      const effStop = tp2 ? tp[0] : tp1 ? eMid : stop;
      const hitStop = long ? lo <= effStop : hi >= effStop;
      if (hitStop) { const rr = !tp1 ? -1 : !tp2 ? 0.5 : 1.25; outcome = { status: tp1 ? "WIN" : "LOSS", r: rr, tp1, tp2 }; break; }
      if (long ? hi >= tp[0] : lo <= tp[0]) tp1 = true;
      if (long ? hi >= tp[1] : lo <= tp[1]) tp2 = true;
      if (long ? hi >= tp[2] : lo <= tp[2]) { outcome = { status: "WIN", r: 1.75, tp1: true, tp2: true, tp3: true }; break; }
      if (j - enterBar > MAX_HOLD_CANDLES) { outcome = { status: tp1 ? "WIN" : "EXPIRED", r: tp2 ? 1.25 : tp1 ? 0.5 : 0, tp1, tp2 }; break; }
    }
    if (!outcome) break; // ran out of data
    trades.push({ dir: sig.direction, ...outcome, tp1: outcome.tp1 || tp1, tp2: outcome.tp2 || tp2, tp3: !!outcome.tp3 });
    i = Math.max(i + 1, j + 1);
  }
  const entered = trades.filter((t) => t.status !== "EXPIRED" || t.r !== 0);
  const wins = trades.filter((t) => t.status === "WIN").length;
  const losses = trades.filter((t) => t.status === "LOSS").length;
  const decided = wins + losses;
  const rs = trades.map((t) => t.r).filter((x) => Number.isFinite(x));
  const pct = (n, dn) => (dn ? round((n / dn) * 100, 1) : null);
  return {
    symbol: base, tf, bars: N, trades: trades.length, entered: entered.length, wins, losses,
    winRatePct: pct(wins, decided),
    tp1RatePct: pct(entered.filter((t) => t.tp1).length, entered.length),
    tp2RatePct: pct(entered.filter((t) => t.tp2).length, entered.length),
    tp3RatePct: pct(entered.filter((t) => t.tp3).length, entered.length),
    avgR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length, 2) : null,
  };
}

// Timeframes to scan + track. SIGNAL_TF always; any timeframe a user views is
// added and kept for 30 min so it gets scanned and its signals tracked too.
const activeTfs = new Map([[SIGNAL_TF, Date.now()]]);
function touchTf(tf) { if (TF_MINUTES[tf]) activeTfs.set(tf, Date.now()); }
function currentTfs() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [k, v] of activeTfs) if (k !== SIGNAL_TF && v < cutoff) activeTfs.delete(k);
  return [...activeTfs.keys()];
}

// Coin "quality" = how BTC/ETH-like it is: high 24h liquidity + lower volatility
// (ATR%). Blue-chips ride out sideways chop and recover; speculative coins may not.
function qualityTier(volUsd, atrPct) {
  const v = Number(volUsd) || 0;
  const liq = v >= 300e6 ? 3 : v >= 80e6 ? 2 : v >= 15e6 ? 1 : 0;      // liquidity 0..3
  const stab = atrPct == null ? 1 : atrPct < 1.5 ? 2 : atrPct < 4 ? 1 : 0; // stability 0..2
  const score = liq + stab;                                             // 0..5
  const tier = score >= 4 ? "Blue-chip" : score >= 3 ? "Solid" : score >= 2 ? "Moderate" : "Speculative";
  return { liquidityUsd: Math.round(v), atrPct: atrPct == null ? null : round(atrPct, 2), score, tier };
}

// Market regime: don't fight BTC. Risk-on = BTC in an uptrend AND most coins
// above their trend; risk-off = BTC down or broad weakness. Longs taken against
// the regime are the ones that fail, so we flag/gate them.
let marketRegime = { tier: "NEUTRAL", breadthPct: null, longs: 0, shorts: 0, total: 0, btc: "NEUTRAL", at: 0 };
function computeRegime(signals) {
  const ok = signals.filter((s) => !s.error);
  const longs = ok.filter((s) => s.direction === "LONG").length;
  const shorts = ok.filter((s) => s.direction === "SHORT").length;
  const total = ok.length || 1;
  const breadthPct = round((longs / total) * 100, 0);
  const btc = signals.find((s) => s.base === "BTC");
  const btcDir = btc && !btc.error ? btc.direction : "NEUTRAL";
  let tier;
  if (btcDir !== "SHORT" && breadthPct >= 55) tier = "RISK_ON";
  else if (btcDir === "SHORT" || breadthPct < 35) tier = "RISK_OFF";
  else tier = "NEUTRAL";
  return { tier, breadthPct, longs, shorts, total, btc: btcDir, at: Date.now() };
}

const scanCache = {};
let scanning = false;
async function scanMarket(tf, force) {
  const cached = scanCache[tf];
  const ttl = INDICATOR_REFRESH_SEC * 1000; // indicators are recomputed on this cadence
  if (!force && cached && Date.now() - cached.at < ttl) return cached.data;
  if (scanning && cached) return cached.data;
  scanning = true;
  try {
    const [fx, universe] = await Promise.all([getUsdLkr(), getUniverse(UNIVERSE_SIZE)]);
    // Multi-timeframe confluence: bias each signal by the higher-TF trend (reuses
    // that TF's cached scan - no extra fetches). Ensure the higher TF stays scanned.
    const htf = HTF_OF[tf];
    if (htf) touchTf(htf);
    const htfMap = htf ? htfTrendMap(htf) : null;
    const results = [];
    for (let i = 0; i < universe.length; i += 8) {
      const batch = universe.slice(i, i + 8);
      const sigs = await Promise.all(batch.map((u) => signalFor(u.base, tf, fx, { htf, htfDir: htfMap ? htfMap.get(u.base) : undefined })));
      sigs.forEach((s, j) => { if (batch[j]) { s.changePct = round(batch[j].changePct, 2); s.liquidityUsd = Math.round(batch[j].quoteVolume || 0); s.quality = qualityTier(batch[j].quoteVolume, s.indicators?.atrPct); } });
      results.push(...sigs);
    }
    const rank = (s) => (s.error || s.direction === "NEUTRAL" ? -1 : s.confidence);
    results.sort((a, b) => rank(b) - rank(a));
    if (tf === SIGNAL_TF) marketRegime = computeRegime(results); // one regime read from the main TF
    const data = { tf, fx, source: ACTIVE?.name || null, generatedAt: new Date().toISOString(), universe: universe.length, actionable: results.filter((s) => s.direction !== "NEUTRAL" && !s.error).length, regime: marketRegime, signals: results };
    scanCache[tf] = { at: Date.now(), data };
    return data;
  } finally { scanning = false; }
}

// ===========================================================================
// Signal tracking store (Postgres if DATABASE_URL, else in-memory)
// ===========================================================================
let useDb = !!process.env.DATABASE_URL;
let pool = null;
let dbError = null;
const mem = [];
let memId = 1;

if (useDb) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  // Railway's internal host (postgres.railway.internal) and localhost do NOT speak
  // SSL - forcing it there throws "server does not support SSL connections", which
  // silently breaks all tracking. Only enable SSL for external/proxied hosts.
  const noSsl = /localhost|127\.0\.0\.1|::1|\.railway\.internal|\.internal(?::\d+)?\/|sslmode=disable/.test(url);
  pool = new Pool({ connectionString: url, ssl: noSsl ? false : { rejectUnauthorized: false } });
  pool.on("error", (e) => console.warn("[store] pool error:", e.message));
}

async function initStore() {
  if (!useDb) { console.log("[store] in-memory (set DATABASE_URL to persist across restarts)"); return; }
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tracked_signals (
      id SERIAL PRIMARY KEY, symbol VARCHAR(20), tf VARCHAR(5), direction VARCHAR(5), confidence INT,
      entry_low DOUBLE PRECISION, entry_high DOUBLE PRECISION, entry_mid DOUBLE PRECISION, stop DOUBLE PRECISION,
      tp1 DOUBLE PRECISION, tp2 DOUBLE PRECISION, tp3 DOUBLE PRECISION,
      status VARCHAR(10) DEFAULT 'WAITING', tp1_hit BOOLEAN DEFAULT false, tp2_hit BOOLEAN DEFAULT false, tp3_hit BOOLEAN DEFAULT false,
      result_r DOUBLE PRECISION, note TEXT,
      eta1_min DOUBLE PRECISION, eta2_min DOUBLE PRECISION, eta3_min DOUBLE PRECISION,
      tp1_at TIMESTAMPTZ, tp2_at TIMESTAMPTZ, tp3_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), entered_at TIMESTAMPTZ, closed_at TIMESTAMPTZ )`);
    // Backfill columns on databases created before ETA tracking existed.
    for (const col of ["eta1_min DOUBLE PRECISION", "eta2_min DOUBLE PRECISION", "eta3_min DOUBLE PRECISION", "tp1_at TIMESTAMPTZ", "tp2_at TIMESTAMPTZ", "tp3_at TIMESTAMPTZ"]) {
      await pool.query(`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }
    // Testnet trading tables.
    await pool.query(`CREATE TABLE IF NOT EXISTS testnet_trades (
      id SERIAL PRIMARY KEY, symbol VARCHAR(20), tf VARCHAR(5), confidence INT,
      qty DOUBLE PRECISION, entry_price DOUBLE PRECISION, tp1 DOUBLE PRECISION, stop DOUBLE PRECISION,
      status VARCHAR(10) DEFAULT 'OPEN', exit_price DOUBLE PRECISION, exit_reason VARCHAR(10),
      pnl_usd DOUBLE PRECISION, pnl_pct DOUBLE PRECISION,
      opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ )`);
    // Built-in PAPER trading (simulated SPOT broker; no exchange, no keys, no proxy).
    await pool.query(`CREATE TABLE IF NOT EXISTS paper_trades (
      id SERIAL PRIMARY KEY, symbol VARCHAR(20), tf VARCHAR(5), direction VARCHAR(5), confidence INT,
      entry_price DOUBLE PRECISION, tp1 DOUBLE PRECISION, stop DOUBLE PRECISION,
      cost_usd DOUBLE PRECISION, qty DOUBLE PRECISION, quality VARCHAR(12),
      eta1_min DOUBLE PRECISION, roi_score DOUBLE PRECISION,
      status VARCHAR(10) DEFAULT 'OPEN', exit_price DOUBLE PRECISION, exit_reason VARCHAR(12),
      pnl_usd DOUBLE PRECISION, pnl_pct DOUBLE PRECISION,
      opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ )`);
    // Migrate an earlier paper_trades table to the current shape if needed.
    for (const col of ["cost_usd DOUBLE PRECISION", "qty DOUBLE PRECISION", "quality VARCHAR(12)", "eta1_min DOUBLE PRECISION", "roi_score DOUBLE PRECISION"])
      await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings ( k VARCHAR(40) PRIMARY KEY, v TEXT )`);
    await forex.initSchema().catch((e) => console.warn("[forex] schema:", e.message));
    // Remove tracked rows for timeframes we no longer scan (e.g. the dropped 5m)
    // so the Live/open trades list doesn't keep showing stale entries.
    const cleaned = await pool.query("DELETE FROM tracked_signals WHERE NOT (tf = ANY($1))", [TIMEFRAMES]).catch(() => null);
    if (cleaned && cleaned.rowCount) console.log(`[store] removed ${cleaned.rowCount} tracked rows for retired timeframes`);
    await pool.query("SELECT 1");
    console.log("[store] Postgres ready (durable tracking)");
  } catch (e) {
    // Don't let a bad DB blank the whole app - fall back to in-memory and surface why.
    dbError = e.message;
    useDb = false;
    console.error("[store] Postgres unavailable - falling back to in-memory tracking:", e.message);
  }
}

const store = {
  async open(sig) {
    const t = sig.targets;
    const row = { symbol: sig.symbol, tf: sig.tf, direction: sig.direction, confidence: sig.confidence, entry_low: sig.entry.low, entry_high: sig.entry.high, entry_mid: sig.entry.mid, stop: sig.stop.priceUsd, tp1: t[0].priceUsd, tp2: t[1].priceUsd, tp3: t[2].priceUsd, eta1_min: t[0].etaMin ?? null, eta2_min: t[1].etaMin ?? null, eta3_min: t[2].etaMin ?? null };
    // Dedup: skip if an open one exists for symbol+direction+tf.
    if (useDb) {
      const { rows } = await pool.query("SELECT 1 FROM tracked_signals WHERE symbol=$1 AND direction=$2 AND tf=$3 AND status IN ('WAITING','ACTIVE') LIMIT 1", [row.symbol, row.direction, row.tf]);
      if (rows.length) return;
      await pool.query(`INSERT INTO tracked_signals (symbol,tf,direction,confidence,entry_low,entry_high,entry_mid,stop,tp1,tp2,tp3,eta1_min,eta2_min,eta3_min) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [row.symbol, row.tf, row.direction, row.confidence, row.entry_low, row.entry_high, row.entry_mid, row.stop, row.tp1, row.tp2, row.tp3, row.eta1_min, row.eta2_min, row.eta3_min]);
    } else {
      if (mem.some((m) => m.symbol === row.symbol && m.direction === row.direction && m.tf === row.tf && (m.status === "WAITING" || m.status === "ACTIVE"))) return;
      mem.push({ id: memId++, status: "WAITING", tp1_hit: false, tp2_hit: false, tp3_hit: false, tp1_at: null, tp2_at: null, tp3_at: null, result_r: null, created_at: new Date().toISOString(), entered_at: null, closed_at: null, ...row });
    }
  },
  async open_rows() { if (useDb) return (await pool.query("SELECT * FROM tracked_signals WHERE status IN ('WAITING','ACTIVE') ORDER BY created_at DESC")).rows; return mem.filter((m) => m.status === "WAITING" || m.status === "ACTIVE"); },
  async recent(limit = 100) { if (useDb) return (await pool.query("SELECT * FROM tracked_signals ORDER BY created_at DESC LIMIT $1", [limit])).rows; return mem.slice().reverse().slice(0, limit); },
  async update(id, f) {
    if (useDb) { const keys = Object.keys(f); if (!keys.length) return; const set = keys.map((k, i) => `${k}=$${i + 2}`).join(","); await pool.query(`UPDATE tracked_signals SET ${set} WHERE id=$1`, [id, ...keys.map((k) => f[k])]); }
    else { const m = mem.find((x) => x.id === id); if (m) Object.assign(m, f); }
  },
};

// State machine: advance one tracked signal given the latest price.
function advance(t, P, now) {
  const long = t.direction === "LONG";
  const belowStop = long ? P <= t.stop : P >= t.stop;
  const reach = (lvl) => (long ? P >= lvl : P <= lvl);
  const tfMin = TF_MINUTES[t.tf] || 60;
  const created = new Date(t.created_at).getTime();
  if (t.status === "WAITING") {
    if (belowStop) return { status: "EXPIRED", closed_at: new Date(), result_r: 0, note: "invalidated before entry" };
    const inZone = P >= t.entry_low && P <= t.entry_high;
    if (inZone || (long ? P <= t.entry_high : P >= t.entry_low)) return { status: "ACTIVE", entered_at: new Date() };
    if ((now - created) / 60000 > MAX_WAIT_CANDLES * tfMin) return { status: "EXPIRED", closed_at: new Date(), result_r: 0, note: "no entry (timeout)" };
    return null;
  }
  if (t.status === "ACTIVE") {
    const upd = {}; const nowD = new Date();
    if (!t.tp1_hit && reach(t.tp1)) { upd.tp1_hit = true; upd.tp1_at = nowD; }
    // Full take-profit at TP1 (default): TP1 is usually the peak for these setups,
    // so banking the whole +1R there beats holding for a TP2/TP3 that rarely comes.
    if (settings.exitStyle === "tp1") {
      if (t.tp1_hit || upd.tp1_hit) return { ...upd, status: "WIN", result_r: 1, closed_at: nowD };
      if (belowStop) return { status: "LOSS", result_r: -1, closed_at: nowD };
      const eMs0 = t.entered_at ? new Date(t.entered_at).getTime() : created;
      if ((now - eMs0) / 60000 > MAX_HOLD_CANDLES * tfMin) {
        const openR = round((long ? P - t.entry_mid : t.entry_mid - P) / Math.abs(t.entry_mid - t.stop), 2);
        return { status: "EXPIRED", result_r: openR, closed_at: nowD };
      }
      return Object.keys(upd).length ? upd : null;
    }
    if (!t.tp2_hit && reach(t.tp2)) { upd.tp2_hit = true; upd.tp2_at = nowD; }
    const t1 = t.tp1_hit || upd.tp1_hit, t2 = t.tp2_hit || upd.tp2_hit;
    // Scale-out: 50% at TP1, 25% at TP2, 25% at TP3 -> full run = +1.75R.
    if (reach(t.tp3)) return { ...upd, tp3_hit: true, tp3_at: nowD, status: "WIN", result_r: 1.75, closed_at: nowD };
    // Stop trails up to lock profit: original -> break-even (after TP1) -> TP1 (after TP2).
    const effStop = t2 ? t.tp1 : t1 ? t.entry_mid : t.stop;
    const hitStop = long ? P <= effStop : P >= effStop;
    if (hitStop) {
      // Stopped: before TP1 = full -1R; after TP1 at break-even = +0.5R booked;
      // after TP2 (last 25% stopped at TP1) = +1.25R. Once TP1 hits, you can't lose.
      const r = !t1 ? -1 : !t2 ? 0.5 : 1.25;
      return { ...upd, status: t1 ? "WIN" : "LOSS", result_r: r, closed_at: nowD };
    }
    const enteredMs = t.entered_at ? new Date(t.entered_at).getTime() : created;
    if ((now - enteredMs) / 60000 > MAX_HOLD_CANDLES * tfMin) {
      if (t2) return { ...upd, status: "WIN", result_r: 1.25, closed_at: nowD };
      if (t1) return { ...upd, status: "WIN", result_r: 0.5, closed_at: nowD };
      const openR = round((long ? P - t.entry_mid : t.entry_mid - P) / Math.abs(t.entry_mid - t.stop), 2);
      return { ...upd, status: "EXPIRED", result_r: openR, closed_at: nowD };
    }
    return Object.keys(upd).length ? upd : null;
  }
  return null;
}

// Patch live prices onto the cached scan so the UI shows moving prices every
// tick without recomputing indicators.
function updateLivePrices(prices) {
  for (const tf of Object.keys(scanCache)) {
    const data = scanCache[tf]?.data;
    if (!data) continue;
    for (const s of data.signals) {
      const p = prices.get(s.base);
      if (p != null) { s.priceUsd = round(p, 6); s.priceLkr = round(p * (data.fx || 1), 2); }
    }
  }
}

async function monitor(prices) {
  const open = await store.open_rows();
  if (!open.length) return;
  if (!prices) prices = await getTickerMap();
  const now = Date.now();
  for (const t of open) {
    const P = prices.get(t.symbol);
    if (P == null) continue;
    const upd = advance(t, P, now);
    if (upd) { await store.update(t.id, upd); await maybeAlertTp1(t, upd).catch(() => {}); }
  }
}

// Newest tracked row per symbol|tf|direction - used to stamp live status onto
// the market cards so you can see "in trade / TP1 hit / stopped" at a glance.
async function trackedIndex() {
  const rows = await store.recent(400); // newest-first
  const m = new Map();
  for (const t of rows) { const k = `${t.symbol}|${t.tf}|${t.direction}`; if (!m.has(k)) m.set(k, t); }
  return m;
}

async function openFrom(data) {
  for (const s of data.signals) {
    if ((s.direction === "LONG" || s.direction === "SHORT") && s.confidence >= TRACK_MIN_CONFIDENCE && s.entry && s.targets) {
      // Skip illiquid junk (tokenized stocks, micro-caps) - they produce the ugly outlier losses.
      if (s.liquidityUsd != null && s.liquidityUsd < settings.minTrackLiquidityUsd) continue;
      await store.open(s).catch((e) => console.warn("[track]", e.message));
      if (settings.tgApproval) await proposeTrade(s).catch((e) => console.warn("[propose]", e.message)); // ask on Telegram first
      else await maybeAutoTrade(s).catch((e) => console.warn("[testnet]", e.message));
    }
  }
  // Paper: rank ALL signals by ROI/time/accuracy and buy the best that fit (rotation).
  await fillPaper(data.signals).catch((e) => console.warn("[paper]", e.message));
}

async function computeStats() {
  // Only high-conviction, currently-scanned setups count toward the record.
  const all = (await store.recent(2000)).filter((t) => TIMEFRAMES.includes(t.tf) && (t.confidence == null || t.confidence >= TRACK_MIN_CONFIDENCE));
  const closed = all.filter((t) => t.status === "WIN" || t.status === "LOSS" || t.status === "EXPIRED");
  const decided = closed.filter((t) => t.status === "WIN" || t.status === "LOSS");
  const wins = decided.filter((t) => t.status === "WIN").length;
  const entered = closed.filter((t) => t.entered_at);
  const pct = (n, d) => (d ? round((n / d) * 100, 1) : null);
  const byTf = {};
  for (const tf of TIMEFRAMES) {
    const dd = decided.filter((t) => t.tf === tf);
    if (dd.length) byTf[tf] = { n: dd.length, winRatePct: pct(dd.filter((t) => t.status === "WIN").length, dd.length) };
  }
  const rs = closed.map((t) => t.result_r).filter((x) => Number.isFinite(x));
  // ETA accuracy: for trades that actually reached TP1, compare the estimated
  // time-to-TP1 (logged at signal time) with how long it really took.
  const etaSamples = [];
  for (const t of entered) {
    const est = Number(t.eta1_min);
    if (t.tp1_at && t.entered_at && Number.isFinite(est) && est > 0) {
      const actual = (new Date(t.tp1_at).getTime() - new Date(t.entered_at).getTime()) / 60000;
      if (actual >= 0) etaSamples.push({ est, act: actual });
    }
  }
  let tp1Eta = null;
  if (etaSamples.length) {
    const estAvg = etaSamples.reduce((a, b) => a + b.est, 0) / etaSamples.length;
    const actAvg = etaSamples.reduce((a, b) => a + b.act, 0) / etaSamples.length;
    const onTime = etaSamples.filter((s) => s.act <= s.est * 1.25).length; // hit at/near or ahead of estimate
    tp1Eta = { n: etaSamples.length, estMin: round(estAvg, 0), actualMin: round(actAvg, 0), estLabel: humanizeEta(estAvg), actualLabel: humanizeEta(actAvg), accuracyPct: round(100 * (1 - Math.min(1, Math.abs(actAvg - estAvg) / estAvg)), 0), onTimePct: round((onTime / etaSamples.length) * 100, 0) };
  }
  return {
    durable: useDb,
    tp1Eta,
    open: all.filter((t) => t.status === "WAITING" || t.status === "ACTIVE").length,
    tracked: all.length,
    decided: decided.length,
    wins,
    losses: decided.length - wins,
    winRatePct: pct(wins, decided.length),
    tp1RatePct: pct(entered.filter((t) => t.tp1_hit).length, entered.length),
    tp2RatePct: pct(entered.filter((t) => t.tp2_hit).length, entered.length),
    tp3RatePct: pct(entered.filter((t) => t.tp3_hit).length, entered.length),
    avgResultR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length, 2) : null,
    byTimeframe: byTf,
  };
}

// ===========================================================================
// Binance SPOT TESTNET trading (demo money only)
// - Auto-buys $TRADE_USD of a coin when a >=95% LONG signal fires (spot = long only).
// - Closes at TP1 (take profit) or the stop (safety), then records realized PnL.
// Keys are stored server-side and NEVER returned to the browser.
// ===========================================================================
const settings = {
  apiKey: process.env.BINANCE_TESTNET_KEY || "",
  apiSecret: process.env.BINANCE_TESTNET_SECRET || "",
  autoTrade: /^(1|true|yes|on)$/i.test(process.env.AUTO_TRADE || ""),
  tradeUsd: Number(process.env.TRADE_USD || 100),
  testnetBase: process.env.BINANCE_TESTNET_BASE || "https://testnet.binance.vision",
  proxyUrl: process.env.BINANCE_PROXY_URL || "", // route market-data (and optionally testnet) via an allowed region
  proxyTestnet: !/^(0|false|no|off)$/i.test(process.env.PROXY_TESTNET || "true"), // also send testnet trading through the proxy (off = direct)
  qualityOnly: !/^(0|false|no|off)$/i.test(process.env.QUALITY_ONLY || "true"), // only trade blue-chip/solid coins
  holdThroughDips: /^(1|true|yes|on)$/i.test(process.env.HOLD_THROUGH_DIPS || ""), // no stop: hold a sideways spot until TP1
  regimeFilter: !/^(0|false|no|off)$/i.test(process.env.REGIME_FILTER || "true"), // don't auto-buy when the market is risk-off
  exitStyle: (process.env.EXIT_STYLE || "tp1").toLowerCase() === "scaleout" ? "scaleout" : "tp1", // tp1 = full profit at TP1 (best when TP1 is the edge); scaleout = ride to TP3
  minTrackLiquidityUsd: Number(process.env.MIN_TRACK_LIQUIDITY_USD || 15e6), // ignore illiquid junk (tokenized stocks, micro-caps)
  tgApproval: /^(1|true|yes|on)$/i.test(process.env.TG_APPROVAL || ""), // ask on Telegram before each trade
  positionUsd: Number(process.env.POSITION_USD || 20),   // $ margin you'd put per trade
  leverage: Number(process.env.LEVERAGE || 20),          // futures leverage used in the profit/loss projection
  capitalUsd: Number(process.env.CAPITAL_USD || 200),    // total capital (context / risk sizing)
  paperTrading: !/^(0|false|no|off)$/i.test(process.env.PAPER_TRADING || "true"), // simulate spot trades in-app (no exchange)
  paperMaxOpen: Number(process.env.PAPER_MAX_OPEN || 5),        // max concurrent paper positions
  paperPositionUsd: Number(process.env.PAPER_POSITION_USD || 20), // $ spent per SPOT trade (buy this much of the coin)
  paperGoalUsd: Number(process.env.PAPER_GOAL_USD || 10),        // profit target for the session (context / progress bar)
  paperMaxEtaMin: Number(process.env.PAPER_MAX_ETA_MIN || 0),    // 0 = no cap; else skip setups whose TP1 ETA is longer than this
};
let lastTnError = null; // most recent testnet error, surfaced in the UI
const tnConfigured = () => !!(settings.apiKey && settings.apiSecret);
function maskKey(k) { return k ? k.slice(0, 4) + "…" + k.slice(-4) : ""; }
// Accept a proxy in EITHER form and return a proper URL string:
//   - full URL:            http://user:pass@host:port
//   - Webshare download:   host:port:user:pass   (or host:port)
// This lets you paste Webshare's raw line straight in without converting it.
function normalizeProxy(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  if (/^[a-z]+:\/\//i.test(s)) return s;               // already a URL
  const p = s.split(":");
  if (p.length === 4) return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`; // host:port:user:pass
  if (p.length === 2) return `http://${p[0]}:${p[1]}`;                 // host:port (no auth)
  return s; // leave anything else as-is; new URL() will reject it if bad
}
// Binance geo-blocks some regions (incl. many cloud IPs). A proxy in an allowed
// region routes calls around it. Pass a url to test an arbitrary proxy; defaults
// to the saved one. Used by BOTH market-data and testnet calls.
function proxyCfg(url) {
  const raw = url !== undefined ? url : settings.proxyUrl;
  if (!raw) return {};
  try {
    const u = new URL(normalizeProxy(raw));
    return { proxy: { protocol: u.protocol.replace(":", ""), host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined } };
  } catch (e) { return {}; }
}
// Human-friendly Binance error, with guidance for the common cases.
function niceTnError(e) {
  const code = e.response?.data?.code;
  const msg = e.response?.data?.msg || e.message || "request failed";
  if (/restricted location|Eligibility|restricted/i.test(msg)) return "Binance is geo-blocking this server's region. Add a Proxy URL (Settings) that exits in an allowed region, or host the app in an allowed region.";
  if (code === -2015 || /Invalid API-key, IP, or permissions/i.test(msg))
    return "Binance rejected the credentials (-2015). Fix, in order: (1) regenerate a fresh HMAC key at testnet.binance.vision — testnet resets periodically and kills old keys; (2) re-paste BOTH the key AND the secret (a wrong secret looks like this); (3) create the key UNRESTRICTED (no IP whitelist), since requests exit via the proxy IP — or turn OFF 'route testnet through proxy' to send it direct.";
  if (code === -1022 || /Signature for this request/i.test(msg)) return "Signature rejected (-1022). The secret doesn't match the key — re-paste both.";
  if (code === -1021 || /Timestamp for this request/i.test(msg)) return "Clock out of sync (-1021). The server time drifted; retry, and if it persists the host clock needs NTP.";
  return msg;
}

// Testnet (testnet.binance.vision) is usually reachable WITHOUT a proxy. Routing
// it via the proxy can trip an IP-restricted key, so it's toggleable.
function tnProxyCfg() { return settings.proxyTestnet ? proxyCfg() : {}; }
async function tnPublic(pathname, params) { const r = await http.get(settings.testnetBase + pathname, { params, ...tnProxyCfg() }); return r.data; }
async function tnSigned(method, pathname, params = {}) {
  if (!tnConfigured()) throw new Error("Testnet API keys not set");
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const signature = crypto.createHmac("sha256", settings.apiSecret).update(query).digest("hex");
  const url = `${settings.testnetBase}${pathname}?${query}&signature=${signature}`;
  const r = await http({ method, url, headers: { "X-MBX-APIKEY": settings.apiKey }, ...tnProxyCfg() });
  return r.data;
}
async function tnAccount() { return tnSigned("get", "/api/v3/account"); }
async function tnFree(asset) { const a = await tnAccount(); const b = (a.balances || []).find((x) => x.asset === asset); return b ? +b.free : 0; }
const tnStepCache = {};
async function tnStep(symbol) {
  if (tnStepCache[symbol]) return tnStepCache[symbol];
  try { const info = await tnPublic("/api/v3/exchangeInfo", { symbol }); const f = (info.symbols?.[0]?.filters || []).find((x) => x.filterType === "LOT_SIZE"); const step = f ? +f.stepSize : 0.000001; tnStepCache[symbol] = step; return step; }
  catch (e) { return 0.000001; }
}
function floorStep(qty, step) { if (!step) return qty; const dec = Math.max(0, Math.round(-Math.log10(step))); return Number((Math.floor(qty / step) * step).toFixed(dec)); }
async function tnBuyQuote(symbol, quoteUsd) {
  const d = await tnSigned("post", "/api/v3/order", { symbol, side: "BUY", type: "MARKET", quoteOrderQty: quoteUsd });
  const qty = +d.executedQty, quote = +d.cummulativeQuoteQty; return { qty, quote, avg: qty ? quote / qty : null };
}
async function tnSellQty(symbol, qty) {
  const step = await tnStep(symbol), q = floorStep(qty, step);
  const d = await tnSigned("post", "/api/v3/order", { symbol, side: "SELL", type: "MARKET", quantity: q });
  const eq = +d.executedQty, quote = +d.cummulativeQuoteQty; return { qty: eq, quote, avg: eq ? quote / eq : null };
}

// Executed testnet trades store (Postgres if available, else memory).
const tnMem = []; let tnId = 1;
const tstore = {
  async openTrades() { if (useDb) return (await pool.query("SELECT * FROM testnet_trades WHERE status='OPEN' ORDER BY opened_at DESC")).rows; return tnMem.filter((t) => t.status === "OPEN"); },
  async all(limit = 100) { if (useDb) return (await pool.query("SELECT * FROM testnet_trades ORDER BY opened_at DESC LIMIT $1", [limit])).rows; return tnMem.slice().reverse().slice(0, limit); },
  async hasOpen(symbol) { if (useDb) { const { rows } = await pool.query("SELECT 1 FROM testnet_trades WHERE symbol=$1 AND status='OPEN' LIMIT 1", [symbol]); return rows.length > 0; } return tnMem.some((t) => t.symbol === symbol && t.status === "OPEN"); },
  async insert(t) { if (useDb) { const { rows } = await pool.query("INSERT INTO testnet_trades (symbol,tf,confidence,qty,entry_price,tp1,stop) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [t.symbol, t.tf, t.confidence, t.qty, t.entry_price, t.tp1, t.stop]); return rows[0].id; } const id = tnId++; tnMem.push({ id, status: "OPEN", opened_at: new Date().toISOString(), ...t }); return id; },
  async close(id, f) { if (useDb) { const keys = Object.keys(f); const set = keys.map((k, i) => `${k}=$${i + 2}`).join(","); await pool.query(`UPDATE testnet_trades SET ${set} WHERE id=$1`, [id, ...keys.map((k) => f[k])]); } else { const m = tnMem.find((x) => x.id === id); if (m) Object.assign(m, f); } },
};

// Persist settings so auto-trade survives restarts (durable only with Postgres).
async function loadSettings() {
  if (!useDb) return;
  try { const { rows } = await pool.query("SELECT v FROM app_settings WHERE k='trade'"); if (rows[0]) { const s = JSON.parse(rows[0].v); Object.assign(settings, s); console.log("[testnet] settings loaded from DB"); } } catch (e) { /* table may not exist yet */ }
}
async function saveSettings() {
  if (!useDb) return;
  try { await pool.query("INSERT INTO app_settings (k,v) VALUES ('trade',$1) ON CONFLICT (k) DO UPDATE SET v=$1", [JSON.stringify(settings)]); } catch (e) { console.warn("[testnet] settings save:", e.message); }
}
// Remember which Telegram chats to message, so a restart/redeploy doesn't lose
// them (otherwise you'd have to send /start again every deploy).
async function loadChats() {
  if (!useDb) return;
  try { const { rows } = await pool.query("SELECT v FROM app_settings WHERE k='tg_chats'"); if (rows[0]) { for (const id of JSON.parse(rows[0].v)) chats.add(String(id)); console.log(`[telegram] restored ${chats.size} chat(s) from DB`); } } catch (e) { /* table may not exist yet */ }
}
async function saveChats() {
  if (!useDb) return;
  try { await pool.query("INSERT INTO app_settings (k,v) VALUES ('tg_chats',$1) ON CONFLICT (k) DO UPDATE SET v=$1", [JSON.stringify([...chats])]); } catch (e) { /* non-fatal */ }
}

// Place the buy when a >=95% LONG signal is logged.
async function maybeAutoTrade(s) {
  if (!settings.autoTrade || !tnConfigured()) return;
  if (s.direction !== "LONG" || !s.entry || !s.targets) return;            // spot = long only
  if (s.confidence < TRACK_MIN_CONFIDENCE) return;                          // >=95% only
  if (settings.regimeFilter && marketRegime.tier === "RISK_OFF") return;    // don't buy longs when market is risk-off
  if (settings.qualityOnly && (!s.quality || s.quality.score < 3)) return;  // blue-chip/solid only
  const symbol = s.symbol + QUOTE;
  if (await tstore.hasOpen(symbol)) return;                                 // one open trade per coin
  try {
    const buy = await tnBuyQuote(symbol, settings.tradeUsd);
    if (!buy.qty || !buy.avg) return;
    const gain1 = s.targets[0].gainPct || 1;                               // % from entry to TP1
    const riskPct = s.stop.riskPct || 1;                                   // % from entry to stop
    const tp1 = buy.avg * (1 + gain1 / 100);
    // Hold-through-dips: no stop, ride a sideways spot until TP1 (quality coins recover).
    const stop = settings.holdThroughDips ? null : buy.avg * (1 - riskPct / 100);
    await tstore.insert({ symbol, tf: s.tf, confidence: s.confidence, qty: buy.qty, entry_price: rp(buy.avg), tp1: rp(tp1), stop: stop == null ? null : rp(stop) });
    console.log(`[testnet] BUY ${symbol} qty ${buy.qty} @ ${buy.avg} (TP1 ${rp(tp1)}, stop ${stop == null ? "none/hold" : rp(stop)})`);
  } catch (e) { lastTnError = niceTnError(e); console.warn("[testnet] buy failed:", lastTnError); }
}
// Close open testnet trades at TP1 (profit) or stop (safety); record PnL.
async function manageTestnet(prices) {
  if (!tnConfigured()) return;
  let open;
  try { open = await tstore.openTrades(); } catch (e) { return; }
  for (const t of open) {
    const base = t.symbol.replace(QUOTE, "");
    const P = prices.get(base);
    if (P == null) continue;
    // Close at TP1 (take profit) or the stop (safety). A null stop = hold-through-dips.
    const reason = P >= t.tp1 ? "TP1" : t.stop != null && P <= t.stop ? "STOP" : null;
    if (!reason) continue;
    try {
      const free = await tnFree(base);
      const sellQty = Math.min(free, t.qty);
      if (sellQty <= 0) { await tstore.close(t.id, { status: "CLOSED", exit_reason: "NO_BAL", closed_at: new Date() }); continue; }
      const sell = await tnSellQty(t.symbol, sellQty);
      const pnl = (sell.avg - t.entry_price) * sell.qty, pnlPct = ((sell.avg - t.entry_price) / t.entry_price) * 100;
      await tstore.close(t.id, { status: "CLOSED", exit_price: rp(sell.avg), exit_reason: reason, pnl_usd: round(pnl, 2), pnl_pct: round(pnlPct, 2), closed_at: new Date() });
      console.log(`[testnet] SELL ${t.symbol} ${reason} PnL ${pnl.toFixed(2)} USDT`);
    } catch (e) { lastTnError = niceTnError(e); console.warn("[testnet] sell failed:", lastTnError); }
  }
}

// ===========================================================================
// Built-in PAPER trading - a realistic SPOT broker. It holds a fixed pot of cash
// (CAPITAL_USD), buys $PAPER_POSITION_USD of a high-quality >=95% coin, banks the
// cash + profit back at TP1 (or the stop), then rotates that freed cash into the
// NEXT best coin. Long-only, no leverage - exactly like a real spot account.
// No exchange, no API keys, no proxy, no geo-block. 24/7.
// ===========================================================================
const pMem = []; let pId = 1;
const pstore = {
  async openTrades() { if (useDb) return (await pool.query("SELECT * FROM paper_trades WHERE status='OPEN' ORDER BY opened_at DESC")).rows; return pMem.filter((t) => t.status === "OPEN"); },
  async all(limit = 200) { if (useDb) return (await pool.query("SELECT * FROM paper_trades ORDER BY opened_at DESC LIMIT $1", [limit])).rows; return pMem.slice().reverse().slice(0, limit); },
  async hasOpen(symbol) { if (useDb) { const { rows } = await pool.query("SELECT 1 FROM paper_trades WHERE symbol=$1 AND status='OPEN' LIMIT 1", [symbol]); return rows.length > 0; } return pMem.some((t) => t.symbol === symbol && t.status === "OPEN"); },
  async countOpen() { if (useDb) return +(await pool.query("SELECT COUNT(*) c FROM paper_trades WHERE status='OPEN'")).rows[0].c; return pMem.filter((t) => t.status === "OPEN").length; },
  async openCost() { if (useDb) return +((await pool.query("SELECT COALESCE(SUM(cost_usd),0) s FROM paper_trades WHERE status='OPEN'")).rows[0].s) || 0; return pMem.filter((t) => t.status === "OPEN").reduce((a, t) => a + (Number(t.cost_usd) || 0), 0); },
  async insert(t) { if (useDb) { const { rows } = await pool.query("INSERT INTO paper_trades (symbol,tf,direction,confidence,entry_price,tp1,stop,cost_usd,qty,quality,eta1_min,roi_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id", [t.symbol, t.tf, t.direction, t.confidence, t.entry_price, t.tp1, t.stop, t.cost_usd, t.qty, t.quality, t.eta1_min, t.roi_score]); return rows[0].id; } const id = pId++; pMem.push({ id, status: "OPEN", opened_at: new Date().toISOString(), ...t }); return id; },
  async close(id, f) { if (useDb) { const keys = Object.keys(f); const set = keys.map((k, i) => `${k}=$${i + 2}`).join(","); await pool.query(`UPDATE paper_trades SET ${set} WHERE id=$1`, [id, ...keys.map((k) => f[k])]); } else { const m = pMem.find((x) => x.id === id); if (m) Object.assign(m, f); } },
  async reset() { if (useDb) await pool.query("DELETE FROM paper_trades"); else { pMem.length = 0; pId = 1; } },
};
// The spot account: starting cash + realized PnL - cash currently tied up in open
// positions = free cash available to deploy into the next trade.
async function paperAccount() {
  const rows = await pstore.all(5000);
  const closed = rows.filter((t) => t.status === "WIN" || t.status === "LOSS");
  const realized = closed.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
  const invested = await pstore.openCost();
  const wins = closed.filter((t) => t.status === "WIN").length, losses = closed.filter((t) => t.status === "LOSS").length;
  return { start: settings.capitalUsd, realized: round(realized, 2), invested: round(invested, 2), cash: round(settings.capitalUsd + realized - invested, 2), wins, losses, closed: closed.length };
}
async function tgBroadcast(text) { if (!bot || chats.size === 0) return; for (const id of chats) bot.sendMessage(id, text, { parse_mode: "Markdown", disable_web_page_preview: true }).catch(() => {}); }
// Format an absolute time (ms) as HH:MM Sri Lanka time.
function slClock(ms) { return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(11, 16) + " SL"; }
// Structured PAPER BUY / SELL cards (same house style as the signal card).
function fmtPaperBuy(o) {
  return `🟢 *PAPER BUY — ${o.symbol}*\n`
    + `💎 ${o.quality} Setup | ${o.alloc}% Allocation\n\n`
    + `💵 Capital: *$${o.cost}*\n`
    + `🪙 Entry: ${o.qty} ${o.symbol} @ ${fmtUsd(o.entry)}\n\n`
    + `🎯 *TAKE PROFIT:* ${fmtUsd(o.tp1)}\n`
    + `📈 Target: +${o.gainPct}% → *+$${o.proj}*\n\n`
    + `🛑 *STOP LOSS:* ${fmtUsd(o.stop)}\n`
    + `📉 Risk: -${o.riskPct}% → *-$${o.loss}*\n\n`
    + (o.etaSL ? `⏱ Est. TP1: *${o.etaSL}* (~${o.etaLabel})\n\n` : "")
    + `⚙️ *AUTO-MANAGED*\nPosition closes automatically at TP1 or Stop Loss, then the strategy rotates into the next selected setup.\n\n`
    + `${TG_FOOTER}\n\n${DISC_PAPER}`;
}
function fmtPaperSell(o) {
  const sd = (n) => (n >= 0 ? "+$" : "-$") + Math.abs(n);   // signed dollars: -$0.65, +$0.65
  return `${o.win ? "🎯" : "🛑"} *PAPER SELL — ${o.symbol}*\n`
    + `${o.win ? "✅ TP1 HIT | Win" : "❌ STOP LOSS | Loss"}\n\n`
    + `💵 Bought: $${o.cost} @ ${fmtUsd(o.entry)}\n`
    + `${o.win ? "💰" : "💸"} Sold: ${fmtUsd(o.exit)}  (${o.movePct >= 0 ? "+" : ""}${o.movePct}%)\n`
    + `${o.win ? "📈 Profit" : "📉 Loss"}: *${sd(o.pnl)}*\n\n`
    + `🏦 Balance: *$${o.balance}*  ·  Realized: ${sd(o.realized)}\n`
    + `🔄 Rotating into the next best setup.\n\n`
    + `${TG_FOOTER}\n\n${DISC_PAPER}`;
}

// Does a signal qualify for the paper spot account? (good coin, high accuracy, tradeable now)
function paperEligible(s) {
  if (s.direction !== "LONG" || !s.entry || !s.targets) return false;        // SPOT = buy only
  if (s.confidence < TRACK_MIN_CONFIDENCE) return false;                     // top accuracy only (>=95%)
  if (s.entry.window === "CLOSED" || s.entry.window === "CHASE") return false; // still enterable
  if (s.liquidityUsd != null && s.liquidityUsd < settings.minTrackLiquidityUsd) return false;
  if (!s.quality || s.quality.score < 3) return false;                       // good coins only (Blue-chip / Solid)
  const eta = s.targets[0].etaMin;
  if (settings.paperMaxEtaMin > 0 && eta != null && eta > settings.paperMaxEtaMin) return false; // limited time
  return true;
}
// ROI-per-hour x accuracy: rewards fast, high-return, high-conviction setups so
// the account chases the highest ROI in the least time. Higher = better.
function paperScore(s) {
  const gain = s.targets[0].gainPct || 0;
  const etaMin = s.targets[0].etaMin;
  const etaH = etaMin && etaMin > 0 ? etaMin / 60 : 6;                       // unknown ETA -> treat as slow (6h)
  const velocity = gain / Math.max(0.1, etaH);                              // % gain per hour
  return velocity * (s.confidence / 100);
}
// Each scan: rank all eligible setups by ROI/time/accuracy and buy the BEST ones
// that free cash + open slots allow. This is the "highest ROI in limited time" core.
async function fillPaper(signals) {
  if (!settings.paperTrading) return;
  if (settings.regimeFilter && marketRegime.tier === "RISK_OFF") return;     // don't buy into a risk-off market
  const ranked = signals.filter(paperEligible).sort((a, b) => paperScore(b) - paperScore(a));
  for (const s of ranked) {
    if (await pstore.countOpen() >= settings.paperMaxOpen) break;            // portfolio full
    const acct = await paperAccount();
    if (acct.cash < 1) break;                                                // no cash to deploy
    if (await pstore.hasOpen(s.symbol)) continue;                            // already holding it
    await openPaper(s, Math.min(settings.paperPositionUsd, acct.cash)).catch((e) => console.warn("[paper]", e.message));
  }
}
// Buy one qualifying signal for `cost` dollars. (Ranking/eligibility done by fillPaper.)
async function openPaper(s, cost) {
  if (cost == null) { const a = await paperAccount(); cost = Math.min(settings.paperPositionUsd, a.cash); }
  if (cost < 1) return;
  const entry = s.priceUsd, tp1 = s.targets[0].priceUsd, stop = s.stop.priceUsd;
  const qty = cost / entry, eta1 = s.targets[0].etaMin ?? null;
  const id = await pstore.insert({ symbol: s.symbol, tf: s.tf, direction: "LONG", confidence: s.confidence, entry_price: entry, tp1, stop, cost_usd: round(cost, 2), qty: Number(qty.toPrecision(8)), quality: s.quality.tier, eta1_min: eta1, roi_score: round(paperScore(s), 3) });
  const etaTxt = eta1 != null ? ` · est TP1 by ${slClock(Date.now() + eta1 * 60000)} (~${s.targets[0].etaLabel})` : "";
  console.log(`[paper] BUY ${s.symbol} $${round(cost, 2)} (${qty.toPrecision(6)} @ ${entry}) TP1 ${tp1} stop ${stop}${etaTxt}`);
  const g1 = s.targets[0].gainPct, proj = round(cost * g1 / 100, 2);
  const riskPct = s.stop.riskPct, loss = round(cost * riskPct / 100, 2);
  const alloc = round((cost / Math.max(1, settings.capitalUsd)) * 100, 0);
  await tgBroadcast(fmtPaperBuy({
    symbol: s.symbol, quality: s.quality.tier, alloc, cost: round(cost, 2), qty: Number(qty.toPrecision(5)),
    entry, tp1, gainPct: g1, proj, stop, riskPct, loss,
    etaSL: eta1 != null ? slClock(Date.now() + eta1 * 60000) : null, etaLabel: s.targets[0].etaLabel,
  }));
  return id;
}
// Sell open paper positions at TP1 (profit) or the stop (loss); spot PnL on the
// amount invested. Freed cash is redeployed by the next scan (rotation).
async function managePaper(prices) {
  let open; try { open = await pstore.openTrades(); } catch (e) { return; }
  for (const t of open) {
    const P = prices.get(t.symbol);
    if (P == null) continue;
    const hitTp = P >= t.tp1, hitStop = P <= t.stop;
    if (!hitTp && !hitStop) continue;
    const exit = hitTp ? t.tp1 : t.stop;
    const movePct = (exit - t.entry_price) / t.entry_price * 100;            // spot, long-only
    const pnl = (Number(t.cost_usd) || 0) * movePct / 100;                   // profit on the $ invested
    const status = hitTp ? "WIN" : "LOSS";
    await pstore.close(t.id, { status, exit_price: rp(exit), exit_reason: hitTp ? "TP1" : "STOP", pnl_usd: round(pnl, 2), pnl_pct: round(movePct, 2), closed_at: new Date() });
    const acct = await paperAccount();
    console.log(`[paper] SELL ${t.symbol} ${status} PnL $${pnl.toFixed(2)} → cash $${acct.cash} (equity building)`);
    await tgBroadcast(fmtPaperSell({
      symbol: t.symbol, win: hitTp, cost: t.cost_usd, entry: t.entry_price, exit, movePct: round(movePct, 2),
      pnl: round(pnl, 2), balance: round(settings.capitalUsd + acct.realized, 2), realized: acct.realized,
    }));
  }
}

// ===========================================================================
// Express
// ===========================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error("[api]", e.message); res.status(e.statusCode || 500).json({ error: e.message }); });

// Forex Bot module (OANDA) - mounted under /api/forex, uses the same pool/DB.
const forex = createForex({ http, pool, useDb: () => useDb, round });
app.use("/api/forex", forex.router);

app.get("/api/health", (_req, res) => res.json({ status: "ok", source: ACTIVE?.name || null, durable: useDb, dbError }));
app.get("/api/config", (_req, res) => res.json({ quote: QUOTE, universeSize: UNIVERSE_SIZE, tf: SIGNAL_TF, timeframes: TIMEFRAMES, minConfidence: MIN_CONFIDENCE, trackMinConfidence: TRACK_MIN_CONFIDENCE, source: ACTIVE?.name || null, durable: useDb, dbError, scanIntervalSec: SCAN_INTERVAL_SEC, indicatorRefreshSec: INDICATOR_REFRESH_SEC }));

app.get("/api/signals", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  touchTf(tf); // whatever timeframe you view also gets scanned + tracked
  const data = await scanMarket(tf);
  let signals = data.signals;
  if (req.query.only === "actionable") signals = signals.filter((s) => s.direction !== "NEUTRAL" && !s.error);
  if (req.query.dir === "LONG" || req.query.dir === "SHORT") signals = signals.filter((s) => s.direction === req.query.dir);
  if (req.query.limit) signals = signals.slice(0, Number(req.query.limit));
  // Stamp each actionable card with its live tracking outcome (status + TP hits + open R).
  const [tidx, prices] = await Promise.all([trackedIndex().catch(() => new Map()), getTickerMap().catch(() => new Map())]);
  signals = signals.map((s) => {
    if (s.direction !== "LONG" && s.direction !== "SHORT") return s;
    const t = tidx.get(`${s.symbol}|${s.tf}|${s.direction}`);
    if (!t) return s;
    const P = prices.get(s.symbol);
    let openR = null;
    if (P != null && t.entry_mid != null && t.stop != null && (t.status === "ACTIVE" || t.status === "WAITING")) openR = round((s.direction === "LONG" ? P - t.entry_mid : t.entry_mid - P) / Math.abs(t.entry_mid - t.stop), 2);
    return { ...s, tracked: { status: t.status, tp1_hit: !!t.tp1_hit, tp2_hit: !!t.tp2_hit, tp3_hit: !!t.tp3_hit, result_r: t.result_r ?? null, openR, since: t.created_at } };
  });
  res.json({ ...data, signals });
}));

app.get("/api/signal/:symbol", wrap(async (req, res) => { const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF; const fx = await getUsdLkr(); res.json(await signalFor(req.params.symbol.toUpperCase().replace(QUOTE, ""), tf, fx)); }));

// Full analysis for one coin: the signal on the chosen TF (with higher-TF
// confluence applied), a per-timeframe agreement snapshot, and a backtest.
app.get("/api/analysis/:symbol", wrap(async (req, res) => {
  const base = req.params.symbol.toUpperCase().replace(QUOTE, "");
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  const fx = await getUsdLkr();
  // Load each timeframe once, reuse for both the snapshot and the main signal.
  const perTf = {};
  const cache = {};
  for (const t of TIMEFRAMES) {
    const s = await signalFor(base, t, fx);
    cache[t] = s;
    perTf[t] = s.error ? { error: s.error } : { direction: s.direction, confidence: s.confidence, price: s.priceUsd, adx: s.indicators?.adx };
  }
  // Recompute the requested TF with higher-TF confluence for the headline signal.
  const htf = HTF_OF[tf];
  let signal = cache[tf];
  if (htf && perTf[htf] && !perTf[htf].error && signal && !signal.error) {
    const d = await getOHLCV(base, tf, 210);
    if (d) signal = computeSignal(base, tf, d, fx, { htf, htfDir: perTf[htf].direction });
  }
  // Attach coin quality (liquidity + volatility) to the headline signal.
  if (signal && !signal.error) {
    const tick = (await fetchTickers().catch(() => [])).find((t) => t.base === base);
    if (tick) { signal.liquidityUsd = Math.round(tick.quoteVolume || 0); signal.quality = qualityTier(tick.quoteVolume, signal.indicators?.atrPct); }
  }
  // Agreement score across timeframes.
  const dirs = Object.values(perTf).filter((p) => !p.error).map((p) => p.direction);
  const longs = dirs.filter((x) => x === "LONG").length, shorts = dirs.filter((x) => x === "SHORT").length;
  const consensus = longs > shorts && longs >= 2 ? "LONG" : shorts > longs && shorts >= 2 ? "SHORT" : "MIXED";
  const bt = await backtest(base, tf).catch(() => null);
  res.json({ symbol: base, tf, htf, signal, perTimeframe: perTf, consensus, agree: { long: longs, short: shorts, total: dirs.length }, backtest: bt, generatedAt: new Date().toISOString() });
}));

// OHLC candles for charting (Lightweight Charts). time in seconds.
app.get("/api/candles/:symbol", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  const base = req.params.symbol.toUpperCase().replace(QUOTE, "");
  const limit = Math.min(500, Math.max(50, Number(req.query.limit) || 240));
  const d = await getOHLCV(base, tf, limit);
  if (!d || !d.times) { res.status(404).json({ error: "no candles" }); return; }
  const candles = d.times.map((t, i) => ({ time: Math.floor(t / 1000), open: d.opens[i], high: d.highs[i], low: d.lows[i], close: d.closes[i], volume: d.volumes[i] })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));
  res.json({ symbol: base, tf, candles });
}));
app.post("/api/rescan", wrap(async (req, res) => { const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF; delete scanCache[tf]; res.json(await scanMarket(tf)); }));

app.get("/api/backtest/:symbol", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  res.json(await backtest(req.params.symbol.toUpperCase().replace(QUOTE, ""), tf, Number(req.query.bars) || 1000));
}));

// --- Settings & Binance Spot Testnet trading ---
const settingsView = () => ({ configured: tnConfigured(), keyMasked: maskKey(settings.apiKey), autoTrade: settings.autoTrade, tradeUsd: settings.tradeUsd, qualityOnly: settings.qualityOnly, holdThroughDips: settings.holdThroughDips, regimeFilter: settings.regimeFilter, exitStyle: settings.exitStyle, minTrackLiquidityUsd: settings.minTrackLiquidityUsd, tgApproval: settings.tgApproval, positionUsd: settings.positionUsd, leverage: settings.leverage, capitalUsd: settings.capitalUsd, telegramReady: !!bot && chats.size > 0, telegramTokenSet: !!process.env.TELEGRAM_BOT_TOKEN, telegramBotOn: !!bot, telegramChats: chats.size, paperTrading: settings.paperTrading, paperMaxOpen: settings.paperMaxOpen, paperPositionUsd: settings.paperPositionUsd, paperGoalUsd: settings.paperGoalUsd, paperMaxEtaMin: settings.paperMaxEtaMin, trackMinConfidence: TRACK_MIN_CONFIDENCE, quote: QUOTE, testnetBase: settings.testnetBase, proxySet: !!settings.proxyUrl, proxyTestnet: settings.proxyTestnet, lastError: lastTnError, durableSettings: useDb });
app.get("/api/settings", wrap(async (_req, res) => res.json(settingsView())));
app.post("/api/settings", wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.apiKey === "string" && b.apiKey.trim()) settings.apiKey = b.apiKey.trim();
  if (typeof b.apiSecret === "string" && b.apiSecret.trim()) settings.apiSecret = b.apiSecret.trim();
  if (typeof b.autoTrade === "boolean") settings.autoTrade = b.autoTrade;
  if (typeof b.qualityOnly === "boolean") settings.qualityOnly = b.qualityOnly;
  if (typeof b.holdThroughDips === "boolean") settings.holdThroughDips = b.holdThroughDips;
  if (typeof b.regimeFilter === "boolean") settings.regimeFilter = b.regimeFilter;
  if (b.exitStyle === "tp1" || b.exitStyle === "scaleout") settings.exitStyle = b.exitStyle;
  if (typeof b.tgApproval === "boolean") settings.tgApproval = b.tgApproval;
  if (b.positionUsd != null && Number.isFinite(+b.positionUsd)) settings.positionUsd = Math.max(1, +b.positionUsd);
  if (b.leverage != null && Number.isFinite(+b.leverage)) settings.leverage = Math.min(125, Math.max(1, +b.leverage));
  if (b.capitalUsd != null && Number.isFinite(+b.capitalUsd)) settings.capitalUsd = Math.max(1, +b.capitalUsd);
  if (b.minTrackLiquidityUsd != null && Number.isFinite(+b.minTrackLiquidityUsd)) settings.minTrackLiquidityUsd = Math.max(0, +b.minTrackLiquidityUsd);
  if (b.tradeUsd != null && Number.isFinite(+b.tradeUsd)) settings.tradeUsd = Math.max(10, +b.tradeUsd);
  if (typeof b.testnetBase === "string") settings.testnetBase = b.testnetBase.trim() || "https://testnet.binance.vision";
  if (typeof b.proxyUrl === "string") settings.proxyUrl = normalizeProxy(b.proxyUrl); // accepts Webshare host:port:user:pass too
  if (typeof b.proxyTestnet === "boolean") settings.proxyTestnet = b.proxyTestnet;
  if (typeof b.paperTrading === "boolean") settings.paperTrading = b.paperTrading;
  if (b.paperMaxOpen != null && Number.isFinite(+b.paperMaxOpen)) settings.paperMaxOpen = Math.max(1, Math.min(20, Math.round(+b.paperMaxOpen)));
  if (b.paperPositionUsd != null && Number.isFinite(+b.paperPositionUsd)) settings.paperPositionUsd = Math.max(1, +b.paperPositionUsd);
  if (b.paperGoalUsd != null && Number.isFinite(+b.paperGoalUsd)) settings.paperGoalUsd = Math.max(1, +b.paperGoalUsd);
  if (b.paperMaxEtaMin != null && Number.isFinite(+b.paperMaxEtaMin)) settings.paperMaxEtaMin = Math.max(0, Math.round(+b.paperMaxEtaMin));
  if (b.clearKeys === true) { settings.apiKey = ""; settings.apiSecret = ""; settings.autoTrade = false; }
  lastTnError = null;
  await saveSettings();
  res.json(settingsView()); // never returns the secret
}));
// Verify the keys against the testnet and report tradeable USDT balance.
app.post("/api/settings/test", wrap(async (_req, res) => {
  if (!tnConfigured()) { res.status(400).json({ ok: false, error: "Enter your Testnet API key and secret first." }); return; }
  try {
    const a = await tnAccount();
    const usdt = (a.balances || []).find((x) => x.asset === QUOTE);
    lastTnError = null;
    res.json({ ok: true, canTrade: a.canTrade !== false, usdtFree: usdt ? +usdt.free : 0, accountType: a.accountType });
  } catch (e) { lastTnError = niceTnError(e); res.status(400).json({ ok: false, error: lastTnError }); }
}));
// Test one or many proxies against REAL Binance endpoints, so you can paste all
// 10 (URL or Webshare host:port:user:pass) and see which actually get past the
// geo-block - without saving. Reports data + testnet reachability and exit IP.
app.post("/api/proxy/test", wrap(async (req, res) => {
  const list = Array.isArray(req.body?.proxies) ? req.body.proxies
    : String(req.body?.proxies || req.body?.proxyUrl || "").split(/\r?\n/);
  const proxies = list.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  if (!proxies.length) { res.status(400).json({ ok: false, error: "Paste at least one proxy (one per line)." }); return; }
  const testOne = async (raw) => {
    const url = normalizeProxy(raw);
    const cfg = proxyCfg(url);
    if (!cfg.proxy) return { proxy: raw, ok: false, error: "unparseable proxy line" };
    const out = { proxy: raw, host: cfg.proxy.host, port: cfg.proxy.port, data: null, testnet: null, exitIp: null, exitCc: null, ms: null };
    const t0 = Date.now();
    // 1) Can we read Binance MARKET DATA through it? (this is what the scanner needs)
    try { await http.get("https://data-api.binance.vision/api/v3/ticker/price", { params: { symbol: "BTC" + QUOTE }, timeout: 12000, ...cfg }); out.data = "ok"; }
    catch (e) { out.data = "fail: " + niceTnError(e); }
    // 2) Can we reach the TESTNET host through it? (this is what trading needs)
    try { await http.get(settings.testnetBase + "/api/v3/ping", { timeout: 12000, ...cfg }); out.testnet = "ok"; }
    catch (e) { out.testnet = "fail: " + niceTnError(e); }
    // 3) Where does the proxy exit? (region matters for Binance)
    try { const r = await http.get("http://ip-api.com/json", { timeout: 8000, ...cfg }); out.exitIp = r.data?.query || null; out.exitCc = r.data?.countryCode || null; }
    catch (e) { /* non-fatal */ }
    out.ms = Date.now() - t0;
    out.ok = out.data === "ok"; // "working" = the scanner can get data
    return out;
  };
  const results = [];
  for (const p of proxies) results.push(await testOne(p)); // sequential: gentle on the target
  const working = results.filter((r) => r.ok);
  res.json({ ok: true, count: results.length, workingCount: working.length, results });
}));
app.get("/api/testnet/trades", wrap(async (_req, res) => {
  const rows = await tstore.all(100);
  const open = rows.filter((t) => t.status === "OPEN");
  const closed = rows.filter((t) => t.status === "CLOSED");
  const pnl = closed.reduce((a, t) => a + (Number.isFinite(+t.pnl_usd) ? +t.pnl_usd : 0), 0);
  const wins = closed.filter((t) => +t.pnl_usd > 0).length;
  res.json({ configured: tnConfigured(), autoTrade: settings.autoTrade, tradeUsd: settings.tradeUsd, open, recent: closed.slice(0, 40), totalPnlUsd: round(pnl, 2), closed: closed.length, wins, losses: closed.length - wins });
}));
// Built-in paper SPOT trading: cash account + open holdings + closed trades.
app.get("/api/paper/trades", wrap(async (_req, res) => {
  const prices = await getTickerMap().catch(() => new Map());
  const rows = await pstore.all(200);
  const open = rows.filter((t) => t.status === "OPEN").map((t) => {
    const P = prices.get(t.symbol);
    const mktValue = P != null ? (Number(t.qty) || 0) * P : null;            // what the holding is worth now
    const uPnl = mktValue != null ? mktValue - (Number(t.cost_usd) || 0) : null;
    const movePct = P != null ? (P - t.entry_price) / t.entry_price * 100 : null;
    // Estimated profit if this position reaches TP1 (spot: % move x amount invested).
    const tp1Pct = (t.tp1 - t.entry_price) / t.entry_price * 100;
    const tp1ProfitUsd = round((Number(t.cost_usd) || 0) * tp1Pct / 100, 2);
    // Estimated TP1 time in Sri Lanka time = opened_at + the TP1 ETA.
    const openedMs = new Date(t.opened_at).getTime();
    const etaTp1SL = t.eta1_min != null ? slClock(openedMs + t.eta1_min * 60000) : null;
    const etaLeftMin = t.eta1_min != null ? Math.round((openedMs + t.eta1_min * 60000 - Date.now()) / 60000) : null;
    return { ...t, livePrice: P ?? null, marketValueUsd: mktValue == null ? null : round(mktValue, 2), unrealizedUsd: uPnl == null ? null : round(uPnl, 2), unrealizedPct: movePct == null ? null : round(movePct, 2), tp1Pct: round(tp1Pct, 2), tp1ProfitUsd, etaTp1SL, etaLeftMin };
  });
  const closed = rows.filter((t) => t.status === "WIN" || t.status === "LOSS");
  const a = await paperAccount();
  const holdingsValue = open.reduce((acc, t) => acc + (t.marketValueUsd != null ? t.marketValueUsd : (Number(t.cost_usd) || 0)), 0);
  const equity = a.cash + holdingsValue;                                     // cash + live value of coins held
  const wr = closed.length ? round((a.wins / closed.length) * 100, 1) : null;
  const goal = settings.paperGoalUsd, goalPct = goal > 0 ? round((a.realized / goal) * 100, 0) : null;
  res.json({ enabled: settings.paperTrading, startUsd: a.start, cashUsd: a.cash, investedUsd: a.invested, holdingsValueUsd: round(holdingsValue, 2), equityUsd: round(equity, 2), realizedUsd: a.realized, unrealizedUsd: round(holdingsValue - a.invested, 2), maxOpen: settings.paperMaxOpen, positionUsd: settings.paperPositionUsd, goalUsd: goal, goalPct, maxEtaMin: settings.paperMaxEtaMin, open, recent: closed.slice(0, 50), closed: closed.length, wins: a.wins, losses: a.losses, winRatePct: wr });
}));
app.post("/api/paper/reset", wrap(async (_req, res) => { await pstore.reset(); res.json({ ok: true }); }));

app.get("/api/regime", wrap(async (_req, res) => res.json(marketRegime)));
app.get("/api/stats", wrap(async (_req, res) => res.json(await computeStats())));
app.get("/api/tracked", wrap(async (_req, res) => {
  const prices = await getTickerMap().catch(() => new Map());
  // Only high-conviction, currently-scanned setups appear in the track record.
  const rows = (await store.recent(200)).filter((t) => TIMEFRAMES.includes(t.tf) && (t.confidence == null || t.confidence >= TRACK_MIN_CONFIDENCE));
  const withLive = rows.map((t) => {
    const P = prices.get(t.symbol);
    let rr = null;
    if (P != null && (t.status === "ACTIVE" || t.status === "WAITING")) rr = round((t.direction === "LONG" ? P - t.entry_mid : t.entry_mid - P) / Math.abs(t.entry_mid - t.stop), 2);
    return { ...t, currentPrice: P ?? null, openR: rr };
  });
  res.json({ open: withLive.filter((t) => t.status === "WAITING" || t.status === "ACTIVE"), recent: withLive.filter((t) => t.status !== "WAITING" && t.status !== "ACTIVE").slice(0, 60) });
}));

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ===========================================================================
// Telegram (optional)
// ===========================================================================
let bot = null;
const chats = new Set();
if (process.env.TELEGRAM_CHAT_ID) chats.add(String(process.env.TELEGRAM_CHAT_ID));
const fmtUsd = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });

// --- Ask-before-you-trade: propose each high-conviction setup on Telegram, wait
// for a tap, then track it and alert you at TP1 with the profit. ---
const proposals = new Map();  // key symbol|tf|dir -> plan {profit, loss, pos, gain1, ...}
const approved = new Map();   // approved trades pending a TP1 alert
const proposedAt = new Map(); // cooldown per key
const PROPOSE_COOLDOWN = 3 * 3600_000;
const TF_LABEL = { "15m": "15-min", "1h": "1-Hour", "4h": "4-Hour", "1d": "Daily" };
function slNow() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 16) + " SL"; }
const WIN_LINE = { OPEN: "✅ *ENTER NOW* — price is in the zone", WAIT: "⏳ Wait for a pullback into the zone", CHASE: "⚠️ Extended — only on a small pullback", CLOSED: "⛔ Missed — wait for the next setup" };
// Shared, consistent footer + disclaimers so every message reads the same way.
const TG_FOOTER = "📊 _Trade smart. Manage risk. Follow the system._";
const DISC_PAPER = "⚠️ _Paper trade for demonstration purposes. Crypto markets are volatile; no profit is guaranteed._";
const DISC_SIGNAL = "⚠️ _Not financial advice. Crypto markets are volatile — manage your risk._";
// A clean, structured signal card for Telegram, with leverage profit/loss projections.
function fmtSignalCard(s) {
  const long = s.direction === "LONG";
  const dot = long ? "🟢" : "🔴";
  const pos = settings.positionUsd, lev = Math.max(1, settings.leverage), notional = pos * lev;
  const proj = (pct) => round((notional * pct) / 100, 2); // $ move on the leveraged notional
  const tvLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${s.symbol}${QUOTE}`;
  const tps = s.targets.map((t, i) => ` ${i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"} TP${i + 1}  ${fmtUsd(t.priceUsd)}  (+${t.gainPct}%)  ~${t.etaLabel} → *+$${proj(t.gainPct)}*`).join("\n");
  const liqPct = round(100 / lev, 1);
  return `${dot} *${s.direction} SIGNAL — ${s.symbol}/${QUOTE}*\n`
    + `💎 ${s.quality?.tier || "-"} | ${TF_LABEL[s.tf] || s.tf} | ${s.confidence}%  ·  ${marketRegime.tier}\n`
    + `🕐 Fresh as of ${slNow()} · now ${fmtUsd(s.priceUsd)}\n`
    + `${(WIN_LINE[s.entry.window] || "")}\n\n`
    + `📍 *ENTRY ZONE:* ${fmtUsd(s.entry.low)} – ${fmtUsd(s.entry.high)}\n\n`
    + `🎯 *TAKE PROFIT*  _(on $${pos} at ${lev}x = $${notional})_\n${tps}\n\n`
    + `🛑 *STOP LOSS:* ${fmtUsd(s.stop.priceUsd)}\n`
    + `📉 Risk: -${s.stop.riskPct}% → *-$${proj(s.stop.riskPct)}*\n\n`
    + `⚠️ At ${lev}x, a ~${liqPct}% move against you = liquidation (the stop is tighter).\n`
    + `✅ *Why:* ${(s.reasons || []).slice(0, 4).join(", ")}\n`
    + `[📈 Open chart](${tvLink})\n\n`
    + `${TG_FOOTER}\n\n${DISC_SIGNAL}`;
}
// One-line compact row for the /signals list (mirrors a website signal card).
function fmtSignalRow(s) {
  const dot = s.direction === "LONG" ? "🟢" : "🔴";
  const win = s.entry.window === "OPEN" ? "✅ now" : s.entry.window === "WAIT" ? "⏳ wait" : s.entry.window === "CHASE" ? "⚠️ extended" : "⛔ missed";
  const prof = round((settings.positionUsd * Math.max(1, settings.leverage) * s.targets[0].gainPct) / 100, 2);
  return `${dot} *${s.symbol}* ${s.direction} · ${s.confidence}% · ${win}\n`
    + `   ${TF_LABEL[s.tf] || s.tf} · Entry ${fmtUsd(s.entry.low)}–${fmtUsd(s.entry.high)} · TP1 *+$${prof}* · /signal ${s.symbol}`;
}
// The command timeframe (changed with /tf). Starts at the engine's main timeframe.
let cmdTf = SIGNAL_TF;
// High-conviction, still-actionable signals for the Telegram commands. freshOnly =
// only OPEN (enter right now); otherwise OPEN + WAIT (a pullback entry is coming).
async function tgSignals(tf, { freshOnly = false, minConf = TRACK_MIN_CONFIDENCE, limit = 8 } = {}) {
  const { signals } = await scanMarket(tf);
  return signals.filter((s) => {
    if (s.error || s.direction === "NEUTRAL" || !s.entry || !s.targets) return false;
    if (s.confidence < minConf) return false;
    if (s.liquidityUsd != null && s.liquidityUsd < settings.minTrackLiquidityUsd) return false;
    if (freshOnly) return s.entry.window === "OPEN";
    return s.entry.window === "OPEN" || s.entry.window === "WAIT";
  }).slice(0, limit);
}
const TG_HELP = "📡 *Signal Engine — commands*\n\n"
  + "/signals – top high-accuracy setups you can still enter\n"
  + "/fresh – only the ones to *enter right now*\n"
  + "/signal `SYMBOL` – full card for one coin (e.g. /signal BTC)\n"
  + "/tf `15m|1h|4h|1d` – change the timeframe (now: " + "%TF%" + ")\n"
  + "/stats – track record (win rate)\n"
  + "/help – this list\n\n"
  + "_Only ≥95% setups reach here — the same bar as the Track Record. Every card shows the entry ZONE (a range), so a small move while you read it still lets you get in._";
async function proposeTrade(s) {
  if (!settings.tgApproval || !bot || chats.size === 0) return;
  if (s.direction !== "LONG" && s.direction !== "SHORT") return;
  // FRESHNESS: you trade these by hand, so never propose one you're already late for.
  // OPEN = enter now, WAIT = a pullback is coming (you have time). CHASE/CLOSED = missed.
  if (s.entry.window === "CLOSED" || s.entry.window === "CHASE") return;
  if (settings.regimeFilter && marketRegime.tier === "RISK_OFF" && s.direction === "LONG") return; // don't propose longs when risk-off
  const key = `${s.symbol}|${s.tf}|${s.direction}`;
  if (Date.now() - (proposedAt.get(key) || 0) < PROPOSE_COOLDOWN) return;
  proposedAt.set(key, Date.now());
  const pos = settings.positionUsd, lev = Math.max(1, settings.leverage);
  const gain1 = s.targets[0].gainPct, profit = round((pos * lev * gain1) / 100, 2), loss = round((pos * lev * s.stop.riskPct) / 100, 2);
  const text = fmtSignalCard(s) + `\n\n*Take this trade?*`;
  const kb = { inline_keyboard: [[{ text: `✅ Take $${pos} (${lev}x)`, callback_data: `take|${key}` }, { text: "❌ Skip", callback_data: `skip|${key}` }]] };
  proposals.set(key, { symbol: s.symbol, tf: s.tf, direction: s.direction, entry: s.entry.mid, tp1: s.targets[0].priceUsd, gain1, pos, lev, profit, loss });
  for (const id of chats) bot.sendMessage(id, text, { parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
}
async function maybeAlertTp1(row, upd) {
  if (!bot) return;
  const key = `${row.symbol}|${row.tf}|${row.direction}`;
  const a = approved.get(key);
  if (!a || a.alerted) return;
  if (!(upd.tp1_hit || upd.status === "WIN")) return;
  a.alerted = true;
  const msg = `🎯 *TP1 HIT — ${row.symbol}*\n`
    + `✅ Target reached | Win\n\n`
    + `🪙 Entry: ${fmtUsd(row.entry_mid)}\n`
    + `💰 TP1: ${fmtUsd(row.tp1)} (+${a.gain1}%)\n`
    + `📈 Profit: *+$${a.profit}* on $${a.pos} at ${a.lev || settings.leverage}x\n\n`
    + `Closed at TP1 as planned.\n\n`
    + `${TG_FOOTER}\n\n${DISC_SIGNAL}`;
  bot.sendMessage(a.chatId, msg, { parse_mode: "Markdown" }).catch(() => {});
}
function startTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.log("[telegram] disabled"); return; }
  try {
    const TelegramBot = require("node-telegram-bot-api");
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    bot.on("message", (m) => { const had = chats.has(String(m.chat.id)); chats.add(String(m.chat.id)); if (!had) saveChats(); }); // remember new chats durably
    // Inline Take / Skip buttons on trade proposals.
    bot.on("callback_query", async (cq) => {
      try {
        const i = (cq.data || "").indexOf("|"); const action = cq.data.slice(0, i), key = cq.data.slice(i + 1);
        const chatId = cq.message.chat.id, plan = proposals.get(key);
        if (action === "take" && plan) {
          approved.set(key, { ...plan, chatId, alerted: false, at: Date.now() });
          // Approval IS the go-ahead: place the testnet buy if keys are set (even if auto-trade is off).
          if (tnConfigured()) { const scan = scanCache[plan.tf]?.data; const sig = scan?.signals.find((x) => x.symbol === plan.symbol && x.direction === plan.direction); if (sig && sig.direction === "LONG") { const savedAuto = settings.autoTrade; settings.autoTrade = true; await maybeAutoTrade(sig).catch(() => {}); settings.autoTrade = savedAuto; } }
          await bot.answerCallbackQuery(cq.id, { text: "Taking the trade ✅" }).catch(() => {});
          await bot.editMessageText(cq.message.text + `\n\n✅ TAKEN — I'll message you when TP1 hits (+$${plan.profit}).`, { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
        } else if (action === "skip") {
          proposals.delete(key);
          await bot.answerCallbackQuery(cq.id, { text: "Skipped" }).catch(() => {});
          await bot.editMessageText(cq.message.text + "\n\n❌ SKIPPED.", { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
        } else { await bot.answerCallbackQuery(cq.id, { text: "This idea expired." }).catch(() => {}); }
      } catch (e) { console.warn("[telegram cb]", e.message); }
    });
    const help = () => TG_HELP.replace("%TF%", TF_LABEL[cmdTf] || cmdTf);
    bot.onText(/^\/help\b/, (m) => bot.sendMessage(m.chat.id, help(), { parse_mode: "Markdown" }));
    bot.onText(/^\/start\b/, (m) => {
      chats.add(String(m.chat.id)); saveChats();
      bot.sendMessage(m.chat.id, `✅ *Linked!* This chat will now get signals 24/7.\nYour chat id: \`${m.chat.id}\`  (save it as TELEGRAM_CHAT_ID so it survives redeploys)\n\n` + help(), { parse_mode: "Markdown" });
    });
    // /signals — compact, website-style list of setups you can still enter (OPEN + WAIT).
    bot.onText(/^\/signals\b/, async (m) => {
      try {
        const top = await tgSignals(cmdTf);
        const body = top.length
          ? `📡 *Signals* · ${TF_LABEL[cmdTf] || cmdTf} · ${slNow()}\n_≥95% only · ✅ now / ⏳ wait for pullback_\n\n` + top.map(fmtSignalRow).join("\n\n") + `\n\n_Tap /signal SYMBOL for the full card._`
          : `No high-accuracy ${TF_LABEL[cmdTf] || cmdTf} setups you can enter right now. Try /tf 1h or check back soon.`;
        bot.sendMessage(m.chat.id, body, { parse_mode: "Markdown", disable_web_page_preview: true });
      } catch (e) { bot.sendMessage(m.chat.id, "Couldn't scan just now — try again in a moment."); }
    });
    // /fresh — only the ones to ENTER RIGHT NOW, as full cards (freshness-first).
    bot.onText(/^\/fresh\b/, async (m) => {
      try {
        const top = await tgSignals(cmdTf, { freshOnly: true, limit: 4 });
        if (!top.length) return bot.sendMessage(m.chat.id, `Nothing to enter *right now* on ${TF_LABEL[cmdTf] || cmdTf}. When a signal is in its zone I'll list it here (and message you if approvals are on).`, { parse_mode: "Markdown" });
        bot.sendMessage(m.chat.id, `⚡ *Enter-now setups* · ${slNow()}`, { parse_mode: "Markdown" });
        for (const s of top) await bot.sendMessage(m.chat.id, fmtSignalCard(s), { parse_mode: "Markdown", disable_web_page_preview: true }).catch(() => {});
      } catch (e) { bot.sendMessage(m.chat.id, "Couldn't scan just now — try again in a moment."); }
    });
    // /signal SYMBOL — full card for one coin (any confidence, so you can look one up).
    // (Plural /signals is handled above; this only matches "/signal" then an optional symbol.)
    bot.onText(/^\/signal(?:@\w+)?(?:\s+(\S+))?\s*$/, async (m, mt) => {
      try {
        if (!mt[1]) return bot.sendMessage(m.chat.id, "Usage: /signal SYMBOL  (e.g. /signal BTC). For the full list: /signals");
        const base = mt[1].toUpperCase().replace(/USDT$/, "");
        const { signals } = await scanMarket(cmdTf);
        const s = signals.find((x) => (x.base || x.symbol) === base || x.symbol === base);
        if (!s || s.error || !s.entry || !s.targets) return bot.sendMessage(m.chat.id, `No ${base} setup on ${TF_LABEL[cmdTf] || cmdTf} right now (it may not be in the scanned universe, or it's NEUTRAL).`);
        bot.sendMessage(m.chat.id, fmtSignalCard(s), { parse_mode: "Markdown", disable_web_page_preview: true });
      } catch (e) { bot.sendMessage(m.chat.id, "Couldn't fetch that one — try again in a moment."); }
    });
    // /tf 1h — change the timeframe used by the commands above.
    bot.onText(/^\/tf(?:\s+(\S+))?/, (m, mt) => {
      const want = (mt[1] || "").toLowerCase();
      if (!want) return bot.sendMessage(m.chat.id, `Timeframe is *${TF_LABEL[cmdTf] || cmdTf}*. Change it: /tf 15m · /tf 1h · /tf 4h · /tf 1d`, { parse_mode: "Markdown" });
      if (!TF_MINUTES[want]) return bot.sendMessage(m.chat.id, "Use one of: 15m, 1h, 4h, 1d");
      cmdTf = want; touchTf(want);
      bot.sendMessage(m.chat.id, `✅ Timeframe set to *${TF_LABEL[cmdTf] || cmdTf}*. Try /signals`, { parse_mode: "Markdown" });
    });
    bot.onText(/^\/stats\b/, async (m) => { const s = await computeStats(); bot.sendMessage(m.chat.id, `📈 *Track record*\nWin rate: ${s.winRatePct ?? "-"}% (${s.wins}/${s.decided})\nTP1 ${s.tp1RatePct ?? "-"}% · TP2 ${s.tp2RatePct ?? "-"}% · TP3 ${s.tp3RatePct ?? "-"}%\nAvg R: ${s.avgResultR ?? "-"} · Open: ${s.open}${s.durable ? "" : "\n(in-memory - set DATABASE_URL to persist)"}`, { parse_mode: "Markdown" }); });
    bot.on("polling_error", (e) => console.warn("[telegram]", e.message));
    console.log("[telegram] started");
  } catch (e) { console.warn("[telegram] failed:", e.message); }
}
async function signalAlerts() {
  if (!bot || chats.size === 0) return;
  if (settings.tgApproval) return; // approval mode already sends the (button) cards from the scan loop
  const { signals } = await scanMarket(SIGNAL_TF);
  for (const s of signals) {
    // Only HIGH-ACCURACY setups (>=95%, same bar as the Track Record) reach Telegram.
    if (s.error || s.direction === "NEUTRAL" || !s.entry || !s.targets || s.confidence < TRACK_MIN_CONFIDENCE) continue;
    // Only push a signal you can still act on. Skip anything the price already ran past.
    if (s.entry.window === "CLOSED" || s.entry.window === "CHASE") continue;
    if (s.liquidityUsd != null && s.liquidityUsd < settings.minTrackLiquidityUsd) continue;
    if (settings.regimeFilter && marketRegime.tier === "RISK_OFF" && s.direction === "LONG") continue;
    const key = `${s.symbol}:${s.direction}`;
    if (Date.now() - (alerted.get(key) || 0) < 6 * 3600_000) continue;
    alerted.set(key, Date.now());
    for (const id of chats) bot.sendMessage(id, fmtSignalCard(s), { parse_mode: "Markdown" }).catch(() => {});
  }
}
const alerted = new Map();

// ===========================================================================
// Boot
// ===========================================================================
let liveBusy = false;
let indBusy = false;
async function liveTick() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    const prices = await getTickerMap(); // one request for the whole market
    updateLivePrices(prices);
    await monitor(prices); // catch TP/SL hits near-instantly
    await manageTestnet(prices); // close testnet trades at TP1/stop
    await managePaper(prices);   // close paper trades at TP1/stop (simulated)
  } catch (e) { console.warn("[live]", e.message); } finally { liveBusy = false; }
}
async function indicatorTick() {
  if (indBusy) return;
  indBusy = true;
  try {
    for (const tf of currentTfs()) { // scan + track every timeframe in use
      const data = await scanMarket(tf, true);
      await openFrom(data);
    }
  } catch (e) { console.warn("[indicators]", e.message); } finally { indBusy = false; }
}
function startLoops() {
  setInterval(liveTick, SCAN_INTERVAL_SEC * 1000);            // prices + hits every ~5s (1 request)
  setInterval(indicatorTick, INDICATOR_REFRESH_SEC * 1000);   // full indicator rescan periodically
  cron.schedule("*/15 * * * *", () => signalAlerts().catch((e) => console.warn("[cron alert]", e.message)));
  console.log(`[loop] live prices/monitor every ${SCAN_INTERVAL_SEC}s · indicators every ${INDICATOR_REFRESH_SEC}s`);
}
async function boot() {
  try { await initStore(); } catch (e) { console.error("[store] init failed:", e.message); }
  await loadSettings().catch(() => {});
  await loadChats().catch(() => {}); // restore Telegram chats so /start survives redeploys
  if (tnConfigured()) console.log(`[testnet] keys loaded (auto-trade ${settings.autoTrade ? "ON" : "off"}, $${settings.tradeUsd}/trade)`);
  app.listen(PORT, () => console.log(`[server] signals on ${PORT}`));
  startTelegram();
  startLoops();
  detectSource().then(() => indicatorTick()).catch((e) => console.warn("[boot]", e.message));
}
if (require.main === module) boot();

module.exports = app;
module.exports._test = { ema, sma, rsi, macd, bollinger, atr, vwap, mfi, adx, stochRsi, cci, williamsR, obv, psar, candlePatterns, computeSignal, humanizeEta, advance, backtest, fmtSignalCard, fmtSignalRow, fmtPaperBuy, fmtPaperSell, openPaper, managePaper, paperAccount, paperScore, paperEligible, fillPaper, pstore, settings };
