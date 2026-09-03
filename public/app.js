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
  const head = `<div class="flex items-center justify-between">
      <span class="text-base font-bold" style="color:${coinColor(s.symbol)}">${s.symbol}<span class="ml-1 text-xs font-normal text-slate-500">${s.tf}${s.changePct != null ? ` · ${s.changePct > 0 ? "+" : ""}${s.changePct}%/24h` : ""}</span></span>
      <span class="pill border ${d.cls}">${s.direction} ${s.confidence}%</span>
    </div>
    <div class="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-800"><div style="width:${s.confidence}%;background:${d.bar}" class="h-full"></div></div>
    <p class="mt-2 text-xs text-slate-500">${usd(s.priceUsd)} · RSI ${ind.rsi14 ?? "—"} · MFI ${ind.mfi ?? "—"}</p>`;

  if (s.direction === "NEUTRAL" || !s.entry) {
    return `<div class="card p-4">${head}<p class="mt-2 text-sm text-slate-400">${s.note || "Stand aside."}</p><div class="mt-2 flex flex-wrap gap-1">${chips}</div></div>`;
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
    <div class="mt-2 flex flex-wrap gap-1">${chips}</div>
    <p class="mt-2 text-[11px] text-slate-500">${s.invalidation || ""}</p>
  </div>`;
}

function render() {
  let list = last.signals || [];
  if (filter === "actionable") list = list.filter((s) => s.direction === "LONG" || s.direction === "SHORT");
  else if (filter === "LONG" || filter === "SHORT") list = list.filter((s) => s.direction === filter);
  if (search) list = list.filter((s) => s.symbol.includes(search.toUpperCase()));
  $("signals").innerHTML = list.map(card).join("");
  const empty = $("empty");
  if (!list.length) {
    empty.classList.remove("hidden");
    empty.textContent = search ? `No coin matches "${search}".` : "No actionable setups right now — the market may be ranging. Try another timeframe or the All filter.";
  } else empty.classList.add("hidden");
}

async function load() {
  try {
    const data = await api(`/api/signals?tf=${encodeURIComponent(tf)}`);
    last = data;
    $("updated").textContent = data.generatedAt ? `updated ${new Date(data.generatedAt).toLocaleTimeString()}` : "";
    $("summary").textContent = `${data.actionable} setups · scanned ${data.universe} coins · ${tf}`;
    render();
  } catch (e) {
    $("empty").classList.remove("hidden");
    $("empty").textContent = e.message;
  }
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

async function init() {
  try { CONFIG = await api("/api/config"); } catch (e) { /* defaults */ }
  tf = CONFIG.tf || "1h";
  seg($("tf-buttons"), (CONFIG.timeframes || ["5m", "15m", "1h", "4h"]).map((t) => ({ v: t, label: t })), tf, (v) => { tf = v; drawSegs(); load(); });
  seg($("filter-buttons"), [{ v: "actionable", label: "Actionable" }, { v: "LONG", label: "Long" }, { v: "SHORT", label: "Short" }, { v: "all", label: "All" }], filter, (v) => { filter = v; drawSegs(); render(); });
  $("search").oninput = (e) => { search = e.target.value.trim(); render(); };
  $("btn-refresh").onclick = rescan;
  await load();
  setInterval(load, 60000);
}

function drawSegs() {
  seg($("tf-buttons"), (CONFIG.timeframes || ["5m", "15m", "1h", "4h"]).map((t) => ({ v: t, label: t })), tf, (v) => { tf = v; drawSegs(); load(); });
  seg($("filter-buttons"), [{ v: "actionable", label: "Actionable" }, { v: "LONG", label: "Long" }, { v: "SHORT", label: "Short" }, { v: "all", label: "All" }], filter, (v) => { filter = v; drawSegs(); render(); });
}

init();
