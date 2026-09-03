// Crypto Signal Engine — signals-only client.
const COLORS = { BTC: "#f7931a", ETH: "#8b9dff", SOL: "#14f195", BNB: "#f3ba2f" };
const DIR = {
  LONG: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", bar: "#10b981" },
  SHORT: { cls: "bg-rose-500/15 text-rose-300 border-rose-500/40", bar: "#f43f5e" },
  NEUTRAL: { cls: "bg-slate-500/15 text-slate-300 border-slate-500/40", bar: "#64748b" },
};
let CONFIG = { tf: "1h", timeframes: ["5m", "15m", "1h", "4h"] };
let tf = "1h";
let filter = "actionable"; // actionable | LONG | SHORT | all
let search = "";
let last = { signals: [] };

const $ = (id) => document.getElementById(id);
const usd = (n) => (Number.isFinite(n) ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : n < 100 ? 4 : 2 }) : "—");
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

function card(s) {
  const d = DIR[s.direction] || DIR.NEUTRAL;
  if (s.error) return `<div class="card p-4 opacity-50"><div class="flex justify-between"><b style="color:${coinColor(s.symbol)}">${s.symbol}</b><span class="pill bg-slate-800">no data</span></div></div>`;
  const ind = s.indicators || {};
  const chips = (s.reasons || []).slice(0, 3).map((r) => `<span class="pill bg-slate-800 text-slate-400">${r}</span>`).join(" ");
  const chartBtn = `<button data-chart="${s.symbol}" data-tf="${s.tf}" class="rounded-md border border-edge bg-panel px-2 py-1 text-xs text-slate-300 hover:bg-edge">📈 Chart</button>`;
  const head = `<div class="flex items-center justify-between">
      <span class="text-base font-bold" style="color:${coinColor(s.symbol)}">${s.symbol}<span class="ml-1 text-xs font-normal text-slate-500">${s.tf}${s.changePct != null ? ` · ${s.changePct > 0 ? "+" : ""}${s.changePct}%/24h` : ""}</span></span>
      <span class="pill border ${d.cls}">${s.direction} ${s.confidence}%</span>
    </div>
    <div class="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-800"><div style="width:${s.confidence}%;background:${d.bar}" class="h-full"></div></div>
    <p class="mt-2 text-xs text-slate-500">${usd(s.priceUsd)} · RSI ${ind.rsi14 ?? "—"} · ADX ${ind.adx ?? "—"} · StochRSI ${ind.stochRsi ?? "—"} · MFI ${ind.mfi ?? "—"}</p>`;

  if (s.direction === "NEUTRAL" || !s.entry) {
    return `<div class="card p-4">${head}<p class="mt-2 text-sm text-slate-400">${s.note || "Stand aside."}</p><div class="mt-2 flex items-center justify-between"><div class="flex flex-wrap gap-1">${chips}</div>${chartBtn}</div></div>`;
  }
  const readyCls = s.entry.status === "READY" ? "text-emerald-300" : "text-amber-300";
  const tps = s.targets.map((t) => `<div class="flex justify-between text-sm"><span class="text-slate-400">${t.name} <span class="text-slate-600">${t.rr}R</span></span><span class="tabular-nums">${usd(t.priceUsd)} <span class="text-slate-500">${t.etaLabel}</span></span></div>`).join("");
  const f = s.forecast || {};
  return `<div class="card glow p-4">${head}
    <div class="mt-2 flex items-center justify-between text-xs"><span class="${readyCls} font-medium">${s.entry.status}</span><span class="text-slate-500">forecast ${f.horizon}: ${usd(f.priceUsd)}</span></div>
    <div class="mt-2 space-y-1 rounded-lg border border-edge bg-ink/50 p-2">
      <div class="flex justify-between text-sm"><span class="text-slate-400">Entry</span><span class="tabular-nums text-slate-100">${usd(s.entry.low)} – ${usd(s.entry.high)}</span></div>
      <div class="flex justify-between text-sm"><span class="text-rose-400">Stop</span><span class="tabular-nums text-rose-300">${usd(s.stop.priceUsd)} <span class="text-slate-500">-${s.stop.riskPct}%</span></span></div>
      <div class="my-1 border-t border-edge"></div>${tps}
    </div>
    <div class="mt-2 flex items-center justify-between gap-2"><div class="flex flex-wrap gap-1">${chips}</div>${chartBtn}</div>
    <p class="mt-2 text-[11px] text-slate-500">${s.invalidation || ""}</p>
  </div>`;
}

function render() {
  let list = last.signals || [];
  if (filter === "actionable") list = list.filter((s) => s.direction === "LONG" || s.direction === "SHORT");
  else if (filter === "LONG" || filter === "SHORT") list = list.filter((s) => s.direction === filter);
  if (search) list = list.filter((s) => s.symbol.includes(search.toUpperCase()));
  $("signals").innerHTML = list.map(card).join("");
  $("signals").querySelectorAll("[data-chart]").forEach((b) => (b.onclick = () => openChart(b.dataset.chart, b.dataset.tf)));
  const empty = $("empty");
  if (!list.length) {
    empty.classList.remove("hidden");
    empty.textContent = search ? `No coin matches "${search}".` : "No actionable setups right now — the market may be ranging. Try another timeframe or the All filter.";
  } else empty.classList.add("hidden");
}

