// Crypto Signal Engine - signals-only client.
const COLORS = { BTC: "#f7931a", ETH: "#8b9dff", SOL: "#14f195", BNB: "#f3ba2f" };
const DIR = {
  LONG: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", bar: "#10b981" },
  SHORT: { cls: "bg-rose-500/15 text-rose-300 border-rose-500/40", bar: "#f43f5e" },
  NEUTRAL: { cls: "bg-slate-500/15 text-slate-300 border-slate-500/40", bar: "#64748b" },
};
let CONFIG = { tf: "1h", timeframes: ["15m", "1h", "4h", "1d"] };
let tf = "1h";
let filter = "actionable"; // actionable | LONG | SHORT | all
let search = "";
let last = { signals: [] };
let REGIME = null; // market regime (BTC + breadth); gates longs
const btCache = {}; // per-card backtest results, keyed by SYMBOL|tf, so the 5s refresh keeps them

function renderRegime(r) {
  REGIME = r || null;
  const el = $("regime-banner");
  if (!r || !r.tier) { el.classList.add("hidden"); return; }
  const map = {
    RISK_ON: { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", txt: "🟢 Risk-ON - market broadly bullish, longs favored" },
    NEUTRAL: { cls: "border-slate-500/40 bg-slate-500/10 text-slate-300", txt: "⚪ Neutral - mixed market, be selective" },
    RISK_OFF: { cls: "border-rose-500/40 bg-rose-500/10 text-rose-200", txt: "🔴 Risk-OFF - BTC weak / broad selling. New longs are risky; auto-trade is paused" },
  };
  const m = map[r.tier] || map.NEUTRAL;
  el.className = "mb-3 rounded-lg border px-3 py-2 text-xs " + m.cls;
  el.innerHTML = `<b>${m.txt}</b> · <span class="opacity-80">BTC ${r.btc} · breadth ${r.breadthPct ?? "?"}% long (${r.longs}/${r.total})</span>`;
  el.classList.remove("hidden");
}

const $ = (id) => document.getElementById(id);
const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
// Precision-aware price display: sub-cent coins (PEPE, SHIB…) need more decimals.
const usd = (n) => { if (!Number.isFinite(n)) return "-"; const a = Math.abs(n); const d = a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : a >= 0.0001 ? 8 : 10; return "$" + n.toLocaleString("en-US", { maximumFractionDigits: d }); };
const coinColor = (s) => COLORS[s] || "#818cf8";

async function api(p) {
  const r = await fetch(p);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
}

function seg(el, items, active, on) {
  el.innerHTML = items.map((i) => `<button data-v="${i.v}" class="px-3 py-1.5 ${i.v === active ? "bg-indigo-600 text-white" : "bg-panel text-slate-300 hover:bg-edge"}">${i.label}</button>`).join("");
  el.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => on(b.dataset.v)));
}

// Entry window: is it still worth entering from here (live risk:reward)?
const WIN = {
  OPEN: { cls: "bg-emerald-900/60 text-emerald-200", label: "✅ Enter now" },
  WAIT: { cls: "bg-amber-900/50 text-amber-200", label: "⏳ Wait for pullback" },
  CHASE: { cls: "bg-orange-900/50 text-orange-200", label: "⚠️ Extended - don't chase" },
  CLOSED: { cls: "bg-rose-900/50 text-rose-200", label: "⛔ Entry window closed" },
};
function entryWindowBadge(e) {
  if (!e) return "";
  const w = WIN[e.window] || { cls: "bg-slate-800 text-slate-300", label: e.status || "" };
  return `<span class="pill ${w.cls}">${w.label}</span>`;
}

