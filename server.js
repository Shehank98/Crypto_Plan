/**
 * Crypto Scalping Signal Engine — signals + live outcome tracking.
 *
 * - Scans the top-N most-liquid markets across whichever exchange is reachable
 *   (Binance -> Bybit -> OKX, Coinbase per-coin fallback) — a minimal ccxt-style
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
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const QUOTE = (process.env.QUOTE || "USDT").toUpperCase();
const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE || 60);
const SIGNAL_TF = process.env.SIGNAL_TF || "1h";
const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const MIN_CONFIDENCE = Number(process.env.SIGNAL_MIN_CONFIDENCE || 45);
const TRACK_MIN_CONFIDENCE = Number(process.env.TRACK_MIN_CONFIDENCE || 55);
const SCAN_INTERVAL_SEC = Math.max(3, Number(process.env.SCAN_INTERVAL_SEC || 5));
const FALLBACK_USD_LKR = Number(process.env.FALLBACK_USD_LKR || 300);
const MAX_WAIT_CANDLES = Number(process.env.MAX_WAIT_CANDLES || 12); // wait for entry fill
const MAX_HOLD_CANDLES = Number(process.env.MAX_HOLD_CANDLES || 60); // max time in trade
const EXCHANGE_ORDER = (process.env.EXCHANGES || "binance,bybit,okx").split(",").map((s) => s.trim().toLowerCase());

const TF_MINUTES = { "5m": 5, "15m": 15, "1h": 60, "4h": 240 };
const EXCLUDE_BASES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "GBP", "USDT", "USD", "WBTC", "WETH"]);
const LEVERAGED = /(UP|DOWN|BULL|BEAR|[0-9]+L|[0-9]+S)$/;

const http = axios.create({ timeout: 12000, headers: { "User-Agent": "signal-engine/3.0" } });
const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

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
const adapters = {
  binance: {
    name: "binance",
    async tickers() {
      const { data } = await http.get("https://api.binance.com/api/v3/ticker/24hr");
      return data.filter((t) => t.symbol.endsWith(QUOTE)).map((t) => ({ base: t.symbol.slice(0, -QUOTE.length), quoteVolume: +t.quoteVolume, last: +t.lastPrice, changePct: +t.priceChangePercent }));
    },
    async klines(base, tf, limit) {
      const { data } = await http.get("https://api.binance.com/api/v3/klines", { params: { symbol: base + QUOTE, interval: tf, limit } });
      return { highs: data.map((k) => +k[2]), lows: data.map((k) => +k[3]), closes: data.map((k) => +k[4]), volumes: data.map((k) => +k[5]) };
    },
  },
  bybit: {
    name: "bybit",
    async tickers() {
      const { data } = await http.get("https://api.bybit.com/v5/market/tickers", { params: { category: "spot" } });
      return (data.result?.list || []).filter((t) => t.symbol.endsWith(QUOTE)).map((t) => ({ base: t.symbol.slice(0, -QUOTE.length), quoteVolume: +t.turnover24h, last: +t.lastPrice, changePct: +t.price24hPcnt * 100 }));
    },
    async klines(base, tf, limit) {
      const iv = { "5m": "5", "15m": "15", "1h": "60", "4h": "240" }[tf];
      const { data } = await http.get("https://api.bybit.com/v5/market/kline", { params: { category: "spot", symbol: base + QUOTE, interval: iv, limit } });
      const rows = [...(data.result?.list || [])].reverse(); // [start,open,high,low,close,volume,turnover]
      return { highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[3]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
    },
  },
  okx: {
    name: "okx",
    async tickers() {
      const { data } = await http.get("https://www.okx.com/api/v5/market/tickers", { params: { instType: "SPOT" } });
      return (data.data || []).filter((t) => t.instId.endsWith("-" + QUOTE)).map((t) => { const last = +t.last, open = +t.open24h; return { base: t.instId.split("-")[0], quoteVolume: +t.volCcy24h, last, changePct: open ? ((last - open) / open) * 100 : 0 }; });
    },
    async klines(base, tf, limit) {
      const bar = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H" }[tf];
      const { data } = await http.get("https://www.okx.com/api/v5/market/candles", { params: { instId: base + "-" + QUOTE, bar, limit } });
      const rows = [...(data.data || [])].reverse(); // [ts,o,h,l,c,vol,...]
      return { highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[3]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
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
const CB_G = { "5m": 300, "15m": 900, "1h": 3600 };
async function coinbaseKlines(base, tf) {
  const g = CB_G[tf];
  if (!g) return null;
  try {
    const { data } = await http.get(`https://api.exchange.coinbase.com/products/${base}-USD/candles`, { params: { granularity: g } });
    const rows = [...data].reverse();
    return { highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[1]), closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]) };
  } catch (e) { return null; }
}

let tickersCache = { at: 0, list: [] };
async function fetchTickers() {
  if (Date.now() - tickersCache.at < 45_000 && tickersCache.list.length) return tickersCache.list;
  const src = await detectSource();
  if (!src) return tickersCache.list;
  try {
    const list = (await src.tickers())
      .filter((t) => t.base && !EXCLUDE_BASES.has(t.base) && !LEVERAGED.test(t.base) && Number.isFinite(t.quoteVolume))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
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
function humanizeEta(minutes) { if (!Number.isFinite(minutes) || minutes <= 0) return "—"; if (minutes < 60) return `~${Math.round(minutes)}m`; if (minutes < 1440) return `~${(minutes / 60).toFixed(1)}h`; return `~${(minutes / 1440).toFixed(1)}d`; }

function computeSignal(base, tf, d, fx) {
  const { highs, lows, closes, volumes } = d;
  if (!closes || closes.length < 60) return { base, symbol: base, tf, error: "insufficient data" };
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200) ?? sma(closes, Math.min(closes.length, 120));
  const r = rsi(closes, 14), mac = macd(closes), boll = bollinger(closes, 20, 2);
  const a = atr(highs, lows, closes, 14), vw = vwap(highs, lows, closes, volumes), mf = mfi(highs, lows, closes, volumes, 14);
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
    const sep = a ? Math.abs(ema50 - ema200) / a : 0; conf += Math.min(18, sep * 9); if (sep > 1.2) reasons.push("Strong trend");
    if (r != null) { if (long) { if (r > 85) { conf -= 12; reasons.push("RSI stretched — prefer pullback"); } else if (r > 50) conf += 8; } else if (r < 15) { conf -= 12; reasons.push("RSI stretched — prefer bounce"); } else if (r < 50) conf += 8; }
    conf = Math.max(0, Math.min(100, Math.round(conf)));
  }
  if (conf < MIN_CONFIDENCE) direction = "NEUTRAL";

  const indicators = { price: round(price, 6), rsi14: round(r, 1), macdHist: mac ? round(mac.hist, 6) : null, bollingerPctB: boll ? round(boll.pctB, 3) : null, vwap: round(vw, 6), mfi: round(mf, 1), atr: round(a, 6), ema20: round(ema20, 6), ema50: round(ema50, 6), ema200: round(ema200, 6) };
  const H = 24, drift = Math.max(-0.02, Math.min(0.02, slope)), predicted = price * (1 + drift * H), bandFrac = a ? (a * Math.sqrt(H)) / price : 0.05;
  const forecast = { horizon: humanizeEta(H * (TF_MINUTES[tf] || 60)), priceUsd: round(predicted, 6), lowUsd: round(predicted * (1 - bandFrac), 6), highUsd: round(predicted * (1 + bandFrac), 6) };

  const out = { base, symbol: base, tf, direction, confidence: conf, priceUsd: round(price, 6), priceLkr: round(price * fx, 2), changePct: null, indicators, forecast, reasons, generatedAt: new Date().toISOString() };
  if (direction === "NEUTRAL" || !a) return { ...out, note: "No trend / setup — stand aside." };

  const long = direction === "LONG";
  const anchor = long ? Math.min(ema20 || price, vw || price) : Math.max(ema20 || price, vw || price);
  let entryLow, entryHigh;
  if (long) { entryHigh = price; entryLow = Math.max(swingLow, Math.min(anchor, price - 0.6 * a)); if (entryLow >= entryHigh) entryLow = price - 0.4 * a; }
  else { entryLow = price; entryHigh = Math.min(swingHigh, Math.max(anchor, price + 0.6 * a)); if (entryHigh <= entryLow) entryHigh = price + 0.4 * a; }
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = long ? Math.min(swingLow, entryLow - a) : Math.max(swingHigh, entryHigh + a);
  const risk = Math.abs(entryMid - stop);
  const tfMin = TF_MINUTES[tf] || 60, perCandle = a * 0.6;
  const targets = [1, 2, 3].map((k) => { const tp = long ? entryMid + k * risk : entryMid - k * risk; const candles = perCandle > 0 ? Math.abs(tp - entryMid) / perCandle : Infinity; return { name: `TP${k}`, priceUsd: round(tp, 6), priceLkr: round(tp * fx, 2), rr: k, etaLabel: humanizeEta(candles * tfMin) }; });
  const inZone = price >= entryLow && price <= entryHigh;
  const status = inZone ? "READY" : long ? "WAIT for pullback to entry" : "WAIT for bounce to entry";
  return { ...out, entry: { low: round(entryLow, 6), high: round(entryHigh, 6), mid: round(entryMid, 6), status, lowLkr: round(entryLow * fx, 2), highLkr: round(entryHigh * fx, 2) }, stop: { priceUsd: round(stop, 6), priceLkr: round(stop * fx, 2), riskPct: round((risk / entryMid) * 100, 2) }, targets, invalidation: long ? `Close below ${round(stop, 6)} invalidates the long.` : `Close above ${round(stop, 6)} invalidates the short.` };
}

async function signalFor(base, tf, fx) {
  try { const d = await getOHLCV(base, tf, 210); if (!d) return { base, symbol: base, tf, error: "no data" }; return computeSignal(base, tf, d, fx); }
  catch (e) { return { base, symbol: base, tf, error: e.message }; }
}

const scanCache = {};
let scanning = false;
async function scanMarket(tf, force) {
  const cached = scanCache[tf];
  const ttl = SCAN_INTERVAL_SEC * 1000 * 0.8;
  if (!force && cached && Date.now() - cached.at < ttl) return cached.data;
  if (scanning && cached) return cached.data;
  scanning = true;
  try {
    const [fx, universe] = await Promise.all([getUsdLkr(), getUniverse(UNIVERSE_SIZE)]);
    const results = [];
    for (let i = 0; i < universe.length; i += 8) {
      const batch = universe.slice(i, i + 8);
      const sigs = await Promise.all(batch.map((u) => signalFor(u.base, tf, fx)));
      sigs.forEach((s, j) => { if (batch[j]) s.changePct = round(batch[j].changePct, 2); });
      results.push(...sigs);
    }
    const rank = (s) => (s.error || s.direction === "NEUTRAL" ? -1 : s.confidence);
    results.sort((a, b) => rank(b) - rank(a));
    const data = { tf, fx, source: ACTIVE?.name || null, generatedAt: new Date().toISOString(), universe: universe.length, actionable: results.filter((s) => s.direction !== "NEUTRAL" && !s.error).length, signals: results };
    scanCache[tf] = { at: Date.now(), data };
    return data;
  } finally { scanning = false; }
}

// ===========================================================================
// Signal tracking store (Postgres if DATABASE_URL, else in-memory)
// ===========================================================================
const useDb = !!process.env.DATABASE_URL;
let pool = null;
const mem = [];
let memId = 1;

if (useDb) {
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
}

async function initStore() {
  if (!useDb) { console.log("[store] in-memory (set DATABASE_URL to persist across restarts)"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS tracked_signals (
    id SERIAL PRIMARY KEY, symbol VARCHAR(20), tf VARCHAR(5), direction VARCHAR(5), confidence INT,
    entry_low DOUBLE PRECISION, entry_high DOUBLE PRECISION, entry_mid DOUBLE PRECISION, stop DOUBLE PRECISION,
    tp1 DOUBLE PRECISION, tp2 DOUBLE PRECISION, tp3 DOUBLE PRECISION,
    status VARCHAR(10) DEFAULT 'WAITING', tp1_hit BOOLEAN DEFAULT false, tp2_hit BOOLEAN DEFAULT false, tp3_hit BOOLEAN DEFAULT false,
    result_r DOUBLE PRECISION, note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), entered_at TIMESTAMPTZ, closed_at TIMESTAMPTZ )`);
  console.log("[store] Postgres ready (durable tracking)");
}

const store = {
  async open(sig) {
    const t = sig.targets;
    const row = { symbol: sig.symbol, tf: sig.tf, direction: sig.direction, confidence: sig.confidence, entry_low: sig.entry.low, entry_high: sig.entry.high, entry_mid: sig.entry.mid, stop: sig.stop.priceUsd, tp1: t[0].priceUsd, tp2: t[1].priceUsd, tp3: t[2].priceUsd };
    // Dedup: skip if an open one exists for symbol+direction+tf.
    if (useDb) {
      const { rows } = await pool.query("SELECT 1 FROM tracked_signals WHERE symbol=$1 AND direction=$2 AND tf=$3 AND status IN ('WAITING','ACTIVE') LIMIT 1", [row.symbol, row.direction, row.tf]);
      if (rows.length) return;
      await pool.query(`INSERT INTO tracked_signals (symbol,tf,direction,confidence,entry_low,entry_high,entry_mid,stop,tp1,tp2,tp3) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [row.symbol, row.tf, row.direction, row.confidence, row.entry_low, row.entry_high, row.entry_mid, row.stop, row.tp1, row.tp2, row.tp3]);
    } else {
      if (mem.some((m) => m.symbol === row.symbol && m.direction === row.direction && m.tf === row.tf && (m.status === "WAITING" || m.status === "ACTIVE"))) return;
      mem.push({ id: memId++, status: "WAITING", tp1_hit: false, tp2_hit: false, tp3_hit: false, result_r: null, created_at: new Date().toISOString(), entered_at: null, closed_at: null, ...row });
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
    const upd = {};
    if (!t.tp1_hit && reach(t.tp1)) upd.tp1_hit = true;
    if (!t.tp2_hit && reach(t.tp2)) upd.tp2_hit = true;
    if (reach(t.tp3)) { return { ...upd, tp3_hit: true, status: "WIN", result_r: 3, closed_at: new Date() }; }
    if (belowStop) { const won = t.tp1_hit || upd.tp1_hit; return { ...upd, status: won ? "WIN" : "LOSS", result_r: won ? (t.tp2_hit || upd.tp2_hit ? 2 : 1) : -1, closed_at: new Date() }; }
    const enteredMs = t.entered_at ? new Date(t.entered_at).getTime() : created;
    if ((now - enteredMs) / 60000 > MAX_HOLD_CANDLES * tfMin) {
      const won = t.tp1_hit || upd.tp1_hit;
      const openR = round((long ? P - t.entry_mid : t.entry_mid - P) / Math.abs(t.entry_mid - t.stop), 2);
      return { ...upd, status: won ? "WIN" : "EXPIRED", result_r: won ? (t.tp2_hit || upd.tp2_hit ? 2 : 1) : openR, closed_at: new Date() };
    }
    return Object.keys(upd).length ? upd : null;
  }
  return null;
}

async function monitor() {
  const open = await store.open_rows();
  if (!open.length) return;
  const prices = await getTickerMap();
  const now = Date.now();
  for (const t of open) {
    const P = prices.get(t.symbol);
    if (P == null) continue;
    const upd = advance(t, P, now);
    if (upd) await store.update(t.id, upd);
  }
}

async function openFrom(data) {
  for (const s of data.signals) {
    if ((s.direction === "LONG" || s.direction === "SHORT") && s.confidence >= TRACK_MIN_CONFIDENCE && s.entry && s.targets) {
      await store.open(s).catch((e) => console.warn("[track]", e.message));
    }
  }
}

async function computeStats() {
  const all = await store.recent(2000);
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
  return {
    durable: useDb,
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
// Express
// ===========================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error("[api]", e.message); res.status(e.statusCode || 500).json({ error: e.message }); });

app.get("/api/health", (_req, res) => res.json({ status: "ok", source: ACTIVE?.name || null }));
app.get("/api/config", (_req, res) => res.json({ quote: QUOTE, universeSize: UNIVERSE_SIZE, tf: SIGNAL_TF, timeframes: TIMEFRAMES, minConfidence: MIN_CONFIDENCE, source: ACTIVE?.name || null, durable: useDb, scanIntervalSec: SCAN_INTERVAL_SEC }));

app.get("/api/signals", wrap(async (req, res) => {
  const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF;
  const data = await scanMarket(tf);
  let signals = data.signals;
  if (req.query.only === "actionable") signals = signals.filter((s) => s.direction !== "NEUTRAL" && !s.error);
  if (req.query.dir === "LONG" || req.query.dir === "SHORT") signals = signals.filter((s) => s.direction === req.query.dir);
  if (req.query.limit) signals = signals.slice(0, Number(req.query.limit));
  res.json({ ...data, signals });
}));

app.get("/api/signal/:symbol", wrap(async (req, res) => { const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF; const fx = await getUsdLkr(); res.json(await signalFor(req.params.symbol.toUpperCase().replace(QUOTE, ""), tf, fx)); }));
app.post("/api/rescan", wrap(async (req, res) => { const tf = TF_MINUTES[req.query.tf] ? req.query.tf : SIGNAL_TF; delete scanCache[tf]; res.json(await scanMarket(tf)); }));

app.get("/api/stats", wrap(async (_req, res) => res.json(await computeStats())));
app.get("/api/tracked", wrap(async (_req, res) => {
  const prices = await getTickerMap().catch(() => new Map());
  const rows = await store.recent(120);
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
function startTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.log("[telegram] disabled"); return; }
  try {
    const TelegramBot = require("node-telegram-bot-api");
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    bot.on("message", (m) => chats.add(m.chat.id));
    bot.onText(/\/start/, (m) => bot.sendMessage(m.chat.id, "📡 *Signal Engine*\n/signals – top setups\n/stats – track record", { parse_mode: "Markdown" }));
    bot.onText(/\/signals?$/, async (m) => { const { tf, signals } = await scanMarket(SIGNAL_TF); const top = signals.filter((s) => s.direction !== "NEUTRAL" && !s.error).slice(0, 8); bot.sendMessage(m.chat.id, top.length ? `📡 *Signals* (${tf})\n\n` + top.map((s) => `*${s.symbol}* ${s.direction} ${s.confidence}% (${s.entry.status})\nEntry ${fmtUsd(s.entry.low)}–${fmtUsd(s.entry.high)} · SL ${fmtUsd(s.stop.priceUsd)}\n${s.targets.map((t) => `${t.name} ${fmtUsd(t.priceUsd)} ${t.etaLabel}`).join(", ")}`).join("\n\n") : `No ${tf} setups now.`, { parse_mode: "Markdown" }); });
    bot.onText(/\/stats/, async (m) => { const s = await computeStats(); bot.sendMessage(m.chat.id, `📈 *Track record*\nWin rate: ${s.winRatePct ?? "—"}% (${s.wins}/${s.decided})\nTP1 ${s.tp1RatePct ?? "—"}% · TP2 ${s.tp2RatePct ?? "—"}% · TP3 ${s.tp3RatePct ?? "—"}%\nAvg R: ${s.avgResultR ?? "—"} · Open: ${s.open}${s.durable ? "" : "\n(in-memory — set DATABASE_URL to persist)"}`, { parse_mode: "Markdown" }); });
    bot.on("polling_error", (e) => console.warn("[telegram]", e.message));
    console.log("[telegram] started");
  } catch (e) { console.warn("[telegram] failed:", e.message); }
}
async function signalAlerts() {
  if (!bot || chats.size === 0) return;
  const { signals } = await scanMarket(SIGNAL_TF);
  for (const s of signals) {
    if (s.error || s.direction === "NEUTRAL" || s.confidence < Math.max(60, MIN_CONFIDENCE)) continue;
    const key = `${s.symbol}:${s.direction}`;
    if (Date.now() - (alerted.get(key) || 0) < 6 * 3600_000) continue;
    alerted.set(key, Date.now());
    for (const id of chats) bot.sendMessage(id, `🚨 *${s.symbol}* ${s.direction} ${s.confidence}%\nEntry ${fmtUsd(s.entry.low)}–${fmtUsd(s.entry.high)} · SL ${fmtUsd(s.stop.priceUsd)}\n${s.targets.map((t) => `${t.name} ${fmtUsd(t.priceUsd)} ${t.etaLabel}`).join(", ")}`, { parse_mode: "Markdown" }).catch(() => {});
  }
}
const alerted = new Map();

// ===========================================================================
// Boot
// ===========================================================================
let loopBusy = false;
function startLoops() {
  // Live scan loop: rescan the whole market + open new signals + monitor open
  // trades, every SCAN_INTERVAL_SEC. An overlap guard skips a tick if the
  // previous one is still running (so a slow scan never stacks up).
  setInterval(async () => {
    if (loopBusy) return;
    loopBusy = true;
    try {
      const data = await scanMarket(SIGNAL_TF, true);
      await openFrom(data);
      await monitor();
    } catch (e) {
      console.warn("[loop]", e.message);
    } finally {
      loopBusy = false;
    }
  }, SCAN_INTERVAL_SEC * 1000);
  cron.schedule("*/15 * * * *", () => signalAlerts().catch((e) => console.warn("[cron alert]", e.message)));
  console.log(`[loop] live scan every ${SCAN_INTERVAL_SEC}s`);
}
async function boot() {
  try { await initStore(); } catch (e) { console.error("[store] init failed:", e.message); }
  app.listen(PORT, () => console.log(`[server] signals on ${PORT}`));
  startTelegram();
  startLoops();
  detectSource().then(() => scanMarket(SIGNAL_TF, true)).then((d) => openFrom(d)).catch((e) => console.warn("[boot]", e.message));
}
if (require.main === module) boot();

module.exports = app;
module.exports._test = { ema, sma, rsi, macd, bollinger, atr, vwap, mfi, computeSignal, humanizeEta, advance };