const STATUS_CLS = { WIN: "text-emerald-400", LOSS: "text-rose-400", EXPIRED: "text-slate-400", ACTIVE: "text-sky-400", WAITING: "text-amber-400" };

function renderStats(s) {
  const chip = (label, val, cls) => `<span class="pill border border-edge bg-panel px-3 py-1.5 text-slate-300">${label} <b class="${cls || "text-white"}">${val}</b></span>`;
  const wr = s.winRatePct;
  $("stats").innerHTML = [
    chip("Win rate", wr == null ? "—" : wr + "%", wr == null ? "" : wr >= 55 ? "text-emerald-400" : wr >= 45 ? "text-sky-400" : "text-rose-400"),
    chip("Decided", s.decided),
    chip("TP1", (s.tp1RatePct ?? "—") + "%"),
    chip("TP2", (s.tp2RatePct ?? "—") + "%"),
    chip("TP3", (s.tp3RatePct ?? "—") + "%"),
    chip("Avg R", s.avgResultR ?? "—", s.avgResultR > 0 ? "text-emerald-400" : s.avgResultR < 0 ? "text-rose-400" : ""),
    chip("Open", s.open),
  ].join(" ");
  $("track-note").textContent = s.durable ? "" : "· in-memory (set DATABASE_URL to persist across restarts)";
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

function renderTracked(t) {
  const openRows = (t.open || []).map((x) => `<tr class="border-b border-edge/60">
      <td class="py-1.5 font-semibold" style="color:${coinColor(x.symbol)}">${x.symbol}</td>
      <td class="py-1.5">${tfPill(x.tf)}</td>
      <td class="py-1.5"><span class="pill ${x.direction === "LONG" ? "bg-emerald-900 text-emerald-200" : "bg-rose-900 text-rose-200"}">${x.direction}</span></td>
      <td class="py-1.5 ${STATUS_CLS[x.status]}">${x.status}${x.tp1_hit ? " · TP1" : ""}${x.tp2_hit ? "·TP2" : ""}</td>
      <td class="py-1.5 text-right tabular-nums text-slate-400">${usd(x.entry_mid)}</td>
      <td class="py-1.5 text-right tabular-nums text-rose-300">${usd(x.stop)}</td>
      <td class="py-1.5 text-right tabular-nums">${x.currentPrice != null ? usd(x.currentPrice) : "—"}</td>
      <td class="py-1.5 text-right tabular-nums ${x.openR > 0 ? "text-emerald-400" : x.openR < 0 ? "text-rose-400" : "text-slate-400"}">${x.openR != null ? x.openR + "R" : "—"}</td>
    </tr>`).join("");
  $("open-table").innerHTML = (t.open || []).length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Coin</th><th>TF</th><th>Dir</th><th>Status</th><th class="text-right">Entry</th><th class="text-right">Stop</th><th class="text-right">Price</th><th class="text-right">Open R</th></tr></thead><tbody>${openRows}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No open tracked signals yet. High-confidence setups are logged automatically.</td></tr></tbody>';

  const recRows = (t.recent || []).map((x) => `<tr class="border-b border-edge/60">
      <td class="py-1.5 font-semibold" style="color:${coinColor(x.symbol)}">${x.symbol}</td>
      <td class="py-1.5">${tfPill(x.tf)}</td>
      <td class="py-1.5"><span class="pill ${x.direction === "LONG" ? "bg-emerald-900 text-emerald-200" : "bg-rose-900 text-rose-200"}">${x.direction}</span></td>
      <td class="py-1.5 ${STATUS_CLS[x.status]}">${x.status}${x.tp3_hit ? " · TP3" : x.tp2_hit ? " · TP2" : x.tp1_hit ? " · TP1" : ""}</td>
      <td class="py-1.5 text-right tabular-nums ${x.result_r > 0 ? "text-emerald-400" : x.result_r < 0 ? "text-rose-400" : "text-slate-400"}">${x.result_r != null ? x.result_r + "R" : "—"}</td>
      <td class="py-1.5 text-right text-xs text-slate-500">${x.closed_at ? new Date(x.closed_at).toLocaleString() : ""}</td>
    </tr>`).join("");
  $("recent-table").innerHTML = (t.recent || []).length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th>Coin</th><th>TF</th><th>Dir</th><th>Result</th><th class="text-right">R</th><th class="text-right">Closed</th></tr></thead><tbody>${recRows}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">No closed results yet — check back as signals resolve.</td></tr></tbody>';
}

async function loadTrack() {
  try {
    const [s, t] = await Promise.all([api("/api/stats"), api("/api/tracked")]);
    renderStats(s);
    renderByTf(s.byTimeframe);
    renderTracked(t);
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
  if (typeof LightweightCharts === "undefined") { alert("Chart library still loading — try again in a moment."); return; }
  const m = $("chart-modal"); m.classList.remove("hidden"); m.classList.add("flex");
  $("chart-title").innerHTML = `<span style="color:${coinColor(sym)}">${sym}</span> · ${tfv}`;
  $("chart-plan").innerHTML = "";
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
  $("chart-legend").innerHTML = `EMA <span style="color:#818cf8">20</span> <span style="color:#22d3ee">50</span> <span style="color:#f59e0b">200</span>`;

  const sig = (last.signals || []).find((x) => x.symbol === sym);
  if (sig && sig.entry) {
    const line = (price, color, style, title) => cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    line(sig.entry.low, "#818cf8", 2, "Entry");
    line(sig.entry.high, "#818cf8", 2, "");
    line(sig.stop.priceUsd, "#f43f5e", 0, "Stop");
    sig.targets.forEach((t) => line(t.priceUsd, "#10b981", 2, `${t.name} (${t.rr}R)`));
    $("chart-plan").innerHTML = [
      `<span class="pill ${sig.direction === "LONG" ? "bg-emerald-900 text-emerald-200" : "bg-rose-900 text-rose-200"}">${sig.direction} ${sig.confidence}%</span>`,
      `<span class="pill bg-slate-800">Entry ${usd(sig.entry.low)}–${usd(sig.entry.high)}</span>`,
      `<span class="pill bg-slate-800 text-rose-300">Stop ${usd(sig.stop.priceUsd)} (-${sig.stop.riskPct}%)</span>`,
      ...sig.targets.map((t) => `<span class="pill bg-slate-800 text-emerald-300">${t.name} ${usd(t.priceUsd)} ${t.etaLabel}</span>`),
    ].join(" ");
  } else {
    $("chart-plan").innerHTML = '<span class="pill bg-slate-800 text-slate-400">No active setup — chart for reference.</span>';
  }
  c.timeScale().fitContent();
}

async function load() {
  try {
    const data = await api(`/api/signals?tf=${encodeURIComponent(tf)}`);
    last = data;
    $("updated").innerHTML = data.generatedAt ? `<span class="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 align-middle"></span>LIVE · every ${Math.max(3, CONFIG.scanIntervalSec || 5)}s · ${new Date(data.generatedAt).toLocaleTimeString()}` : "";
    $("summary").textContent = `${data.actionable} setups · scanned ${data.universe} coins · ${tf}${data.source ? " · " + data.source : ""}`;
    render();
  } catch (e) {
    $("empty").classList.remove("hidden");
    $("empty").textContent = e.message;
  }
  if (activeTab === "track") loadTrack();
}

async function rescan() {
  const b = $("btn-refresh");
  b.textContent = "Scanning…";
  b.disabled = true;
  try {
    await api(`/api/rescan?tf=${encodeURIComponent(tf)}`).catch(() => {});
    await load();
  } finally {
    b.textContent = "↻ Rescan";
    b.disabled = false;
  }
}

let activeTab = "signals";
function drawTabs() {
  const tabs = [{ v: "signals", label: "📡 Signals" }, { v: "track", label: "🎯 Track Record" }];
  $("tabs").innerHTML = tabs.map((t) => `<button data-tab="${t.v}" class="-mb-px border-b-2 px-4 py-2 ${t.v === activeTab ? "border-indigo-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}">${t.label}</button>`).join("");
  $("tabs").querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => {
    activeTab = b.dataset.tab;
    $("tab-signals").classList.toggle("hidden", activeTab !== "signals");
    $("tab-track").classList.toggle("hidden", activeTab !== "track");
    drawTabs();
    if (activeTab === "track") loadTrack();
  }));
}