// Coin quality (BTC/ETH-like stability): liquidity + volatility.
const QCLS = { "Blue-chip": "bg-sky-900/60 text-sky-200", "Solid": "bg-emerald-900/50 text-emerald-200", "Moderate": "bg-amber-900/50 text-amber-200", "Speculative": "bg-rose-900/50 text-rose-200" };
function fmtVol(n) { n = Number(n) || 0; return n >= 1e9 ? "$" + (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? "$" + (n / 1e6).toFixed(0) + "M" : "$" + Math.round(n / 1e3) + "K"; }
function qualityBadge(q) {
  if (!q) return "";
  return `<span class="pill ${QCLS[q.tier] || "bg-slate-800 text-slate-300"}" title="24h volume ${fmtVol(q.liquidityUsd)} · volatility ${q.atrPct ?? "?"}%/candle">${q.tier}</span>`;
}

// Live outcome badge for a card, from the signal's tracked state.
function trackedBadge(t) {
  if (!t) return "";
  const head = {
    WAITING: `<span class="pill bg-amber-900/50 text-amber-200">⏳ Waiting for entry</span>`,
    ACTIVE: `<span class="pill bg-sky-900/50 text-sky-200">🔵 In trade</span>`,
    WIN: `<span class="pill bg-emerald-900/60 text-emerald-200">✅ WIN ${t.result_r > 0 ? "+" : ""}${t.result_r}R</span>`,
    LOSS: `<span class="pill bg-rose-900/60 text-rose-200">🛑 Stopped ${t.result_r}R</span>`,
    EXPIRED: `<span class="pill bg-slate-800 text-slate-400">⌛ Expired (no fill)</span>`,
  }[t.status] || "";
  const hits = [t.tp1_hit && "TP1", t.tp2_hit && "TP2", t.tp3_hit && "TP3"].filter(Boolean);
  const hitPill = hits.length ? `<span class="pill bg-emerald-900/40 text-emerald-300">🎯 ${hits.join(" · ")} hit</span>` : "";
  const live = (t.status === "ACTIVE" || t.status === "WAITING") && t.openR != null
    ? `<span class="pill ${t.openR > 0 ? "bg-emerald-900/40 text-emerald-300" : t.openR < 0 ? "bg-rose-900/40 text-rose-300" : "bg-slate-800 text-slate-400"}">Open ${t.openR > 0 ? "+" : ""}${t.openR}R</span>`
    : "";
  return `<div class="mt-2 flex flex-wrap items-center gap-1">${head}${hitPill}${live}</div>`;
}

function card(s) {
  const d = DIR[s.direction] || DIR.NEUTRAL;
  if (s.error) return `<div class="card p-4 opacity-50"><div class="flex justify-between"><b style="color:${coinColor(s.symbol)}">${s.symbol}</b><span class="pill bg-slate-800">no data</span></div></div>`;
  const ind = s.indicators || {};
  const chips = (s.reasons || []).slice(0, 3).map((r) => `<span class="pill bg-slate-800 text-slate-400">${r}</span>`).join(" ");
  const chartBtn = `<button data-chart="${s.symbol}" data-tf="${s.tf}" class="rounded-md border border-edge bg-panel px-2 py-1 text-xs text-slate-300 hover:bg-edge">📈 Chart</button>`;
  const btBtn = `<button data-backtest="${s.symbol}" data-tf="${s.tf}" class="rounded-md border border-edge bg-panel px-2 py-1 text-xs text-slate-300 hover:bg-edge">⏮ Test</button>`;
  const bt = btCache[s.symbol + "|" + s.tf];
  const btRow = bt
    ? (bt.error
        ? `<p class="mt-2 text-[11px] text-slate-500">Backtest: ${bt.error}</p>`
        : `<p class="mt-2 rounded border border-edge bg-ink/50 px-2 py-1 text-[11px] text-slate-400">Backtest (${bt.bars} bars): Win <b class="${bt.winRatePct >= 55 ? "text-emerald-400" : bt.winRatePct >= 45 ? "text-sky-400" : "text-rose-400"}">${bt.winRatePct ?? "-"}%</b> · ${bt.trades} trades · TP1 ${bt.tp1RatePct ?? "-"}% · TP2 ${bt.tp2RatePct ?? "-"}% · Avg <b class="${bt.avgR > 0 ? "text-emerald-400" : "text-rose-400"}">${bt.avgR ?? "-"}R</b></p>`)
    : "";
  const head = `<div class="flex items-center justify-between">
      <span class="text-base font-bold" style="color:${coinColor(s.symbol)}">${s.symbol}<span class="ml-1 text-xs font-normal text-slate-500">${s.tf}${s.changePct != null ? ` · ${s.changePct > 0 ? "+" : ""}${s.changePct}%/24h` : ""}</span></span>
      <span class="pill border ${d.cls}">${s.direction} ${s.confidence}%</span>
    </div>
    <div class="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-800"><div style="width:${s.confidence}%;background:${d.bar}" class="h-full"></div></div>
    <p class="mt-2 text-xs text-slate-500">${usd(s.priceUsd)} · RSI ${ind.rsi14 ?? "-"} · ADX ${ind.adx ?? "-"} · StochRSI ${ind.stochRsi ?? "-"} · MFI ${ind.mfi ?? "-"}</p>
    ${s.quality ? `<div class="mt-1 flex items-center gap-1 text-xs">${qualityBadge(s.quality)}<span class="text-slate-600">vol ${fmtVol(s.liquidityUsd)} · ${s.quality.atrPct ?? "?"}%/candle</span></div>` : ""}`;

  if (s.direction === "NEUTRAL" || !s.entry) {
    return `<div class="card p-4 cursor-pointer hover:border-indigo-500/40" data-analyze="${s.symbol}" data-tf="${s.tf}" title="Click for full analysis">${head}<p class="mt-2 text-sm text-slate-400">${s.note || "Stand aside."}</p><div class="mt-2 flex items-center justify-between"><div class="flex flex-wrap gap-1">${chips}</div><div class="flex gap-1">${btBtn}${chartBtn}</div></div>${btRow}</div>`;
  }
  const readyCls = s.entry.status === "READY" ? "text-emerald-300" : "text-amber-300";
  const tps = s.targets.map((t) => `<div class="flex items-center justify-between text-sm"><span class="text-slate-400">${t.name} <span class="text-slate-600">${t.rr}R</span></span><span class="tabular-nums"><span class="text-emerald-400">+${t.gainPct}%</span> · ${usd(t.priceUsd)} <span class="text-slate-500">${t.etaLabel}</span></span></div>`).join("");
  const f = s.forecast || {};
  const closed = s.entry.window === "CLOSED";
  return `<div class="card glow p-4 cursor-pointer hover:border-indigo-500/40 ${closed ? "opacity-60" : ""}" data-analyze="${s.symbol}" data-tf="${s.tf}" title="Click for full analysis">${head}
    <div class="mt-2 flex items-center justify-between gap-2 text-xs">${entryWindowBadge(s.entry)}<span class="text-slate-500">forecast ${f.horizon}: ${usd(f.priceUsd)}</span></div>
    ${s.entry.enterMsg ? `<p class="mt-1 text-[11px] ${closed ? "text-rose-300" : s.entry.window === "OPEN" ? "text-emerald-300" : "text-slate-400"}">${s.entry.enterMsg}</p>` : ""}
    ${trackedBadge(s.tracked)}
    <div class="mt-2 space-y-1 rounded-lg border border-edge bg-ink/50 p-2">
      <div class="flex justify-between text-sm"><span class="text-slate-400">Entry</span><span class="tabular-nums text-slate-100">${usd(s.entry.low)} – ${usd(s.entry.high)}</span></div>
      <div class="flex justify-between text-sm"><span class="text-rose-400">Stop</span><span class="tabular-nums text-rose-300">${usd(s.stop.priceUsd)} <span class="text-slate-500">-${s.stop.riskPct}%</span></span></div>
      <div class="my-1 border-t border-edge"></div>${tps}
    </div>
    <div class="mt-2 flex items-center justify-between gap-2"><div class="flex flex-wrap gap-1">${chips}</div><div class="flex gap-1">${btBtn}${chartBtn}</div></div>
    ${btRow}
    <p class="mt-2 text-[11px] text-slate-500">${s.invalidation || ""}</p>
  </div>`;
}

function render() {
  let list = last.signals || [];
  if (filter === "actionable") list = list.filter((s) => s.direction === "LONG" || s.direction === "SHORT");
  else if (filter === "quality") list = list.filter((s) => (s.direction === "LONG" || s.direction === "SHORT") && s.quality && s.quality.score >= 3);
  else if (filter === "LONG" || filter === "SHORT") list = list.filter((s) => s.direction === filter);
  if (search) list = list.filter((s) => s.symbol.includes(search.toUpperCase()));
  $("signals").innerHTML = list.map(card).join("");
  $("signals").querySelectorAll("[data-analyze]").forEach((el) => (el.onclick = (e) => { if (e.target.closest("[data-chart],[data-backtest]")) return; openAnalysis(el.dataset.analyze, el.dataset.tf); }));
  $("signals").querySelectorAll("[data-chart]").forEach((b) => (b.onclick = () => openChart(b.dataset.chart, b.dataset.tf)));
  $("signals").querySelectorAll("[data-backtest]").forEach((b) => (b.onclick = async () => {
    const sym = b.dataset.backtest, tfv = b.dataset.tf, key = sym + "|" + tfv;
    b.textContent = "…"; b.disabled = true;
    try { const r = await api(`/api/backtest/${sym}?tf=${encodeURIComponent(tfv)}`); btCache[key] = r; }
    catch (e) { btCache[key] = { error: e.message }; }
    render();
  }));
  const empty = $("empty");
  if (!list.length) {
    empty.classList.remove("hidden");
    empty.textContent = search ? `No coin matches "${search}".` : "No actionable setups right now - the market may be ranging. Try another timeframe or the All filter.";
  } else empty.classList.add("hidden");
}

const STATUS_CLS = { WIN: "text-emerald-400", LOSS: "text-rose-400", EXPIRED: "text-slate-400", ACTIVE: "text-sky-400", WAITING: "text-amber-400" };

function renderStats(s) {
  const chip = (label, val, cls) => `<span class="pill border border-edge bg-panel px-3 py-1.5 text-slate-300">${label} <b class="${cls || "text-white"}">${val}</b></span>`;
  const wr = s.winRatePct;
  $("stats").innerHTML = [
    chip("Win rate", wr == null ? "-" : wr + "%", wr == null ? "" : wr >= 55 ? "text-emerald-400" : wr >= 45 ? "text-sky-400" : "text-rose-400"),
    chip("Decided", s.decided),
    chip("TP1", (s.tp1RatePct ?? "-") + "%"),
    chip("TP2", (s.tp2RatePct ?? "-") + "%"),
    chip("TP3", (s.tp3RatePct ?? "-") + "%"),
    chip("Avg R", s.avgResultR ?? "-", s.avgResultR > 0 ? "text-emerald-400" : s.avgResultR < 0 ? "text-rose-400" : ""),
    chip("Open", s.open),
  ].join(" ");
  $("track-note").textContent = s.durable ? "" : "· in-memory (set DATABASE_URL to persist across restarts)";
}

// Did the ETA estimates hold up? Compares logged estimate vs. actual time-to-TP1.
function renderEta(s) {
  const el = $("eta-panel");
  const e = s.tp1Eta;
  if (!e || !e.n) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  const acc = e.accuracyPct;
  const accCls = acc >= 75 ? "text-emerald-400" : acc >= 50 ? "text-amber-400" : "text-rose-400";
  el.innerHTML = `
    <h3 class="mb-1 text-sm font-semibold text-slate-300">⏱ ETA accuracy - do the time estimates hold up?</h3>
    <p class="text-slate-400">Across <b class="text-slate-200">${e.n}</b> trade${e.n === 1 ? "" : "s"} that reached TP1: the engine estimated
      <b class="text-slate-200">${e.estLabel}</b>, and it actually took <b class="text-slate-200">${e.actualLabel}</b>.
      Timing accuracy <b class="${accCls}">${acc}%</b> · hit on/ahead of estimate <b class="text-slate-200">${e.onTimePct}%</b> of the time.</p>
    <p class="mt-1 text-slate-500">ETAs are projected from ATR speed - treat them as a ballpark, not a countdown.</p>`;
}

function renderByTf(byTf) {
  const rows = Object.entries(byTf || {});
  $("bytf-table").innerHTML = rows.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Timeframe</th><th class="text-right">Decided</th><th class="text-right">Win rate</th></tr></thead><tbody>${rows
        .map(([k, v]) => `<tr class="border-b border-edge/60"><td class="py-1.5 font-medium">${k}</td><td class="py-1.5 text-right">${v.n}</td><td class="py-1.5 text-right ${v.winRatePct >= 50 ? "text-emerald-400" : "text-rose-400"}">${v.winRatePct}%</td></tr>`)
        .join("")}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No decided trades yet.</td></tr></tbody>';
}

const tfPill = (t) => `<span class="pill bg-slate-800 text-slate-400">${t}</span>`;
const trackFilter = (arr) => (arr || []).filter((x) => (trackTf === "all" || x.tf === trackTf) && (!trackSearch || x.symbol.includes(trackSearch)));

// Directional % move between two prices.
function movePct(from, to, long) { if (from == null || to == null || !from) return null; return round(((long ? to - from : from - to) / from) * 100, 2); }
// Progress bar from entry toward TP1 (0..100%).
function tp1Progress(x) {
  const long = x.direction === "LONG";
  if (x.currentPrice == null || x.entry_mid == null || x.tp1 == null) return 0;
  const span = Math.abs(x.tp1 - x.entry_mid) || 1;
  const done = long ? x.currentPrice - x.entry_mid : x.entry_mid - x.currentPrice;
  return Math.max(0, Math.min(100, (done / span) * 100));
}

// --- Sri Lanka time (Asia/Colombo, UTC+5:30) + durations ---
const SL_TZ = "Asia/Colombo";
function slTime(iso) {
  if (!iso) return "-";
  try { return new Date(iso).toLocaleString("en-GB", { timeZone: SL_TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch (e) { return "-"; }
}
function fmtDur(min) {
  if (!Number.isFinite(min) || min < 0) return "-";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}
// Minutes between two ISO timestamps.
function minsBetween(a, b) { if (!a || !b) return null; const m = (new Date(b).getTime() - new Date(a).getTime()) / 60000; return Number.isFinite(m) ? m : null; }
// Projected clock time (SL) that TP1 is estimated to hit: entered + eta minutes.
function etaClock(enteredIso, etaMin) { if (!enteredIso || !Number.isFinite(etaMin)) return "-"; return slTime(new Date(new Date(enteredIso).getTime() + etaMin * 60000)); }

function renderTrackedFiltered() {
  const open = trackFilter(lastTrack.open);
  const recent = trackFilter(lastTrack.recent);

  const openRows = open.map((x, i) => {
    const long = x.direction === "LONG";
    const gain = movePct(x.entry_mid, x.currentPrice, long);        // current gain %
    const toTp1 = movePct(x.currentPrice, x.tp1, long);             // % still needed to TP1
    const prog = tp1Progress(x);
    const startedAt = x.entered_at || x.created_at;                 // when the trade began (or was logged)
    // Estimated TP1: if already hit, show actual; else projected clock + remaining duration.
    let etaCell;
    if (x.tp1_hit && x.tp1_at) {
      etaCell = `<span class="text-emerald-400">hit ${slTime(x.tp1_at)}</span><br><span class="text-slate-500">est ${fmtDur(x.eta1_min)}</span>`;
    } else {
      etaCell = `<span class="text-slate-300">~${etaClock(startedAt, x.eta1_min)}</span><br><span class="text-slate-500">in ${fmtDur(x.eta1_min)}</span>`;
    }
    return `<tr class="cursor-pointer border-b border-edge/60 hover:bg-edge/30" data-trade="open:${i}" title="Click for the full trade plan & timing">
      <td class="py-2 font-semibold" style="color:${coinColor(x.symbol)}">${x.symbol}</td>
      <td class="py-2">${tfPill(x.tf)}</td>
      <td class="py-2"><span class="pill ${long ? "bg-emerald-900 text-emerald-200" : "bg-rose-900 text-rose-200"}">${x.direction}</span></td>
      <td class="py-2 ${STATUS_CLS[x.status]}">${x.status}${x.tp1_hit ? " ·TP1" : ""}${x.tp2_hit ? "·TP2" : ""}</td>
      <td class="py-2 text-right tabular-nums text-slate-200">${usd(x.entry_mid)}</td>
      <td class="py-2 text-xs text-slate-400 whitespace-nowrap">${x.entered_at ? slTime(x.entered_at) : slTime(x.created_at) + " <span class='text-slate-600'>(logged)</span>"}</td>
      <td class="py-2 text-xs whitespace-nowrap">${etaCell}</td>
      <td class="py-2 text-right tabular-nums ${gain > 0 ? "text-emerald-400" : gain < 0 ? "text-rose-400" : "text-slate-400"}">${gain != null ? (gain > 0 ? "+" : "") + gain + "%" : "-"}</td>
      <td class="py-2 text-right tabular-nums ${x.openR > 0 ? "text-emerald-400" : x.openR < 0 ? "text-rose-400" : "text-slate-400"}">${x.openR != null ? (x.openR > 0 ? "+" : "") + x.openR + "R" : "-"}</td>
      <td class="py-2" style="min-width:120px">
        <div class="flex items-center gap-2">
          <div class="h-1.5 flex-1 overflow-hidden rounded bg-slate-800"><div class="h-full bg-emerald-500" style="width:${prog}%"></div></div>
          <span class="text-xs text-slate-400">${toTp1 != null ? (toTp1 > 0 ? toTp1 + "% to TP1" : "at TP1") : ""}</span>
        </div>
      </td>
    </tr>`;
  }).join("");
  $("open-table").innerHTML = open.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Coin</th><th>TF</th><th>Dir</th><th>Status</th><th class="text-right">Entry</th><th>Entered (SL)</th><th>Est → TP1</th><th class="text-right">Gain</th><th class="text-right">Open R</th><th>Progress → TP1</th></tr></thead><tbody>${openRows}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No open tracked signals for this filter. High-confidence setups are logged automatically.</td></tr></tbody>';

  const recRows = recent.map((x, i) => {
    const long = x.direction === "LONG";
    const riskPct = x.entry_mid && x.stop ? Math.abs(x.entry_mid - x.stop) / x.entry_mid * 100 : null;
    const gainPct = x.result_r != null && riskPct != null ? round(x.result_r * riskPct, 2) : null;
    // Estimated vs actual time to TP1.
    const actualMin = x.tp1_hit ? minsBetween(x.entered_at, x.tp1_at) : null;
    const est = Number(x.eta1_min);
    let evaCell;
    if (actualMin != null && Number.isFinite(est) && est > 0) {
      const ratio = actualMin / est;
      const cls = ratio <= 1.25 ? "text-emerald-400" : ratio <= 2 ? "text-amber-400" : "text-rose-400";
      evaCell = `<span class="text-slate-500">est ${fmtDur(est)}</span> · <span class="${cls}">act ${fmtDur(actualMin)}</span>`;
    } else if (actualMin != null) {
      evaCell = `<span class="text-slate-300">act ${fmtDur(actualMin)}</span>`;
    } else {
      evaCell = `<span class="text-slate-600">- no TP1</span>`;
    }
    return `<tr class="cursor-pointer border-b border-edge/60 hover:bg-edge/30" data-trade="recent:${i}" title="Click for the full trade plan & timing">
      <td class="py-2 font-semibold" style="color:${coinColor(x.symbol)}">${x.symbol}</td>
      <td class="py-2">${tfPill(x.tf)}</td>
      <td class="py-2"><span class="pill ${long ? "bg-emerald-900 text-emerald-200" : "bg-rose-900 text-rose-200"}">${x.direction}</span></td>
      <td class="py-2 text-right tabular-nums text-slate-200">${usd(x.entry_mid)}</td>
      <td class="py-2 text-xs text-slate-400 whitespace-nowrap">${slTime(x.entered_at || x.created_at)}</td>
      <td class="py-2 ${STATUS_CLS[x.status]}">${x.status}${x.tp3_hit ? " ·TP3" : x.tp2_hit ? " ·TP2" : x.tp1_hit ? " ·TP1" : ""}</td>
      <td class="py-2 text-xs whitespace-nowrap">${evaCell}</td>
      <td class="py-2 text-right tabular-nums ${gainPct > 0 ? "text-emerald-400" : gainPct < 0 ? "text-rose-400" : "text-slate-400"}">${gainPct != null ? (gainPct > 0 ? "+" : "") + gainPct + "%" : "-"}</td>
      <td class="py-2 text-right tabular-nums ${x.result_r > 0 ? "text-emerald-400" : x.result_r < 0 ? "text-rose-400" : "text-slate-400"}">${x.result_r != null ? (x.result_r > 0 ? "+" : "") + x.result_r + "R" : "-"}</td>
      <td class="py-2 text-right text-xs text-slate-500 whitespace-nowrap">${slTime(x.closed_at)}</td>
    </tr>`;
  }).join("");
  $("recent-table").innerHTML = recent.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Coin</th><th>TF</th><th>Dir</th><th class="text-right">Entry</th><th>Entered (SL)</th><th>Result</th><th>Est vs Actual → TP1</th><th class="text-right">Gain</th><th class="text-right">R</th><th class="text-right">Closed (SL)</th></tr></thead><tbody>${recRows}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No closed results for this filter yet.</td></tr></tbody>';
  // Row click -> full per-trade plan & timing.
  document.querySelectorAll("#open-table [data-trade], #recent-table [data-trade]").forEach((tr) => (tr.onclick = () => {
    const [k, i] = tr.dataset.trade.split(":");
    const row = (k === "open" ? open : recent)[+i];
    if (row) openTradeAnalysis(row);
  }));
}

// Per-trade "ladder": entry -> TP1 -> TP2 -> TP3, each with the % move and the
// estimated time for that leg, actual times once hit, and time left to the next TP.
function openTradeAnalysis(x) {
  const m = $("trade-modal"); m.classList.remove("hidden"); m.classList.add("flex");
  const long = x.direction === "LONG";
  $("trade-title").innerHTML = `<span style="color:${coinColor(x.symbol)}">${x.symbol}</span> · ${x.tf} · ${DIRPILL(x.direction)} - trade plan`;
  const riskPct = x.entry_mid && x.stop ? round(Math.abs(x.entry_mid - x.stop) / x.entry_mid * 100, 2) : null;
  const startedAt = x.entered_at || x.created_at;
  const live = x.status === "ACTIVE" || x.status === "WAITING";
  const nowMin = startedAt ? minsBetween(startedAt, new Date().toISOString()) : null;
  const tps = [
    { k: 1, price: x.tp1, hit: x.tp1_hit, at: x.tp1_at, cum: Number(x.eta1_min), prev: x.entry_mid, prevAt: x.entered_at, prevLabel: "entry" },
    { k: 2, price: x.tp2, hit: x.tp2_hit, at: x.tp2_at, cum: Number(x.eta2_min), prev: x.tp1, prevAt: x.tp1_at, prevLabel: "TP1" },
    { k: 3, price: x.tp3, hit: x.tp3_hit, at: x.tp3_at, cum: Number(x.eta3_min), prev: x.tp2, prevAt: x.tp2_at, prevLabel: "TP2" },
  ];
  const nextK = (tps.find((t) => !t.hit) || {}).k || null;
  let prevCum = 0;
  const steps = tps.map((t) => {
    const legEst = (Number.isFinite(t.cum) ? t.cum : prevCum) - prevCum;
    const fromEntry = movePct(x.entry_mid, t.price, long);
    const fromPrev = movePct(t.prev, t.price, long);
    // Estimated vs ACTUAL time to reach this target (cumulative from entry).
    const actCum = t.hit && t.at ? minsBetween(startedAt, t.at) : null;
    const estCum = Number.isFinite(t.cum) ? t.cum : null;
    let evaHtml = "";
    if (actCum != null && estCum != null) {
      const delta = actCum - estCum, ratio = estCum > 0 ? actCum / estCum : 1;
      const cls = ratio <= 1.25 ? "text-emerald-400" : ratio <= 2 ? "text-amber-400" : "text-rose-400";
      const tag = delta <= 0 ? `⚡ ${fmtDur(-delta)} early` : `🐢 ${fmtDur(delta)} late`;
      evaHtml = `<div class="text-xs"><span class="text-slate-500">est ${fmtDur(estCum)}</span> → <span class="${cls}">actual ${fmtDur(actCum)}</span> <span class="${cls}">(${tag})</span></div>`;
    } else if (estCum != null) {
      const remaining = nowMin != null ? Math.max(0, estCum - nowMin) : null;
      evaHtml = `<div class="text-xs"><span class="text-slate-500">est ${fmtDur(estCum)} from entry</span>${live && remaining != null ? ` · <span class="text-sky-300">~${fmtDur(remaining)} left</span>` : ""}</div>`;
    }
    let statusHtml;
    if (t.hit && t.at) statusHtml = `<span class="text-emerald-400">✅ hit ${slTime(t.at)}</span>`;
    else statusHtml = t.k === nextK ? `<span class="text-sky-400">⏳ next target</span>` : `<span class="text-slate-500">pending</span>`;
    const border = t.hit ? "border-emerald-500" : t.k === nextK ? "border-sky-500" : "border-edge";
    const html = `<div class="border-l-2 ${border} pl-3 pb-3">
      <div class="text-sm font-semibold text-slate-200">TP${t.k} <span class="text-xs text-slate-500">${t.k}R</span> · ${usd(t.price)} ${statusHtml}</div>
      <div class="text-xs text-slate-400">+${fromEntry}% from entry · +${fromPrev}% from ${t.prevLabel} · this leg ≈ ${fmtDur(legEst)}</div>
      ${evaHtml}
    </div>`;
    prevCum = Number.isFinite(t.cum) ? t.cum : prevCum;
    return html;
  }).join("");
  const curGain = movePct(x.entry_mid, x.currentPrice, long);
  const nextT = tps.find((t) => t.k === nextK);
  const nextLeft = nextT && Number.isFinite(nextT.cum) && nowMin != null ? Math.max(0, nextT.cum - nowMin) : null;
  const box = (label, val, cls) => `<div><div class="text-[11px] uppercase text-slate-500">${label}</div><div class="text-sm ${cls || "text-slate-200"}">${val}</div></div>`;
  const rightNow = live
    ? `<div class="mb-3 grid grid-cols-2 gap-3 rounded-lg border border-edge bg-ink/50 p-3 sm:grid-cols-5">
        ${box("Now", usd(x.currentPrice))}
        ${box("Gain", curGain != null ? (curGain > 0 ? "+" : "") + curGain + "%" : "-", curGain > 0 ? "text-emerald-400" : curGain < 0 ? "text-rose-400" : "")}
        ${box("Open R", x.openR != null ? (x.openR > 0 ? "+" : "") + x.openR + "R" : "-", x.openR > 0 ? "text-emerald-400" : x.openR < 0 ? "text-rose-400" : "")}
        ${box("In trade", nowMin != null ? fmtDur(nowMin) : "-")}
        ${box(nextK ? `Est. to TP${nextK}` : "Status", nextK ? (nextLeft != null ? "~" + fmtDur(nextLeft) : "-") : x.status, "text-sky-300")}
      </div>`
    : `<div class="mb-3 rounded-lg border border-edge bg-ink/50 p-3 text-sm">Closed: <b class="${x.result_r > 0 ? "text-emerald-400" : x.result_r < 0 ? "text-rose-400" : ""}">${x.status}${x.result_r != null ? " " + (x.result_r > 0 ? "+" : "") + x.result_r + "R" : ""}</b> · ${slTime(x.closed_at)}</div>`;
  const entryBlock = `<div class="mb-3 rounded-lg border border-edge bg-ink/50 p-3 text-sm">
    <div class="flex justify-between py-0.5"><span class="text-slate-400">▶ Entry</span><span class="tabular-nums text-slate-100">${usd(x.entry_mid)} <span class="text-xs text-slate-500">${x.entered_at ? "entered " + slTime(x.entered_at) : "logged " + slTime(x.created_at)}</span></span></div>
    <div class="flex justify-between py-0.5"><span class="text-rose-400">■ Stop</span><span class="tabular-nums text-rose-300">${usd(x.stop)}${riskPct != null ? ` (-${riskPct}%)` : ""}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-slate-400">Confidence</span><span class="text-slate-200">${x.confidence != null ? x.confidence + "%" : "-"}</span></div>
  </div>`;
  $("trade-body").innerHTML = `${rightNow}${entryBlock}
    <h4 class="mb-2 text-sm font-semibold text-slate-300">Target ladder - how far & how long to each TP</h4>
    <div>${steps}</div>
    <p class="mt-2 text-[11px] text-slate-500">Each TP is 1R/2R/3R off your risk. Times are ATR-based estimates in Sri Lanka time; "~left" counts down from your entry estimate.</p>`;
}

// Explain an empty track record: is it in-memory (reset on redeploy), are any
// signals currently eligible (≥ threshold), or is the market just quiet?
function renderTrackDiag(s) {
  const el = $("track-diag");
  const hasHistory = (s.tracked || 0) > 0 || (lastTrack.open || []).length || (lastTrack.recent || []).length;
  if (hasHistory) { el.classList.add("hidden"); return; }
  const thr = CONFIG.trackMinConfidence ?? 55;
  const sigs = last.signals || [];
  const actionable = sigs.filter((x) => x.direction === "LONG" || x.direction === "SHORT");
  const eligible = actionable.filter((x) => x.confidence >= thr);
  el.classList.remove("hidden");
  let tone, msg;
  if (eligible.length) {
    tone = "border-sky-500/40 bg-sky-500/10 text-sky-200";
    msg = `<b>${eligible.length}</b> signal${eligible.length === 1 ? "" : "s"} currently qualify (≥ ${thr}% confidence): ${eligible.slice(0, 6).map((x) => x.symbol).join(", ")}. These get logged automatically within ~${Math.max(3, CONFIG.indicatorRefreshSec || 60)}s and will appear here as <b>open</b> trades - wins/losses show once price reaches a target or stop.`;
  } else if (actionable.length) {
    tone = "border-amber-500/40 bg-amber-500/10 text-amber-200";
    msg = `${actionable.length} setup${actionable.length === 1 ? "" : "s"} are showing, but none has reached the <b>${thr}%</b> confidence needed to be tracked yet. Lower <code>TRACK_MIN_CONFIDENCE</code> to log more, or wait for a stronger trend.`;
  } else {
    tone = "border-slate-500/40 bg-slate-500/10 text-slate-300";
    msg = `No actionable setups right now${CONFIG.source ? " on " + CONFIG.source : ""} - the market may be ranging, so nothing qualifies to track. Check back, or try another timeframe.`;
  }
  const durNote = CONFIG.dbError
    ? `<span class="text-rose-300">⚠ Database connection failed - using in-memory tracking. (${CONFIG.dbError}) Check that <code>DATABASE_URL</code> is set to the Railway Postgres reference.</span>`
    : CONFIG.durable
    ? `<span class="text-emerald-300">History is durable (Postgres) - it survives redeploys.</span>`
    : `<span class="text-amber-300">Tracking is in-memory - it resets on every redeploy. Set <code>DATABASE_URL</code> (Railway Postgres) to keep your track record.</span>`;
  el.className = "mb-3 rounded-lg border px-3 py-2 text-xs " + tone;
  el.innerHTML = `${msg}<div class="mt-1">${durNote}</div>`;
}

async function loadTrack() {
  try {
    const [s, t] = await Promise.all([api("/api/stats"), api("/api/tracked")]);
    lastTrack = t;
    renderStats(s);
    renderEta(s);
    renderByTf(s.byTimeframe);
    renderTrackDiag(s);
    renderTrackedFiltered();
  } catch (e) { /* ignore */ }
}

// ---------- chart (Lightweight Charts) ----------
let chartApi = null;
function emaSeries(closes, times, p) {
  if (closes.length < p) return [];
  const k = 2 / (p + 1);
  let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const out = [{ time: times[p - 1], value: e }];
  for (let i = p; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out.push({ time: times[i], value: e }); }
  return out;
}
function closeChart() {
  if (chartApi) { try { chartApi.remove(); } catch (e) {} chartApi = null; }
  const m = $("chart-modal"); m.classList.add("hidden"); m.classList.remove("flex");
}
async function openChart(sym, tfv) {
  if (typeof LightweightCharts === "undefined") { alert("Chart library still loading - try again in a moment."); return; }
  const m = $("chart-modal"); m.classList.remove("hidden"); m.classList.add("flex");
  $("chart-title").innerHTML = `<span style="color:${coinColor(sym)}">${sym}</span> · ${tfv}`;
  $("chart-plan").innerHTML = "";
  $("chart-why").classList.add("hidden"); $("chart-why").innerHTML = "";
  const el = $("chart"); el.innerHTML = "";
  closeChart._pending = sym + tfv;
  let data;
  try { data = await api(`/api/candles/${sym}?tf=${encodeURIComponent(tfv)}&limit=300`); }
  catch (e) { el.innerHTML = `<p class="p-6 text-sm text-rose-400">${e.message}</p>`; return; }
  if (closeChart._pending !== sym + tfv) return; // superseded
  m.classList.remove("hidden"); m.classList.add("flex");
  const c = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: 440,
    layout: { background: { color: "#0b0e14" }, textColor: "#94a3b8" },
    grid: { vertLines: { color: "#161b26" }, horzLines: { color: "#1e2532" } },
    rightPriceScale: { borderColor: "#1e2532" },
    timeScale: { borderColor: "#1e2532", timeVisible: true },
    crosshair: { mode: 0 },
  });
  chartApi = c;
  const cs = c.addCandlestickSeries({ upColor: "#10b981", downColor: "#f43f5e", wickUpColor: "#10b981", wickDownColor: "#f43f5e", borderVisible: false });
  cs.setData(data.candles.map((k) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })));
  const closes = data.candles.map((k) => k.close), times = data.candles.map((k) => k.time);
  [[20, "#818cf8"], [50, "#22d3ee"], [200, "#f59e0b"]].forEach(([p, col]) => { const s = c.addLineSeries({ color: col, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(emaSeries(closes, times, p)); });
  $("chart-legend").classList.remove("hidden");
  $("chart-legend").innerHTML = `EMA <span style="color:#818cf8">20</span> <span style="color:#22d3ee">50</span> <span style="color:#f59e0b">200</span> · <span style="color:#818cf8">┈ entry</span> <span style="color:#f43f5e">- stop</span> <span style="color:#10b981">┈ TP</span>`;

  const sig = (last.signals || []).find((x) => x.symbol === sym);
  if (sig && sig.entry) {
    const line = (price, color, style, title) => cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    line(sig.entry.low, "#818cf8", 2, "Entry");
    line(sig.entry.high, "#818cf8", 2, "");
    line(sig.stop.priceUsd, "#f43f5e", 0, "Stop");
    sig.targets.forEach((t) => line(t.priceUsd, "#10b981", 2, `${t.name} (${t.rr}R)`));
    // Fibonacci golden-pocket (0.5-0.618) as dotted reference lines.
    if (sig.fib) { line(sig.fib.retr["0.5"], "#a78bfa", 3, "Fib 0.5"); line(sig.fib.retr["0.618"], "#a78bfa", 3, "Fib 0.618"); }
    $("chart-plan").innerHTML = [
      `<span class="pill ${sig.direction === "LONG" ? "bg-emerald-900 text-emerald-200" : "bg-rose-900 text-rose-200"}">${sig.direction} ${sig.confidence}%</span>`,
      `<span class="pill bg-slate-800">Entry ${usd(sig.entry.low)}–${usd(sig.entry.high)}</span>`,
      `<span class="pill bg-slate-800 text-rose-300">Stop ${usd(sig.stop.priceUsd)} (-${sig.stop.riskPct}%)</span>`,
      ...sig.targets.map((t) => `<span class="pill bg-slate-800 text-emerald-300">${t.name} +${t.gainPct}% · ${usd(t.priceUsd)} · ${t.etaLabel}</span>`),
    ].join(" ");
    // "Why these lines" - how each level on the chart was decided.
    const why = $("chart-why");
    why.classList.remove("hidden");
    why.innerHTML = `
      <div class="mb-1 font-semibold text-slate-300">Why these lines - how the trade was decided</div>
      <ul class="space-y-1.5">
        <li><span class="font-medium" style="color:#818cf8">┈ Entry</span> - ${sig.entry.why || "pullback into the EMA20/VWAP zone."}</li>
        <li><span class="font-medium" style="color:#f43f5e">- Stop</span> - ${sig.stop.why || "beyond the recent swing ±ATR."}</li>
        <li><span class="font-medium" style="color:#10b981">┈ TP1/2/3</span> - ${sig.targetsWhy || "1R / 2R / 3R off your risk."}</li>
      </ul>
      <div class="mt-2 border-t border-edge pt-2 text-slate-500"><b class="text-slate-400">Direction call:</b> ${(sig.reasons || []).slice(0, 5).join(" · ") || "trend filter"}</div>`;
  } else {
    $("chart-plan").innerHTML = '<span class="pill bg-slate-800 text-slate-400">No active setup - chart for reference.</span>';
    $("chart-why").classList.add("hidden");
  }
  c.timeScale().fitContent();
  // Backtest button runs the rules over history for this coin+timeframe.
  $("chart-bt").innerHTML = "";
  $("chart-backtest").onclick = async () => {
    $("chart-bt").innerHTML = '<span class="pill bg-slate-800 text-slate-400">Backtesting…</span>';
    try {
      const b = await api(`/api/backtest/${sym}?tf=${encodeURIComponent(tfv)}`);
      if (b.error) { $("chart-bt").innerHTML = `<span class="pill bg-slate-800 text-slate-400">${b.error}</span>`; return; }
      const wr = b.winRatePct;
      $("chart-bt").innerHTML = [
        `<span class="pill border border-edge bg-panel">Backtest ${b.bars} bars</span>`,
        `<span class="pill bg-slate-800">Win <b class="${wr >= 55 ? "text-emerald-400" : wr >= 45 ? "text-sky-400" : "text-rose-400"}">${wr ?? "-"}%</b></span>`,
        `<span class="pill bg-slate-800">Trades ${b.trades}</span>`,
        `<span class="pill bg-slate-800 text-emerald-300">TP1 ${b.tp1RatePct ?? "-"}%</span>`,
        `<span class="pill bg-slate-800 text-emerald-300">TP2 ${b.tp2RatePct ?? "-"}%</span>`,
        `<span class="pill bg-slate-800 text-emerald-300">TP3 ${b.tp3RatePct ?? "-"}%</span>`,
        `<span class="pill bg-slate-800">Avg <b class="${b.avgR > 0 ? "text-emerald-400" : "text-rose-400"}">${b.avgR ?? "-"}R</b></span>`,
      ].join(" ");
    } catch (e) { $("chart-bt").innerHTML = `<span class="pill bg-slate-800 text-rose-400">${e.message}</span>`; }
  };
}

// ---------- full analysis modal ----------
const DIRPILL = (dir, extra = "") => `<span class="pill ${dir === "LONG" ? "bg-emerald-900 text-emerald-200" : dir === "SHORT" ? "bg-rose-900 text-rose-200" : "bg-slate-700 text-slate-300"}">${dir}${extra}</span>`;
function closeAnalysis() { const m = $("analysis-modal"); m.classList.add("hidden"); m.classList.remove("flex"); }
// Turn the indicator block into readable rows with a verdict.
function indicatorRows(ind, sig) {
  if (!ind) return "";
  const row = (k, v, note, cls) => `<div class="flex items-center justify-between border-b border-edge/50 py-1"><span class="text-slate-400">${k}</span><span class="tabular-nums text-slate-200">${v} <span class="ml-1 text-xs ${cls || "text-slate-500"}">${note}</span></span></div>`;
  const out = [];
  if (ind.rsi14 != null) out.push(row("RSI (14)", ind.rsi14, ind.rsi14 > 70 ? "overbought" : ind.rsi14 < 30 ? "oversold" : "neutral", ind.rsi14 > 70 || ind.rsi14 < 30 ? "text-amber-400" : ""));
  if (ind.adx != null) out.push(row("ADX", ind.adx, ind.adx >= 25 ? "strong trend" : ind.adx < 18 ? "choppy / weak" : "moderate", ind.adx >= 25 ? "text-emerald-400" : ind.adx < 18 ? "text-rose-400" : ""));
  if (ind.stochRsi != null) out.push(row("Stoch RSI", ind.stochRsi, ind.stochRsi < 0.2 ? "oversold (dip)" : ind.stochRsi > 0.8 ? "overbought" : "mid", ""));
  if (ind.mfi != null) out.push(row("MFI (money flow)", ind.mfi, ind.mfi > 80 ? "overbought" : ind.mfi < 20 ? "oversold" : "neutral", ""));
  if (ind.cci != null) out.push(row("CCI", ind.cci, ind.cci > 100 ? "overbought" : ind.cci < -100 ? "oversold" : "neutral", ""));
  if (ind.williamsR != null) out.push(row("Williams %R", ind.williamsR, ind.williamsR > -20 ? "overbought" : ind.williamsR < -80 ? "oversold" : "neutral", ""));
  if (ind.obvTrend) out.push(row("OBV (volume)", ind.obvTrend, ind.obvTrend === "up" ? "accumulation" : ind.obvTrend === "down" ? "distribution" : "flat", ind.obvTrend === "up" ? "text-emerald-400" : ind.obvTrend === "down" ? "text-rose-400" : ""));
  if (ind.psar) out.push(row("Parabolic SAR", ind.psar, ind.psar === "bull" ? "below price (bullish)" : "above price (bearish)", ind.psar === "bull" ? "text-emerald-400" : "text-rose-400"));
  if (ind.macdHist != null) out.push(row("MACD hist", ind.macdHist, ind.macdHist > 0 ? "bullish momentum" : "bearish momentum", ind.macdHist > 0 ? "text-emerald-400" : "text-rose-400"));
  if (ind.vwap != null) out.push(row("VWAP", usd(ind.vwap), sig.priceUsd > ind.vwap ? "price above" : "price below", ""));
  return out.join("");
}
async function openAnalysis(sym, tfv) {
  const m = $("analysis-modal"); m.classList.remove("hidden"); m.classList.add("flex");
  $("an-title").innerHTML = `<span style="color:${coinColor(sym)}">${sym}</span> · ${tfv} - full analysis`;
  $("an-body").innerHTML = '<p class="py-10 text-center text-slate-500">Analyzing across timeframes…</p>';
  let a;
  try { a = await api(`/api/analysis/${sym}?tf=${encodeURIComponent(tfv)}`); }
  catch (e) { $("an-body").innerHTML = `<p class="py-6 text-rose-400">${e.message}</p>`; return; }
  const s = a.signal || {};
  const d = DIR[s.direction] || DIR.NEUTRAL;
  // Multi-timeframe agreement
  const tfRows = Object.entries(a.perTimeframe || {}).map(([t, p]) => p.error
    ? `<td class="px-2 py-1 text-center text-slate-600">-</td>`
    : `<td class="px-2 py-1 text-center">${DIRPILL(p.direction)}<div class="text-[11px] text-slate-500">${p.confidence}%</div></td>`).join("");
  const tfHead = Object.keys(a.perTimeframe || {}).map((t) => `<th class="px-2 py-1 text-center text-xs uppercase text-slate-500">${t}</th>`).join("");
  const consCls = a.consensus === "LONG" ? "text-emerald-400" : a.consensus === "SHORT" ? "text-rose-400" : "text-amber-400";
  // Patterns
  const pats = (s.patterns || []).map((p) => `<span class="pill ${p.bias === "bull" ? "bg-emerald-900 text-emerald-200" : p.bias === "bear" ? "bg-rose-900 text-rose-200" : "bg-slate-700 text-slate-300"}">${p.name}</span>`).join(" ") || '<span class="text-slate-500">none on the latest bar</span>';
  // Plan
  const plan = s.entry ? `
    <div class="rounded-lg border border-edge bg-ink/50 p-3">
      <div class="flex justify-between py-0.5"><span class="text-slate-400">Entry zone</span><span class="tabular-nums text-slate-100">${usd(s.entry.low)} – ${usd(s.entry.high)} <span class="text-xs ${s.entry.status === "READY" ? "text-emerald-400" : "text-amber-400"}">${s.entry.status}</span></span></div>
      <div class="flex justify-between py-0.5"><span class="text-rose-400">Stop</span><span class="tabular-nums text-rose-300">${usd(s.stop.priceUsd)} (-${s.stop.riskPct}%)</span></div>
      ${s.targets.map((t) => `<div class="flex justify-between py-0.5"><span class="text-slate-400">${t.name} <span class="text-slate-600">${t.rr}R</span></span><span class="tabular-nums"><span class="text-emerald-400">+${t.gainPct}%</span> · ${usd(t.priceUsd)} <span class="text-slate-500">${t.etaLabel}</span></span></div>`).join("")}
      <div class="mt-2 space-y-1 border-t border-edge pt-2 text-xs text-slate-400">
        <div><b class="text-slate-300">Entry:</b> ${s.entry.why || ""}</div>
        <div><b class="text-slate-300">Stop:</b> ${s.stop.why || ""}</div>
        <div><b class="text-slate-300">Targets:</b> ${s.targetsWhy || ""}</div>
      </div>
    </div>` : `<p class="text-slate-400">${s.note || "No active setup - stand aside."}</p>`;
  const bt = a.backtest && !a.backtest.error ? a.backtest : null;
  const btBlock = bt
    ? `<div class="flex flex-wrap gap-2 text-xs"><span class="pill border border-edge bg-panel">Backtest ${bt.bars} bars</span><span class="pill bg-slate-800">Win <b class="${bt.winRatePct >= 55 ? "text-emerald-400" : bt.winRatePct >= 45 ? "text-sky-400" : "text-rose-400"}">${bt.winRatePct ?? "-"}%</b></span><span class="pill bg-slate-800">${bt.trades} trades</span><span class="pill bg-slate-800 text-emerald-300">TP1 ${bt.tp1RatePct ?? "-"}%</span><span class="pill bg-slate-800">Avg <b class="${bt.avgR > 0 ? "text-emerald-400" : "text-rose-400"}">${bt.avgR ?? "-"}R</b></span></div>`
    : `<p class="text-xs text-slate-500">${a.backtest && a.backtest.error ? "Backtest: " + a.backtest.error : "Backtest unavailable."}</p>`;
  // Entry timing + risk:reward
  const e = s.entry || {};
  const timingBlock = e.window ? `
    <div class="mb-4 rounded-lg border border-edge bg-ink/50 p-3">
      <div class="mb-1 flex flex-wrap items-center gap-2">${entryWindowBadge(e)}${e.inGolden ? '<span class="pill bg-indigo-900/60 text-indigo-200">🎯 Fib golden pocket</span>' : ""}</div>
      <p class="text-xs ${e.window === "CLOSED" ? "text-rose-300" : e.window === "OPEN" ? "text-emerald-300" : "text-slate-400"}">${e.enterMsg || ""}</p>
      ${s.rr ? `<div class="mt-2 flex flex-wrap gap-2 text-xs"><span class="pill bg-slate-800">Risk ${s.rr.riskPct}% to stop</span><span class="pill bg-slate-800 text-emerald-300">Plan R:R - TP1 ${s.rr.toTp1}</span><span class="pill bg-slate-800 text-emerald-300">TP2 ${s.rr.toTp2}</span><span class="pill bg-slate-800 text-emerald-300">TP3 ${s.rr.toTp3}</span></div>${e.rrNow != null && (e.window === "CHASE" || e.window === "CLOSED") ? `<p class="mt-1 text-[11px] text-amber-400">Buying at market right now is only ${e.rrNow}:1 - wait for a pullback toward ${usd(e.mid)} to get the full plan R:R.</p>` : `<p class="mt-1 text-[11px] text-slate-500">Best entry is a limit near ${usd(e.mid)} (the pullback), which gives the full 1:1 / 2:1 / 3:1.</p>`}` : ""}
    </div>` : "";
  // Fibonacci levels
  const exitBlock = (s.exitPlan && s.exitPlan.length) ? `
    <h4 class="mb-1 text-sm font-semibold text-slate-300">🎯 Exit plan (scale out - lock profit early)</h4>
    <div class="mb-4 rounded-lg border border-edge bg-ink/50 p-3 text-xs">
      ${s.exitPlan.map((p) => `<div class="flex gap-2 border-b border-edge/40 py-1 last:border-0"><b class="w-10 text-emerald-300">${p.at}</b><b class="w-20 text-slate-200">${p.action}</b><span class="text-slate-400">${p.note}</span></div>`).join("")}
      <p class="mt-2 text-[11px] text-slate-500">${s.exitPlan.length > 2 ? "Once TP1 hits and the stop is at break-even, the trade <b class='text-emerald-300'>can't lose</b> - best case a full ~+1.75R." : "Banking the full <b class='text-emerald-300'>+1R at TP1</b> is the highest-probability exit for these setups - don't wait for TP2/TP3."}</p>
    </div>` : "";
  const fibBlock = s.fib ? `
    <h4 class="mb-1 text-sm font-semibold text-slate-300">Fibonacci (swing ${usd(s.fib.swingLow)} - ${usd(s.fib.swingHigh)})</h4>
    <div class="mb-4 overflow-x-auto"><table class="w-full text-xs"><tbody>
      <tr class="border-b border-edge/50"><td class="py-1 text-slate-500">Pullback (entry)</td><td class="py-1 text-right">0.382 <b class="text-slate-200">${usd(s.fib.retr["0.382"])}</b></td><td class="py-1 text-right">0.5 <b class="text-slate-200">${usd(s.fib.retr["0.5"])}</b></td><td class="py-1 text-right text-indigo-300">0.618 <b>${usd(s.fib.retr["0.618"])}</b></td><td class="py-1 text-right">0.786 <b class="text-slate-200">${usd(s.fib.retr["0.786"])}</b></td></tr>
      <tr><td class="py-1 text-slate-500">Extension (targets)</td><td class="py-1 text-right text-emerald-300" colspan="2">1.272 <b>${usd(s.fib.ext["1.272"])}</b></td><td class="py-1 text-right text-emerald-300" colspan="2">1.618 <b>${usd(s.fib.ext["1.618"])}</b></td></tr>
    </tbody></table></div>
    <p class="mb-4 text-[11px] text-slate-500">The <b class="text-indigo-300">0.5-0.618 "golden pocket"</b> is the classic high-probability pullback entry; extensions project where price often travels next.</p>` : "";
  // Trading psychology
  const psychBlock = (s.discipline && s.discipline.length) ? `
    <h4 class="mb-1 text-sm font-semibold text-slate-300">🧠 Trading psychology &amp; discipline</h4>
    <ul class="mb-4 space-y-1 text-xs text-slate-400">${s.discipline.map((d2) => `<li class="flex gap-2"><span class="text-slate-600">•</span><span>${d2}</span></li>`).join("")}</ul>` : "";
  $("an-body").innerHTML = `
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <span class="pill border ${d.cls} text-sm">${s.direction} ${s.confidence ?? 0}%</span>
      <span class="text-sm text-slate-400">Price ${usd(s.priceUsd)}</span>
      ${s.quality ? `${qualityBadge(s.quality)}<span class="text-xs text-slate-500">vol ${fmtVol(s.liquidityUsd)} · ${s.quality.atrPct ?? "?"}%/candle</span>` : ""}
      ${s.htf && s.htfDir ? `<span class="pill bg-slate-800 text-xs">${s.htfDir === s.direction ? "✅" : "⚠️"} ${s.htf} trend ${s.htfDir}</span>` : ""}
    </div>
    <div class="mb-4 h-2 w-full overflow-hidden rounded bg-slate-800"><div style="width:${s.confidence ?? 0}%;background:${d.bar}" class="h-full"></div></div>
    ${timingBlock}

    <h4 class="mb-1 text-sm font-semibold text-slate-300">Multi-timeframe agreement</h4>
    <div class="mb-1 overflow-x-auto"><table class="w-full"><thead><tr>${tfHead}</tr></thead><tbody><tr>${tfRows}</tr></tbody></table></div>
    <p class="mb-4 text-xs">Consensus: <b class="${consCls}">${a.consensus}</b> <span class="text-slate-500">(${a.agree.long} long / ${a.agree.short} short of ${a.agree.total} timeframes)</span></p>

    <div class="mb-4 grid gap-4 md:grid-cols-2">
      <div>
        <h4 class="mb-1 text-sm font-semibold text-slate-300">Indicators</h4>
        ${indicatorRows(s.indicators, s)}
      </div>
      <div>
        <h4 class="mb-1 text-sm font-semibold text-slate-300">Trade plan</h4>
        ${plan}
      </div>
    </div>

    ${exitBlock}
    ${fibBlock}
    <h4 class="mb-1 text-sm font-semibold text-slate-300">Candlestick patterns (latest bar)</h4>
    <div class="mb-4 flex flex-wrap gap-1">${pats}</div>

    ${psychBlock}
    <h4 class="mb-1 text-sm font-semibold text-slate-300">Why this call</h4>
    <div class="mb-4 flex flex-wrap gap-1">${(s.reasons || []).map((r) => `<span class="pill bg-slate-800 text-slate-300">${r}</span>`).join(" ") || '<span class="text-slate-500">-</span>'}</div>

    <h4 class="mb-1 text-sm font-semibold text-slate-300">Historical backtest (${tfv})</h4>
    <div class="mb-4">${btBlock}</div>

    <div class="flex gap-2">
      <button id="an-chart" class="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm hover:bg-edge">📈 Open chart</button>
    </div>
    <p class="mt-3 text-[11px] text-slate-500">Educational only - not financial advice. Always use your own stop.</p>`;
  const cb = $("an-chart"); if (cb) cb.onclick = () => { closeAnalysis(); openChart(sym, tfv); };
}

async function load() {
  try {
    const data = await api(`/api/signals?tf=${encodeURIComponent(tf)}`);
    last = data;
    $("updated").innerHTML = data.generatedAt ? `<span class="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 align-middle"></span>LIVE · every ${Math.max(3, CONFIG.scanIntervalSec || 5)}s · ${new Date(data.generatedAt).toLocaleTimeString()}` : "";
    $("summary").textContent = `${data.actionable} setups · scanned ${data.universe} coins · ${tf}${data.source ? " · " + data.source : ""}`;
    renderRegime(data.regime);
    render();
  } catch (e) {
    $("empty").classList.remove("hidden");
    $("empty").textContent = e.message;
  }
  // Track Record is NOT refreshed on the 5s signals tick (too noisy) - it updates
  // on tab-open, manual Rescan, and a gentle timer (see init()).
}

async function rescan() {
  const b = $("btn-refresh");
  b.textContent = "Scanning…";
  b.disabled = true;
  try {
    await api(`/api/rescan?tf=${encodeURIComponent(tf)}`).catch(() => {});
    await load();
    if (activeTab === "track") await loadTrack();
  } finally {
    b.textContent = "↻ Rescan";
    b.disabled = false;
  }
}

let activeTab = "signals";
let trackTf = "all";
let trackSearch = "";
let lastTrack = { open: [], recent: [] };
function drawTrackTf() {
  seg($("track-tf"), [{ v: "all", label: "All TF" }, ...(CONFIG.timeframes || ["15m", "1h", "4h", "1d"]).map((t) => ({ v: t, label: t }))], trackTf, (v) => { trackTf = v; drawTrackTf(); renderTrackedFiltered(); });
}
function drawTabs() {
  const tabs = [{ v: "signals", label: "📡 Signals" }, { v: "track", label: "🎯 Track Record" }, { v: "forex", label: "💱 Forex Bot" }, { v: "settings", label: "⚙️ Settings" }];
  $("tabs").innerHTML = tabs.map((t) => `<button data-tab="${t.v}" class="-mb-px border-b-2 px-4 py-2 ${t.v === activeTab ? "border-indigo-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}">${t.label}</button>`).join("");
  $("tabs").querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => {
    activeTab = b.dataset.tab;
    $("tab-signals").classList.toggle("hidden", activeTab !== "signals");
    $("tab-track").classList.toggle("hidden", activeTab !== "track");
    $("tab-forex").classList.toggle("hidden", activeTab !== "forex");
    $("tab-settings").classList.toggle("hidden", activeTab !== "settings");
    drawTabs();
    if (activeTab === "track") loadTrack();
    if (activeTab === "settings") loadSettings();
    if (activeTab === "forex") loadForex();
  }));
}

