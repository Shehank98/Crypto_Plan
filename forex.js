/**
 * Forex Bot module (OANDA v20). Self-contained: OANDA client, a pluggable
 * strategy layer, a backtest engine, a live polling bot with risk limits, and
 * an Express router. Every trade (backtest or live) is logged to `forex_trades`
 * automatically - inserted on open, updated on close. No manual step.
 *
 * Mounted by server.js: createForex({ http, pool, useDb, round }).
 * Keys live in settings (env or Settings tab) and are never returned to the UI.
 */
"use strict";
const express = require("express");

module.exports = function createForex({ http, pool, useDb, round }) {
  const r2 = (n, d = 5) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

  // ---- config (persisted in app_settings key 'forex'; secrets never returned) ----
  const cfg = {
    apiKey: process.env.OANDA_API_KEY || "",
    accountId: process.env.OANDA_ACCOUNT_ID || "",
    accountType: (process.env.OANDA_ACCOUNT_TYPE || "practice").toLowerCase() === "live" ? "live" : "practice",
    riskPerTradeUsd: Number(process.env.FOREX_RISK_USD || 10), // ~$ risked per trade (sizes the position)
    maxUnits: Number(process.env.FOREX_MAX_UNITS || 100000),   // hard cap on position size
    dailyMaxLossUsd: Number(process.env.FOREX_DAILY_MAX_LOSS || 50), // halt the bot for the day if breached
    pair: process.env.FOREX_PAIR || "EUR_USD",
    granularity: process.env.FOREX_GRANULARITY || "M15",
    strategy: process.env.FOREX_STRATEGY || "ema_rsi",
    params: {}, // strategy params override (empty = defaults)
  };
  const configured = () => !!(cfg.apiKey && cfg.accountId);
  const restBase = () => (cfg.accountType === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com");
  const mask = (k) => (k ? k.slice(0, 4) + "…" + k.slice(-4) : "");
  let lastError = null;

  async function loadCfg() {
    if (!useDb()) return;
    try { const { rows } = await pool.query("SELECT v FROM app_settings WHERE k='forex'"); if (rows[0]) Object.assign(cfg, JSON.parse(rows[0].v)); } catch (e) { /* table may not exist yet */ }
  }
  async function saveCfg() {
    if (!useDb()) return;
    try { await pool.query("INSERT INTO app_settings (k,v) VALUES ('forex',$1) ON CONFLICT (k) DO UPDATE SET v=$1", [JSON.stringify(cfg)]); } catch (e) { /* ignore */ }
  }

  // ---- OANDA v20 REST ----
  async function oanda(method, path, body) {
    if (!configured()) throw new Error("OANDA API key / account id not set");
    const r = await http({ method, url: restBase() + path, headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" }, data: body });
    return r.data;
  }
  async function candles(pair, granularity, count, from, to) {
    const params = { granularity, price: "M" };
    if (from && to) { params.from = from; params.to = to; } else { params.count = Math.min(5000, count || 500); }
    const q = new URLSearchParams(params).toString();
    const d = await oanda("get", `/v3/instruments/${pair}/candles?${q}`);
    return (d.candles || []).filter((c) => c.complete).map((c) => ({ time: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume }));
  }
  async function accountSummary() { const d = await oanda("get", `/v3/accounts/${cfg.accountId}/summary`); return d.account; }
  async function openTrades() { const d = await oanda("get", `/v3/accounts/${cfg.accountId}/openTrades`); return d.trades || []; }
  async function marketOrder(pair, units, sl, tp) {
    const order = { type: "MARKET", instrument: pair, units: String(Math.round(units)), timeInForce: "FOK", positionFill: "DEFAULT" };
    if (sl) order.stopLossOnFill = { price: String(r2(sl, 5)) };
    if (tp) order.takeProfitOnFill = { price: String(r2(tp, 5)) };
    return oanda("post", `/v3/accounts/${cfg.accountId}/orders`, { order });
  }

  // ---- indicators (self-contained) ----
  const ema = (v, p) => { if (!v || v.length < p) return null; const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; };
  const emaArr = (v, p) => { if (!v || v.length < p) return []; const k = 2 / (p + 1); const out = new Array(v.length).fill(null); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; out[p - 1] = e; for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; } return out; };
  const rsi = (v, p = 14) => { if (!v || v.length < p + 1) return null; let g = 0, l = 0; for (let i = v.length - p; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; } if (l === 0) return 100; return 100 - 100 / (1 + g / l); };
  const atr = (h, l, c, p = 14) => { if (!c || c.length < p + 1) return null; const tr = []; for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); return tr.slice(-p).reduce((a, b) => a + b, 0) / p; };

  // ---- pluggable strategies ----
  // Each strategy: { name, defaults, evaluate(candlesUpToNow, params) -> {side, sl, tp, reason, raw} | null }
  const STRATEGIES = {
    ema_rsi: {
      name: "EMA crossover + RSI filter",
      defaults: { emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiLongMin: 50, rsiShortMax: 50, atrPeriod: 14, slAtrMult: 1.5, tpAtrMult: 2.0 },
      evaluate(cs, p) {
        if (cs.length < p.emaSlow + 3) return null;
        const closes = cs.map((c) => c.c), highs = cs.map((c) => c.h), lows = cs.map((c) => c.l);
        const f = emaArr(closes, p.emaFast), s = emaArr(closes, p.emaSlow);
        const n = closes.length - 1;
        if (f[n] == null || s[n] == null || f[n - 1] == null || s[n - 1] == null) return null;
        const crossUp = f[n - 1] <= s[n - 1] && f[n] > s[n];
        const crossDn = f[n - 1] >= s[n - 1] && f[n] < s[n];
        const rv = rsi(closes, p.rsiPeriod), a = atr(highs, lows, closes, p.atrPeriod);
        if (!a) return null;
        const price = closes[n];
        if (crossUp && rv != null && rv >= p.rsiLongMin) return { side: "buy", sl: price - p.slAtrMult * a, tp: price + p.tpAtrMult * a, reason: `EMA${p.emaFast}>EMA${p.emaSlow} cross up, RSI ${rv.toFixed(0)}`, raw: { ema: f[n], rsi: rv, atr: a } };
        if (crossDn && rv != null && rv <= p.rsiShortMax) return { side: "sell", sl: price + p.slAtrMult * a, tp: price - p.tpAtrMult * a, reason: `EMA${p.emaFast}<EMA${p.emaSlow} cross down, RSI ${rv.toFixed(0)}`, raw: { ema: f[n], rsi: rv, atr: a } };
        return null;
      },
    },
  };
  const stratParams = () => ({ ...STRATEGIES[cfg.strategy].defaults, ...(cfg.params || {}) });

  // ---- trade store (Postgres or memory), mirrors the crypto store pattern ----
  const mem = []; let memId = 1;
  const store = {
    async insert(t) {
      if (useDb()) {
        const { rows } = await pool.query(
          `INSERT INTO forex_trades (mode,strategy_name,currency_pair,side,entry_price,position_size,stop_loss,take_profit,status,raw_signal_data,opened_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,COALESCE($10,NOW())) RETURNING id`,
          [t.mode, t.strategy_name, t.currency_pair, t.side, t.entry_price, t.position_size, t.stop_loss, t.take_profit, t.raw_signal_data ? JSON.stringify(t.raw_signal_data) : null, t.opened_at || null]);
        return rows[0].id;
      }
      const id = memId++; mem.push({ id, status: "open", exit_price: null, closed_at: null, pnl: null, opened_at: t.opened_at || new Date().toISOString(), ...t }); return id;
    },
    async close(id, f) {
      if (useDb()) { const keys = Object.keys(f); const set = keys.map((k, i) => `${k}=$${i + 2}`).join(","); await pool.query(`UPDATE forex_trades SET ${set} WHERE id=$1`, [id, ...keys.map((k) => f[k])]); }
      else { const m = mem.find((x) => x.id === id); if (m) Object.assign(m, f); }
    },
    async list(q = {}) {
      if (useDb()) {
        const w = [], p = [];
        if (q.mode) { p.push(q.mode); w.push(`mode=$${p.length}`); }
        if (q.pair) { p.push(q.pair); w.push(`currency_pair=$${p.length}`); }
        if (q.strategy) { p.push(q.strategy); w.push(`strategy_name=$${p.length}`); }
        if (q.from) { p.push(q.from); w.push(`opened_at>=$${p.length}`); }
        if (q.to) { p.push(q.to); w.push(`opened_at<=$${p.length}`); }
        const where = w.length ? "WHERE " + w.join(" AND ") : "";
        const { rows } = await pool.query(`SELECT * FROM forex_trades ${where} ORDER BY opened_at DESC LIMIT ${Math.min(1000, +q.limit || 300)}`, p);
        return rows;
      }
      let list = mem.slice().reverse();
      if (q.mode) list = list.filter((t) => t.mode === q.mode);
      if (q.pair) list = list.filter((t) => t.currency_pair === q.pair);
      if (q.strategy) list = list.filter((t) => t.strategy_name === q.strategy);
      return list.slice(0, Math.min(1000, +q.limit || 300));
    },
    async openRows() { if (useDb()) return (await pool.query("SELECT * FROM forex_trades WHERE status='open' AND mode='live' ORDER BY opened_at DESC")).rows; return mem.filter((t) => t.status === "open" && t.mode === "live"); },
  };

  async function initSchema() {
    if (!useDb()) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS forex_trades (
      id SERIAL PRIMARY KEY,
      mode VARCHAR(10) NOT NULL,
      strategy_name VARCHAR(40),
      currency_pair VARCHAR(20),
      side VARCHAR(4),
      entry_price DOUBLE PRECISION,
      exit_price DOUBLE PRECISION,
      position_size DOUBLE PRECISION,
      stop_loss DOUBLE PRECISION,
      take_profit DOUBLE PRECISION,
      pnl DOUBLE PRECISION,
      status VARCHAR(10) DEFAULT 'open',
      raw_signal_data JSONB,
      opened_at TIMESTAMPTZ DEFAULT NOW(),
      closed_at TIMESTAMPTZ )`);
    await loadCfg();
  }

  // ---- position sizing: risk ~$riskPerTradeUsd based on the stop distance ----
  function sizeUnits(entry, sl) {
    const dist = Math.abs(entry - sl);
    if (!dist) return 0;
    const units = Math.min(cfg.maxUnits, Math.round(cfg.riskPerTradeUsd / dist));
    return Math.max(1, units);
  }

  // ---- backtest engine ----
  async function backtest({ pair, granularity, from, to, count, strategy, params }) {
    const strat = STRATEGIES[strategy || cfg.strategy];
    if (!strat) return { error: "unknown strategy" };
    const p = { ...strat.defaults, ...(params || {}) };
    const cs = await candles(pair || cfg.pair, granularity || cfg.granularity, count || 1500, from, to);
    if (cs.length < 60) return { error: "not enough candles" };
    const trades = [], equity = []; let cum = 0, peak = 0, maxDd = 0, i = p.emaSlow + 2;
    while (i < cs.length - 1) {
      const sig = strat.evaluate(cs.slice(0, i + 1), p);
      if (!sig) { i++; continue; }
      const entry = cs[i].c, buy = sig.side === "buy", units = sizeUnits(entry, sig.sl);
      let outcome = null, j = i + 1;
      for (; j < cs.length; j++) {
        const hi = cs[j].h, lo = cs[j].l;
        const hitSl = buy ? lo <= sig.sl : hi >= sig.sl;
        const hitTp = buy ? hi >= sig.tp : lo <= sig.tp;
        if (hitSl && hitTp) { outcome = { exit: sig.sl }; break; } // pessimistic
        if (hitSl) { outcome = { exit: sig.sl }; break; }
        if (hitTp) { outcome = { exit: sig.tp }; break; }
      }
      if (!outcome) break;
      const pnl = round((buy ? outcome.exit - entry : entry - outcome.exit) * units, 2);
      cum = round(cum + pnl, 2); peak = Math.max(peak, cum); maxDd = Math.min(maxDd, cum - peak);
      const t = { mode: "backtest", strategy_name: strat.name, currency_pair: pair || cfg.pair, side: sig.side, entry_price: r2(entry), exit_price: r2(outcome.exit), position_size: units, stop_loss: r2(sig.sl), take_profit: r2(sig.tp), pnl, status: "closed", closed_at: cs[j] ? cs[j].time : null, opened_at: cs[i].time, raw_signal_data: sig.raw };
      trades.push(t); equity.push({ t: cs[i].time, equity: cum });
      i = Math.max(i + 1, j + 1);
    }
    return { trades, equity, summary: summarize(trades, maxDd), pair: pair || cfg.pair, granularity: granularity || cfg.granularity, strategy: strat.name };
  }
  function summarize(trades, maxDd) {
    const n = trades.length, wins = trades.filter((t) => t.pnl > 0).length;
    const pnls = trades.map((t) => t.pnl);
    const total = round(pnls.reduce((a, b) => a + b, 0), 2);
    const mean = n ? total / n : 0;
    const sd = n > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const sharpe = sd ? round((mean / sd) * Math.sqrt(n), 2) : null;
    return { trades: n, wins, losses: n - wins, winRatePct: n ? round((wins / n) * 100, 1) : null, totalPnl: total, avgPnl: round(mean, 2), maxDrawdown: round(maxDd, 2), sharpe };
  }
  // Persist backtest trades to the log (mode=backtest), so history is complete.
  async function logBacktest(res) { for (const t of res.trades) await store.insert(t).catch(() => {}); }

  // ---- live bot (candle-close polling; OANDA holds the SL/TP server-side) ----
  const live = { running: false, halted: false, pair: null, granularity: null, strategy: null, startedAt: null, lastCandle: null, dayKey: null, dayPnl: 0, note: "" };
  let liveTimer = null;
  async function liveTick() {
    if (!live.running || live.halted) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (live.dayKey !== day) { live.dayKey = day; live.dayPnl = 0; }
      // 1) reconcile: detect trades OANDA closed (SL/TP) and update our rows + day PnL
      const openLocal = await store.openRows();
      if (openLocal.length) {
        const oandaOpen = await openTrades().catch(() => null);
        if (oandaOpen) {
          const stillOpen = new Set(oandaOpen.map((t) => String(t.id)));
          for (const row of openLocal) {
            const oid = row.raw_signal_data?.oandaTradeId || row.raw_signal_data?.oandatradeid;
            if (oid && !stillOpen.has(String(oid))) {
              // closed on OANDA - fetch realized pnl from the trade
              let pnl = null, exit = null;
              try { const d = await oanda("get", `/v3/accounts/${cfg.accountId}/trades/${oid}`); pnl = d.trade ? round(+d.trade.realizedPL, 2) : null; exit = d.trade ? +d.trade.price : null; } catch (e) { /* ignore */ }
              await store.close(row.id, { status: "closed", exit_price: exit, pnl, closed_at: new Date() });
              if (Number.isFinite(pnl)) live.dayPnl = round(live.dayPnl + pnl, 2);
            }
          }
        }
      }
      // 2) daily loss halt
      if (live.dayPnl <= -Math.abs(cfg.dailyMaxLossUsd)) { live.halted = true; live.note = `Daily max loss hit (${live.dayPnl}). Bot halted for today.`; return; }
      // 3) evaluate on new candle close
      const cs = await candles(live.pair, live.granularity, 200);
      if (!cs.length) return;
      const lastT = cs[cs.length - 1].time;
      if (live.lastCandle === lastT) return; // no new completed candle
      live.lastCandle = lastT;
      const stillOpenLocal = await store.openRows();
      if (stillOpenLocal.some((t) => t.currency_pair === live.pair)) return; // one position per pair
      const strat = STRATEGIES[live.strategy];
      const sig = strat.evaluate(cs, { ...strat.defaults, ...(cfg.params || {}) });
      if (!sig) return;
      const entry = cs[cs.length - 1].c, buy = sig.side === "buy";
      const units = sizeUnits(entry, sig.sl) * (buy ? 1 : -1);
      const resp = await marketOrder(live.pair, units, sig.sl, sig.tp);
      const fill = resp.orderFillTransaction;
      const fillPrice = fill ? +fill.price : entry;
      const tradeId = fill?.tradeOpened?.tradeID || null;
      await store.insert({ mode: "live", strategy_name: strat.name, currency_pair: live.pair, side: sig.side, entry_price: r2(fillPrice), position_size: Math.abs(units), stop_loss: r2(sig.sl), take_profit: r2(sig.tp), raw_signal_data: { ...sig.raw, reason: sig.reason, oandaTradeId: tradeId } });
      live.note = `Opened ${sig.side} ${live.pair} @ ${r2(fillPrice)}`;
    } catch (e) { lastError = e.response?.data?.errorMessage || e.message; live.note = "Error: " + lastError; }
  }
  function startLive() {
    if (!configured()) throw new Error("Set your OANDA key and account id first");
    if (live.running) return live;
    Object.assign(live, { running: true, halted: false, pair: cfg.pair, granularity: cfg.granularity, strategy: cfg.strategy, startedAt: new Date().toISOString(), lastCandle: null, note: "Started" });
    liveTimer = setInterval(liveTick, 20000); // poll every 20s for a new candle close
    liveTick();
    return live;
  }
  function stopLive() { live.running = false; if (liveTimer) clearInterval(liveTimer); liveTimer = null; live.note = "Stopped"; return live; }

  // ---- views (never leak secrets) ----
  const cfgView = () => ({ configured: configured(), keyMasked: mask(cfg.apiKey), accountId: cfg.accountId ? "…" + String(cfg.accountId).slice(-4) : "", accountType: cfg.accountType, riskPerTradeUsd: cfg.riskPerTradeUsd, maxUnits: cfg.maxUnits, dailyMaxLossUsd: cfg.dailyMaxLossUsd, pair: cfg.pair, granularity: cfg.granularity, strategy: cfg.strategy, params: stratParams(), strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, { name: v.name, defaults: v.defaults }])), lastError, durable: useDb() });
  const liveView = () => ({ ...live, dailyMaxLossUsd: cfg.dailyMaxLossUsd });

  // ---- router ----
  const router = express.Router();
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { lastError = e.response?.data?.errorMessage || e.message; res.status(400).json({ error: lastError }); });

  router.get("/config", wrap(async (_q, s) => s.json(cfgView())));
  router.post("/config", wrap(async (q, s) => {
    const b = q.body || {};
    if (typeof b.apiKey === "string" && b.apiKey.trim()) cfg.apiKey = b.apiKey.trim();
    if (typeof b.accountId === "string" && b.accountId.trim()) cfg.accountId = b.accountId.trim();
    if (b.accountType === "practice" || b.accountType === "live") cfg.accountType = b.accountType;
    for (const k of ["riskPerTradeUsd", "maxUnits", "dailyMaxLossUsd"]) if (b[k] != null && Number.isFinite(+b[k])) cfg[k] = +b[k];
    if (typeof b.pair === "string" && b.pair.trim()) cfg.pair = b.pair.trim().toUpperCase();
    if (typeof b.granularity === "string" && b.granularity.trim()) cfg.granularity = b.granularity.trim().toUpperCase();
    if (b.strategy && STRATEGIES[b.strategy]) cfg.strategy = b.strategy;
    if (b.params && typeof b.params === "object") cfg.params = b.params;
    if (b.clearKeys === true) { cfg.apiKey = ""; cfg.accountId = ""; }
    lastError = null; await saveCfg(); s.json(cfgView());
  }));
  router.post("/test", wrap(async (_q, s) => {
    if (!configured()) { s.status(400).json({ ok: false, error: "Enter your OANDA API key and account id first." }); return; }
    const a = await accountSummary(); lastError = null;
    s.json({ ok: true, accountType: cfg.accountType, currency: a.currency, balance: +a.balance, openTradeCount: a.openTradeCount, marginAvailable: +a.marginAvailable });
  }));
  router.get("/strategies", wrap(async (_q, s) => s.json(Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, { name: v.name, defaults: v.defaults }])))));
  router.post("/backtest", wrap(async (q, s) => {
    const res = await backtest(q.body || {});
    if (res.error) { s.status(400).json(res); return; }
    if ((q.body || {}).save !== false) await logBacktest(res); // log simulated trades to forex_trades
    s.json(res);
  }));
  router.get("/trades", wrap(async (q, s) => s.json({ trades: await store.list(q.query) })));
  router.get("/trades.csv", wrap(async (q, s) => {
    const rows = await store.list(q.query);
    const cols = ["id", "mode", "strategy_name", "currency_pair", "side", "entry_price", "exit_price", "position_size", "stop_loss", "take_profit", "pnl", "status", "opened_at", "closed_at"];
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.join(",")].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
    s.setHeader("Content-Type", "text/csv"); s.setHeader("Content-Disposition", "attachment; filename=forex_trades.csv"); s.send(csv);
  }));
  router.get("/live", wrap(async (_q, s) => s.json(liveView())));
  router.post("/live/start", wrap(async (_q, s) => s.json(startLive())));
  router.post("/live/stop", wrap(async (_q, s) => s.json(stopLive())));

  return { router, initSchema, boot: async () => { await loadCfg(); } };
};