async function init() {
  try { CONFIG = await api("/api/config"); } catch (e) { /* defaults */ }
  tf = CONFIG.tf || "1h";
  drawTabs();
  seg($("tf-buttons"), (CONFIG.timeframes || ["5m", "15m", "1h", "4h"]).map((t) => ({ v: t, label: t })), tf, (v) => { tf = v; drawSegs(); load(); });
  seg($("filter-buttons"), [{ v: "actionable", label: "Actionable" }, { v: "LONG", label: "Long" }, { v: "SHORT", label: "Short" }, { v: "all", label: "All" }], filter, (v) => { filter = v; drawSegs(); render(); });
  $("search").oninput = (e) => { search = e.target.value.trim(); render(); };
  $("btn-refresh").onclick = rescan;
  $("chart-close").onclick = closeChart;
  $("chart-modal").onclick = (e) => { if (e.target.id === "chart-modal") closeChart(); };
  await load();
  const ms = Math.max(3, CONFIG.scanIntervalSec || 5) * 1000; // live auto-refresh
  setInterval(load, ms);
}

function drawSegs() {
  seg($("tf-buttons"), (CONFIG.timeframes || ["5m", "15m", "1h", "4h"]).map((t) => ({ v: t, label: t })), tf, (v) => { tf = v; drawSegs(); load(); });
  seg($("filter-buttons"), [{ v: "actionable", label: "Actionable" }, { v: "LONG", label: "Long" }, { v: "SHORT", label: "Short" }, { v: "all", label: "All" }], filter, (v) => { filter = v; drawSegs(); render(); });
}

init();