// ---------- Settings / testnet trading ----------
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("set-thr").textContent = `≥${s.trackMinConfidence}%`;
    $("set-usd2").textContent = s.tradeUsd;
    $("set-usd").value = s.tradeUsd;
    $("set-auto").checked = !!s.autoTrade;
    $("set-quality").checked = !!s.qualityOnly;
    $("set-hold").checked = !!s.holdThroughDips;
    $("set-regime").checked = !!s.regimeFilter;
    if (s.exitStyle) $("set-exit").value = s.exitStyle;
    $("set-approval").checked = !!s.tgApproval;
    if (s.positionUsd != null) $("set-position").value = s.positionUsd;
    if (s.leverage != null) $("set-leverage").value = s.leverage;
    if (s.capitalUsd != null) $("set-capital").value = s.capitalUsd;
    $("set-tg").innerHTML = s.telegramReady
      ? `<span class="text-emerald-400">✓ Telegram connected (${s.telegramChats} chat${s.telegramChats === 1 ? "" : "s"})</span>`
      : !s.telegramTokenSet
        ? '<span class="text-rose-400">✗ No bot token. Set <b>TELEGRAM_BOT_TOKEN</b> in Railway → Variables, then redeploy.</span>'
        : '<span class="text-amber-400">Bot is on, but no chat linked. Open your bot in Telegram and send <b>/start</b> once.</span>';
    $("set-key").placeholder = s.configured ? `saved: ${s.keyMasked} (enter to replace)` : "Testnet API key";
    $("set-proxy").placeholder = s.proxySet ? "saved (enter to replace, or blank to keep)" : "http://user:pass@host:port  (optional)";
    if ($("set-proxytn")) $("set-proxytn").checked = s.proxyTestnet !== false;
    let note = "";
    if (s.lastError) note += `<span class="text-rose-400">⚠ ${s.lastError}</span><br>`;
    if (!s.durableSettings) note += '<span class="text-amber-400">Note: no database - keys reset on redeploy. Set DATABASE_URL to persist.</span>';
    $("set-status").innerHTML = note;
  } catch (e) { /* ignore */ }
  loadTestnetTrades();
}
async function loadTestnetTrades() {
  let t;
  try { t = await api("/api/testnet/trades"); } catch (e) { return; }
  const chip = (l, v, cls) => `<span class="pill border border-edge bg-panel px-3 py-1.5 text-slate-300">${l} <b class="${cls || "text-white"}">${v}</b></span>`;
  $("tn-summary").innerHTML = [
    chip("Auto-trade", t.autoTrade ? "ON" : "off", t.autoTrade ? "text-emerald-400" : "text-slate-400"),
    chip("Total PnL", "$" + (t.totalPnlUsd ?? 0), t.totalPnlUsd > 0 ? "text-emerald-400" : t.totalPnlUsd < 0 ? "text-rose-400" : ""),
    chip("Closed", t.closed),
    chip("Win/Loss", `${t.wins}/${t.losses}`),
    chip("Open", t.open.length),
  ].join(" ");
  $("tn-open").innerHTML = t.open.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Coin</th><th class="text-right">Qty</th><th class="text-right">Entry</th><th class="text-right">TP1</th><th class="text-right">Stop</th><th>Opened (SL)</th></tr></thead><tbody>${t.open.map((x) => `<tr class="border-b border-edge/60"><td class="py-1.5 font-semibold">${x.symbol}</td><td class="py-1.5 text-right tabular-nums">${x.qty}</td><td class="py-1.5 text-right tabular-nums">${usd(x.entry_price)}</td><td class="py-1.5 text-right tabular-nums text-emerald-300">${usd(x.tp1)}</td><td class="py-1.5 text-right tabular-nums text-rose-300">${usd(x.stop)}</td><td class="py-1.5 text-xs text-slate-400">${slTime(x.opened_at)}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No open positions. A ≥95% LONG signal opens one automatically when auto-trade is on.</td></tr></tbody>';
  $("tn-recent").innerHTML = t.recent.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Coin</th><th class="text-right">Entry</th><th class="text-right">Exit</th><th>Reason</th><th class="text-right">PnL $</th><th class="text-right">PnL %</th><th>Closed (SL)</th></tr></thead><tbody>${t.recent.map((x) => `<tr class="border-b border-edge/60"><td class="py-1.5 font-semibold">${x.symbol}</td><td class="py-1.5 text-right tabular-nums">${usd(x.entry_price)}</td><td class="py-1.5 text-right tabular-nums">${usd(x.exit_price)}</td><td class="py-1.5 text-xs ${x.exit_reason === "TP1" ? "text-emerald-400" : "text-rose-400"}">${x.exit_reason}</td><td class="py-1.5 text-right tabular-nums ${x.pnl_usd > 0 ? "text-emerald-400" : x.pnl_usd < 0 ? "text-rose-400" : "text-slate-400"}">${x.pnl_usd > 0 ? "+" : ""}${x.pnl_usd}</td><td class="py-1.5 text-right tabular-nums ${x.pnl_pct > 0 ? "text-emerald-400" : "text-rose-400"}">${x.pnl_pct > 0 ? "+" : ""}${x.pnl_pct}%</td><td class="py-1.5 text-xs text-slate-500">${slTime(x.closed_at)}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No closed trades yet.</td></tr></tbody>';
}
async function saveSettings() {
  const body = { autoTrade: $("set-auto").checked, tradeUsd: Number($("set-usd").value) || 100, qualityOnly: $("set-quality").checked, holdThroughDips: $("set-hold").checked, regimeFilter: $("set-regime").checked, exitStyle: $("set-exit").value, tgApproval: $("set-approval").checked, positionUsd: Number($("set-position").value) || 20, leverage: Number($("set-leverage").value) || 20, capitalUsd: Number($("set-capital").value) || 200 };
  if ($("set-proxytn")) body.proxyTestnet = $("set-proxytn").checked;
  const k = $("set-key").value.trim(), sec = $("set-secret").value.trim(), px = $("set-proxy").value.trim();
  if (k) body.apiKey = k; if (sec) body.apiSecret = sec; if (px) body.proxyUrl = px;
  $("set-status").textContent = "Saving…";
  try {
    const r = await api2("/api/settings", body);
    $("set-key").value = ""; $("set-secret").value = "";
    await loadSettings(); // refresh state first (this also writes to #set-status)
    const stored = r.durableSettings ? "stored in the database ✓" : "saved (no database - they reset on redeploy; set DATABASE_URL to keep them)";
    $("set-status").innerHTML = `<span class="text-emerald-400">✓ Keys ${stored}</span><br><span class="text-slate-500">Now press <b>Test connection</b>. If Test fails with a geo-block, that's a network issue (add a Proxy URL) - your keys are still saved.</span>`;
  } catch (e) { $("set-status").innerHTML = `<span class="text-rose-400">Save failed: ${e.message}</span>`; }
}
async function testConnection() {
  $("set-status").textContent = "Testing…";
  try { const r = await api2("/api/settings/test", {}); $("set-status").innerHTML = r.ok ? `<span class="text-emerald-400">✓ Connected. Tradeable ${r.usdtFree} USDT on testnet.</span>` : `<span class="text-rose-400">${r.error}</span>`; }
  catch (e) { $("set-status").innerHTML = `<span class="text-rose-400">${e.message}</span>`; }
}
async function clearKeys() {
  try { await api2("/api/settings", { clearKeys: true }); $("set-status").innerHTML = '<span class="text-amber-400">Keys cleared.</span>'; loadSettings(); } catch (e) { /* ignore */ }
}
// Test every pasted proxy against real Binance endpoints; show which work + let
// you use the best one with one click.
async function testProxies() {
  const raw = $("proxy-list").value.trim();
  if (!raw) { $("proxy-status").textContent = "Paste at least one proxy line."; return; }
  const proxies = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  $("proxy-status").textContent = `Testing ${proxies.length}… (a few seconds each)`;
  $("proxy-results").innerHTML = "";
  try {
    const r = await api2("/api/proxy/test", { proxies });
    $("proxy-status").innerHTML = `<span class="${r.workingCount ? "text-emerald-400" : "text-rose-400"}">${r.workingCount}/${r.count} working for market data.</span>`;
    $("proxy-results").innerHTML = r.results.map((x) => {
      const ok = x.ok;
      const badge = ok ? '<span class="text-emerald-400">✅ works</span>' : '<span class="text-rose-400">❌ blocked</span>';
      const region = x.exitCc ? ` · ${x.exitCc}${x.exitIp ? " (" + x.exitIp + ")" : ""}` : "";
      const detail = `data ${x.data === "ok" ? "✓" : "✗"} · testnet ${x.testnet === "ok" ? "✓" : "✗"}${x.ms != null ? " · " + x.ms + "ms" : ""}${region}`;
      const use = ok ? ` <button data-proxy="${encodeURIComponent(x.proxy)}" class="proxy-use rounded border border-edge bg-panel px-2 py-0.5 text-[11px] hover:bg-edge">Use this</button>` : "";
      return `<div class="rounded border border-edge bg-ink/40 px-2 py-1"><div class="flex items-center justify-between gap-2"><span class="font-mono text-[11px] text-slate-300">${(x.host || x.proxy)}:${x.port || ""}</span><span>${badge}${use}</span></div><div class="text-[11px] text-slate-500">${detail}</div></div>`;
    }).join("");
    document.querySelectorAll(".proxy-use").forEach((b) => b.onclick = () => {
      $("set-proxy").value = decodeURIComponent(b.dataset.proxy);
      $("proxy-status").innerHTML = '<span class="text-emerald-400">Filled the Proxy URL above — click Save to keep it.</span>';
      $("set-proxy").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  } catch (e) { $("proxy-status").innerHTML = `<span class="text-rose-400">${e.message}</span>`; }
}
// POST helper
async function api2(p, body) {
  const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
}

// ---------- Forex Bot ----------
let FXCFG = null;
const fxNum = (n) => (Number.isFinite(+n) ? (+n).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-");
async function loadForex() {
  try { FXCFG = await api("/api/forex/config"); } catch (e) { return; }
  const s = FXCFG;
  $("fx-risk2").textContent = s.riskPerTradeUsd;
  $("fx-account").placeholder = s.configured ? `saved ${s.accountId} (enter to replace)` : "101-001-…";
  $("fx-key").placeholder = s.configured ? `saved ${s.keyMasked} (enter to replace)` : "OANDA API token";
  $("fx-type").value = s.accountType; $("fx-pair").value = s.pair; $("fx-tf").value = s.granularity;
  $("fx-risk").value = s.riskPerTradeUsd; $("fx-dailyloss").value = s.dailyMaxLossUsd;
  // strategy dropdown
  const strat = $("fx-strategy");
  strat.innerHTML = Object.entries(s.strategies).map(([k, v]) => `<option value="${k}" ${k === s.strategy ? "selected" : ""}>${v.name}</option>`).join("");
  renderFxParams(s);
  // diagnostic
  const el = $("fx-diag");
  if (!s.configured) { el.className = "mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"; el.innerHTML = "Connect an OANDA <b>practice</b> account below to start. See the setup guide in the README."; el.classList.remove("hidden"); }
  else if (s.lastError) { el.className = "mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"; el.innerHTML = "⚠ " + s.lastError; el.classList.remove("hidden"); }
  else if (!s.durable) { el.className = "mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"; el.innerHTML = "No database - config and trade log reset on redeploy. Set DATABASE_URL to persist."; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
  loadForexLive(); loadForexTrades();
}
function renderFxParams(s) {
  const key = ($("fx-strategy") && $("fx-strategy").value) || s.strategy;
  const p = ((s.strategies && s.strategies[key]) || {}).defaults || s.params || {};
  const cur = s.params || {};
  $("fx-params").innerHTML = `<label class="mb-1 block text-xs text-slate-400">Strategy parameters</label><div class="grid grid-cols-3 gap-2">${Object.keys(p).map((k) => `<div><span class="text-[11px] text-slate-500">${k}</span><input data-param="${k}" type="number" step="any" value="${cur[k] ?? p[k]}" class="w-full rounded border border-edge bg-ink px-2 py-1 text-xs" /></div>`).join("")}</div>`;
}
function fxParamsBody() { const o = {}; document.querySelectorAll("#fx-params [data-param]").forEach((i) => { if (i.value !== "") o[i.dataset.param] = Number(i.value); }); return o; }
async function saveForex() {
  const body = { accountType: $("fx-type").value, pair: $("fx-pair").value.trim().toUpperCase(), granularity: $("fx-tf").value, strategy: $("fx-strategy").value, riskPerTradeUsd: Number($("fx-risk").value) || 10, dailyMaxLossUsd: Number($("fx-dailyloss").value) || 50, params: fxParamsBody() };
  const k = $("fx-key").value.trim(), a = $("fx-account").value.trim();
  if (k) body.apiKey = k; if (a) body.accountId = a;
  $("fx-status").textContent = "Saving…";
  try {
    const r = await api2("/api/forex/config", body);
    $("fx-key").value = ""; $("fx-account").value = "";
    await loadForex();
    const stored = r.durable ? "stored in the database ✓" : "saved (no database - they reset on redeploy)";
    $("fx-status").innerHTML = `<span class="text-emerald-400">✓ Keys ${stored}</span><br><span class="text-slate-500">Now press <b>Test connection</b>. OANDA is usually not geo-blocked - if it fails, re-check the token/account id.</span>`;
  } catch (e) { $("fx-status").innerHTML = `<span class="text-rose-400">Save failed: ${e.message}</span>`; }
}
async function testForex() {
  $("fx-status").textContent = "Testing…";
  try { const r = await api2("/api/forex/test", {}); $("fx-status").innerHTML = r.ok ? `<span class="text-emerald-400">✓ Connected (${r.accountType}). Balance ${fxNum(r.balance)} ${r.currency}, ${r.openTradeCount} open.</span>` : `<span class="text-rose-400">${r.error}</span>`; }
  catch (e) { $("fx-status").innerHTML = `<span class="text-rose-400">${e.message}</span>`; }
}
async function loadForexLive() {
  let l; try { l = await api("/api/forex/live"); } catch (e) { return; }
  const badge = l.halted ? '<span class="pill bg-rose-900 text-rose-200">Halted (daily loss)</span>' : l.running ? '<span class="pill bg-emerald-900 text-emerald-200">Running</span>' : '<span class="pill bg-slate-800 text-slate-400">Stopped</span>';
  $("fx-live").innerHTML = `${badge} ${l.running ? `${l.pair} · ${l.granularity} · day PnL <b class="${l.dayPnl > 0 ? "text-emerald-400" : l.dayPnl < 0 ? "text-rose-400" : ""}">${fxNum(l.dayPnl)}</b> / -${fxNum(l.dailyMaxLossUsd)} limit` : ""}${l.note ? `<div class="mt-1 text-slate-500">${l.note}</div>` : ""}`;
  const open = (await api("/api/forex/trades?mode=live&limit=50").catch(() => ({ trades: [] }))).trades.filter((t) => t.status === "open");
  $("fx-open").innerHTML = open.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Pair</th><th>Side</th><th class="text-right">Entry</th><th class="text-right">SL</th><th class="text-right">TP</th><th class="text-right">Size</th></tr></thead><tbody>${open.map((t) => `<tr class="border-b border-edge/60"><td class="py-1.5">${t.currency_pair}</td><td class="py-1.5 ${t.side === "buy" ? "text-emerald-400" : "text-rose-400"}">${t.side}</td><td class="py-1.5 text-right tabular-nums">${t.entry_price}</td><td class="py-1.5 text-right tabular-nums text-rose-300">${t.stop_loss}</td><td class="py-1.5 text-right tabular-nums text-emerald-300">${t.take_profit}</td><td class="py-1.5 text-right tabular-nums">${t.position_size}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="py-2 text-slate-500">No open positions.</td></tr></tbody>';
}
async function runForexBacktest() {
  $("fx-bt-status").textContent = "Running… (pulls history from OANDA)";
  try {
    const b = await api2("/api/forex/backtest", { count: Number($("fx-bt-count").value) || 1500 });
    if (b.error) { $("fx-bt-status").innerHTML = `<span class="text-rose-400">${b.error}</span>`; return; }
    $("fx-bt-status").textContent = "";
    const s = b.summary;
    const chip = (l, v, cls) => `<span class="pill border border-edge bg-panel px-3 py-1.5 text-slate-300">${l} <b class="${cls || "text-white"}">${v}</b></span>`;
    $("fx-bt-summary").innerHTML = [
      chip("Trades", s.trades), chip("Win rate", (s.winRatePct ?? "-") + "%", s.winRatePct >= 50 ? "text-emerald-400" : "text-rose-400"),
      chip("Total PnL", fxNum(s.totalPnl), s.totalPnl > 0 ? "text-emerald-400" : "text-rose-400"),
      chip("Avg / trade", fxNum(s.avgPnl)), chip("Max DD", fxNum(s.maxDrawdown), "text-rose-400"), chip("Sharpe", s.sharpe ?? "-"),
    ].join(" ");
    $("fx-equity").innerHTML = equitySvg(b.equity);
    loadForexTrades();
  } catch (e) { $("fx-bt-status").innerHTML = `<span class="text-rose-400">${e.message}</span>`; }
}
function equitySvg(points) {
  if (!points || !points.length) return '<p class="text-xs text-slate-500">No equity to plot.</p>';
  const W = 640, H = 140, pad = 6, ys = points.map((p) => p.equity), min = Math.min(0, ...ys), max = Math.max(0, ...ys), span = max - min || 1;
  const x = (i) => pad + (i / (points.length - 1 || 1)) * (W - 2 * pad), y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const zero = y(0), up = ys[ys.length - 1] >= 0;
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full" style="max-width:100%"><line x1="${pad}" y1="${zero}" x2="${W - pad}" y2="${zero}" stroke="#334155" stroke-dasharray="3 3"/><path d="${d}" fill="none" stroke="${up ? "#10b981" : "#f43f5e"}" stroke-width="1.5"/></svg>`;
}
async function loadForexTrades() {
  const mode = $("fx-h-mode").value, pair = $("fx-h-pair").value.trim().toUpperCase();
  const qs = new URLSearchParams({ limit: 200 }); if (mode) qs.set("mode", mode); if (pair) qs.set("pair", pair);
  $("fx-h-csv").href = "/api/forex/trades.csv?" + qs.toString();
  let rows; try { rows = (await api("/api/forex/trades?" + qs.toString())).trades; } catch (e) { return; }
  $("fx-history").innerHTML = rows.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Mode</th><th>Pair</th><th>Side</th><th class="text-right">Entry</th><th class="text-right">Exit</th><th class="text-right">Size</th><th class="text-right">PnL</th><th>Status</th><th class="text-right">Opened</th></tr></thead><tbody>${rows.map((t) => `<tr class="border-b border-edge/60"><td class="py-1.5"><span class="pill ${t.mode === "live" ? "bg-sky-900 text-sky-200" : "bg-slate-800 text-slate-300"}">${t.mode}</span></td><td class="py-1.5">${t.currency_pair}</td><td class="py-1.5 ${t.side === "buy" ? "text-emerald-400" : "text-rose-400"}">${t.side}</td><td class="py-1.5 text-right tabular-nums">${t.entry_price ?? "-"}</td><td class="py-1.5 text-right tabular-nums">${t.exit_price ?? "-"}</td><td class="py-1.5 text-right tabular-nums">${t.position_size ?? "-"}</td><td class="py-1.5 text-right tabular-nums ${t.pnl > 0 ? "text-emerald-400" : t.pnl < 0 ? "text-rose-400" : "text-slate-400"}">${t.pnl != null ? fxNum(t.pnl) : "-"}</td><td class="py-1.5 text-xs ${t.status === "open" ? "text-sky-400" : "text-slate-400"}">${t.status}</td><td class="py-1.5 text-right text-xs text-slate-500">${t.opened_at ? slTime(t.opened_at) : ""}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No trades yet. Run a backtest or start the live bot.</td></tr></tbody>';
}

async function init() {
  try { CONFIG = await api("/api/config"); } catch (e) { /* defaults */ }
  tf = CONFIG.tf || "1h";
  drawTabs();
  seg($("tf-buttons"), (CONFIG.timeframes || ["15m", "1h", "4h", "1d"]).map((t) => ({ v: t, label: t })), tf, (v) => { tf = v; drawSegs(); load(); });
  seg($("filter-buttons"), [{ v: "actionable", label: "Actionable" }, { v: "quality", label: "⭐ Quality" }, { v: "LONG", label: "Long" }, { v: "SHORT", label: "Short" }, { v: "all", label: "All" }], filter, (v) => { filter = v; drawSegs(); render(); });
  $("search").oninput = (e) => { search = e.target.value.trim(); render(); };
  drawTrackTf();
  $("track-search").oninput = (e) => { trackSearch = e.target.value.trim().toUpperCase(); renderTrackedFiltered(); };
  $("btn-refresh").onclick = rescan;
  $("chart-close").onclick = closeChart;
  $("chart-modal").onclick = (e) => { if (e.target.id === "chart-modal") closeChart(); };
  $("an-close").onclick = closeAnalysis;
  $("analysis-modal").onclick = (e) => { if (e.target.id === "analysis-modal") closeAnalysis(); };
  $("trade-close").onclick = () => { const m = $("trade-modal"); m.classList.add("hidden"); m.classList.remove("flex"); };
  $("trade-modal").onclick = (e) => { if (e.target.id === "trade-modal") { const m = $("trade-modal"); m.classList.add("hidden"); m.classList.remove("flex"); } };
  $("set-save").onclick = saveSettings;
  $("set-test").onclick = testConnection;
  { const pt = $("proxy-test"); if (pt) pt.onclick = testProxies; }
  $("set-clear").onclick = clearKeys;
  setInterval(() => { if (activeTab === "settings") loadTestnetTrades(); }, 15000); // refresh testnet PnL
  // Forex bot wiring
  $("fx-save").onclick = saveForex;
  $("fx-test").onclick = testForex;
  $("fx-strategy").onchange = () => renderFxParams(FXCFG || { strategies: {}, params: {} });
  $("fx-bt-run").onclick = runForexBacktest;
  $("fx-start").onclick = async () => { try { await api2("/api/forex/live/start", {}); loadForexLive(); } catch (e) { $("fx-status").innerHTML = `<span class="text-rose-400">${e.message}</span>`; } };
  $("fx-stop").onclick = async () => { try { await api2("/api/forex/live/stop", {}); loadForexLive(); } catch (e) { /* ignore */ } };
  $("fx-h-refresh").onclick = loadForexTrades;
  setInterval(() => { if (activeTab === "forex") loadForexLive(); }, 20000); // refresh live status
  await load();
  const ms = Math.max(3, CONFIG.scanIntervalSec || 5) * 1000; // live signals auto-refresh
  setInterval(load, ms);
  // Track Record refreshes gently (every 30s) so open trades don't flicker every 5s.
  setInterval(() => { if (activeTab === "track") loadTrack(); }, 30000);
}

function drawSegs() {
  seg($("tf-buttons"), (CONFIG.timeframes || ["15m", "1h", "4h", "1d"]).map((t) => ({ v: t, label: t })), tf, (v) => { tf = v; drawSegs(); load(); });
  seg($("filter-buttons"), [{ v: "actionable", label: "Actionable" }, { v: "quality", label: "⭐ Quality" }, { v: "LONG", label: "Long" }, { v: "SHORT", label: "Short" }, { v: "all", label: "All" }], filter, (v) => { filter = v; drawSegs(); render(); });
}

init();
