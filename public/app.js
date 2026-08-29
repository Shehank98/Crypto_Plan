// Crypto DCA Engine — client logic.
const COIN_COLORS = { BTC: "#f7931a", ETH: "#8b9dff", SOL: "#14f195", BNB: "#f3ba2f", USDT: "#26a17b", USDC: "#2775ca" };
const charts = {};
let CONFIG = { coins: ["BTC", "ETH", "SOL", "BNB"] };
let editingId = null;

const $ = (id) => document.getElementById(id);
const fmtLkr = (n) => "LKR " + Number(n || 0).toLocaleString("en-LK", { maximumFractionDigits: 0 });
const fmtUsd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pctCls = (n) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-rose-400" : "text-slate-300");
const signPct = (n) => (n > 0 ? "+" : "") + Number(n || 0).toFixed(2) + "%";

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- renderers ----------
function renderStats(p) {
  const t = p.totals;
  const cards = [
    { label: "Total Value", main: fmtLkr(t.valueLkr), sub: fmtUsd(t.valueUsd) },
    { label: "Net Profit", main: `<span class="${pctCls(t.netProfitPct)}">${signPct(t.netProfitPct)}</span>`, sub: `Unrealized ${fmtLkr(t.unrealizedLkr)}` },
    { label: "Cash Reserve", main: fmtLkr(t.reserveLkr), sub: "USDT/USDC dry powder" },
    { label: "Next DCA", main: p.nextDcaDate, sub: `Budget ${fmtLkr(p.monthlyBudgetLkr)}/mo` },
  ];
  $("stats").innerHTML = cards
    .map(
      (c) => `<div class="card glow p-4">
        <p class="text-xs text-slate-400">${c.label}</p>
        <p class="mt-1 text-xl font-bold text-white">${c.main}</p>
        <p class="mt-1 text-xs text-slate-500">${c.sub}</p></div>`,
    )
    .join("");
}

function renderDonut(holdings) {
  const data = holdings.filter((h) => h.valueLkr > 0);
  const ctx = $("donut");
  if (charts.donut) charts.donut.destroy();
  if (!data.length) { ctx.parentElement.querySelector("canvas").style.opacity = 0.3; return; }
  charts.donut = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: data.map((h) => h.symbol),
      datasets: [{ data: data.map((h) => h.valueLkr), backgroundColor: data.map((h) => COIN_COLORS[h.symbol] || "#818cf8"), borderColor: "#0b0e14", borderWidth: 2 }],
    },
    options: { plugins: { legend: { labels: { color: "#cbd5e1" } } }, cutout: "62%" },
  });
}

function baseLineOpts(y2) {
  return {
    responsive: true,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: "#cbd5e1" } } },
    scales: {
      x: { ticks: { color: "#64748b", maxTicksLimit: 12 }, grid: { color: "#1e2532" } },
      y: { ticks: { color: "#64748b", callback: (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : (v / 1e3).toFixed(0) + "k") }, grid: { color: "#1e2532" } },
    },
  };
}

function renderDcaLump(d) {
  const ctx = $("dcaLump");
  if (charts.dcaLump) charts.dcaLump.destroy();
  charts.dcaLump = new Chart(ctx, {
    type: "line",
    data: {
      labels: d.labels,
      datasets: [
        { label: "DCA", data: d.dca, borderColor: "#818cf8", backgroundColor: "rgba(129,140,248,.15)", fill: true, tension: 0.25, pointRadius: 0 },
        { label: "Lump Sum", data: d.lump, borderColor: "#22d3ee", borderDash: [5, 4], tension: 0.25, pointRadius: 0 },
      ],
    },
    options: baseLineOpts(),
  });
}

function renderBands(b) {
  const ctx = $("bands");
  if (charts.bands) charts.bands.destroy();
  charts.bands = new Chart(ctx, {
    type: "line",
    data: {
      labels: b.labels,
      datasets: [
        { label: "Bull", data: b.bull, borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,.08)", fill: "+1", tension: 0.25, pointRadius: 0 },
        { label: "Base", data: b.base, borderColor: "#818cf8", tension: 0.25, pointRadius: 0 },
        { label: "Bear", data: b.bear, borderColor: "#f43f5e", backgroundColor: "rgba(244,63,94,.08)", fill: "-1", tension: 0.25, pointRadius: 0 },
      ],
    },
    options: baseLineOpts(),
  });
}

const SIGNAL_COLORS = { STRONG_ACCUMULATE: "text-emerald-400", ACCUMULATE: "text-emerald-300", NEUTRAL: "text-slate-300", REDUCE: "text-amber-400", TAKE_PROFIT: "text-rose-400" };
function renderLadder(alloc, coins) {
  const rows = alloc.perCoin
    .map((c) => {
      const m = coins[c.symbol] || {};
      const sig = m.signal || {};
      const ladder = (c.ladderLkr || []).map((p) => `<span class="pill bg-slate-800 text-slate-300">${fmtLkr(p)}</span>`).join(" ");
      return `<tr class="border-b border-edge/60">
        <td class="py-2 font-semibold" style="color:${COIN_COLORS[c.symbol]}">${c.symbol}</td>
        <td class="py-2 text-right">${m.mayer ?? "—"}</td>
        <td class="py-2 text-right">${m.rsi14 ?? "—"}</td>
        <td class="py-2 text-center"><span class="font-bold ${SIGNAL_COLORS[sig.label] || "text-slate-300"}">${sig.score ?? "—"}</span><br><span class="text-[10px] ${SIGNAL_COLORS[sig.label] || "text-slate-400"}">${(sig.label || "").replace("_", " ")}</span></td>
        <td class="py-2 text-right font-medium">${fmtLkr(c.suggestedLkr)}</td>
        <td class="py-2">${ladder || "—"}</td></tr>`;
    })
    .join("");
  $("ladder").innerHTML =
    `<thead><tr class="text-left text-xs uppercase text-slate-500">
      <th class="py-1">Coin</th><th class="py-1 text-right">Mayer</th><th class="py-1 text-right">RSI</th><th class="py-1 text-center">Signal</th><th class="py-1 text-right">Suggested</th><th class="py-1">Ladder</th>
    </tr></thead><tbody>${rows}</tbody>` +
    (alloc.reserveDivertLkr ? `<tfoot><tr><td colspan="6" class="pt-2 text-xs text-amber-400">↪ Divert ${fmtLkr(alloc.reserveDivertLkr)} to USDT/USDC reserve</td></tr></tfoot>` : "");
}

function renderAccuracy(acc) {
  if (!acc || !acc.aggregate || acc.aggregate.overallAccuracyPct == null) {
    $("accuracy").innerHTML = "Analyst accuracy: not enough history yet (needs past reports + price movement).";
    return;
  }
  const a = acc.aggregate;
  const byAction = Object.entries(a.byAction || {})
    .map(([k, v]) => `<span class="pill bg-slate-800">${k.replace("_", " ")}: ${v.hitRatePct}% (${v.n})</span>`)
    .join(" ");
  const pct = a.overallAccuracyPct;
  const col = pct >= 60 ? "text-emerald-400" : pct >= 45 ? "text-sky-400" : "text-rose-400";
  $("accuracy").innerHTML = `📈 <b>Analyst accuracy: <span class="${col}">${pct}%</span></b> across ${a.reportsScored} reports (${a.decisionsScored} calls)<br><span class="mt-1 inline-block">${byAction}</span>`;
}

function renderAnalytics(an) {
  if (!an) return;
  // Risk metrics
  const r = an.risk;
  if (r) {
    const item = (label, val, good) => `<div class="rounded-lg border border-edge bg-ink/50 p-2"><p class="text-[11px] text-slate-500">${label}</p><p class="text-base font-semibold ${good || "text-slate-100"}">${val}</p></div>`;
    $("risk").innerHTML =
      item("Ann. Return", (r.annualizedReturnPct ?? "—") + "%", r.annualizedReturnPct >= 0 ? "text-emerald-400" : "text-rose-400") +
      item("Ann. Volatility", (r.annualizedVolPct ?? "—") + "%") +
      item("Sharpe", r.sharpe ?? "—", r.sharpe >= 1 ? "text-emerald-400" : r.sharpe >= 0 ? "text-sky-400" : "text-rose-400") +
      item("Sortino", r.sortino ?? "—") +
      item("Max Drawdown", "-" + (r.maxDrawdownPct ?? "—") + "%", "text-rose-400") +
      item("Window", (r.windowDays ?? "—") + "d");
  } else {
    $("risk").innerHTML = '<p class="col-span-2 text-slate-500">Add holdings + let prices load to compute risk.</p>';
  }
  // Rebalance
  const rb = an.rebalance || [];
  $("rebalance").innerHTML = rb.length
    ? `<thead><tr class="text-left text-xs uppercase text-slate-500"><th class="py-1">Coin</th><th class="py-1 text-right">Now</th><th class="py-1 text-right">Target</th><th class="py-1 text-right">Action</th></tr></thead><tbody>${rb
        .map((x) => {
          const ac = x.action === "BUY" ? "text-emerald-400" : x.action === "TRIM" ? "text-rose-400" : "text-slate-400";
          return `<tr class="border-b border-edge/60"><td class="py-1.5 font-semibold" style="color:${COIN_COLORS[x.symbol]}">${x.symbol}</td><td class="py-1.5 text-right">${x.currentPct}%</td><td class="py-1.5 text-right">${x.targetPct ?? "—"}%</td><td class="py-1.5 text-right ${ac}">${x.action} ${x.deltaLkr ? fmtLkr(Math.abs(x.deltaLkr)) : ""}</td></tr>`;
        })
        .join("")}</tbody>`
    : '<tbody><tr><td class="py-3 text-slate-500">Inverse-volatility targets appear once holdings load.</td></tr></tbody>';
  // Correlation heatmap
  const c = an.correlation || { symbols: [], matrix: [] };
  if (c.symbols.length) {
    const head = `<tr><th></th>${c.symbols.map((s) => `<th class="p-1">${s}</th>`).join("")}</tr>`;
    const body = c.matrix
      .map((row, i) => `<tr><th class="p-1 text-right">${c.symbols[i]}</th>${row.map((v) => {
        const val = v == null ? "—" : v.toFixed(2);
        const bg = v == null ? "transparent" : v > 0 ? `rgba(34,197,94,${Math.abs(v) * 0.5})` : `rgba(244,63,94,${Math.abs(v) * 0.5})`;
        return `<td class="p-1" style="background:${bg}">${val}</td>`;
      }).join("")}</tr>`)
      .join("");
    $("correlation").innerHTML = head + body;
  } else {
    $("correlation").innerHTML = '<tbody><tr><td class="py-3 text-slate-500">Loads with market data.</td></tr></tbody>';
  }
}

function renderAnalyst(r, source) {
  if (!r) { $("analyst").innerHTML = '<p class="text-slate-500">No report yet. Click “Run analyst”.</p>'; return; }
  const riskColor = { LOW: "text-emerald-400", MODERATE: "text-sky-400", HIGH: "text-amber-400", EXTREME: "text-rose-400" }[r.risk_level] || "text-slate-300";
  const allocs = (r.allocations || [])
    .map(
      (a) => `<div class="rounded-lg border border-edge bg-ink/60 p-2">
        <div class="flex items-center justify-between">
          <span class="font-semibold" style="color:${COIN_COLORS[a.symbol]}">${a.symbol}</span>
          <span class="pill bg-slate-800">${a.action}</span>
        </div>
        <p class="mt-1 text-xs text-slate-400">${fmtLkr(a.suggested_lkr)} · ${a.reasoning || ""}</p>
        ${(a.ladder_entry_prices_usd || []).length ? `<p class="mt-1 text-xs text-slate-500">Entries: ${a.ladder_entry_prices_usd.map(fmtUsd).join(", ")}</p>` : ""}
      </div>`,
    )
    .join("");
  $("analyst").innerHTML = `
    <p class="text-slate-300">${r.market_summary || ""}</p>
    <div class="my-2 flex flex-wrap gap-2 text-xs">
      <span class="pill bg-slate-800">Risk: <b class="${riskColor}">${r.risk_level}</b></span>
      <span class="pill bg-slate-800">F&amp;G: ${r.fear_greed_score}</span>
      <span class="pill bg-slate-800">${source || ""}</span>
    </div>
    <div class="grid gap-2 sm:grid-cols-2">${allocs}</div>
    ${r.onchain_health ? `<p class="mt-2 text-xs text-slate-400">⛓ ${r.onchain_health}</p>` : ""}
    ${(r.macro_risks || []).length ? `<p class="mt-1 text-xs text-slate-500">⚠ ${r.macro_risks.join(" · ")}</p>` : ""}`;
}

function renderTx(txs) {
  if (!txs.length) { $("txtable").innerHTML = '<tbody><tr><td class="py-4 text-slate-500">No transactions yet.</td></tr></tbody>'; return; }
  const body = txs
    .map(
      (t) => `<tr class="border-b border-edge/60">
        <td class="py-2 text-slate-400">${new Date(t.created_at).toISOString().slice(0, 10)}</td>
        <td class="py-2 font-semibold" style="color:${COIN_COLORS[t.symbol] || "#fff"}">${t.symbol}</td>
        <td class="py-2"><span class="pill ${t.side === "SELL" ? "bg-rose-900 text-rose-200" : "bg-emerald-900 text-emerald-200"}">${t.side}</span></td>
        <td class="py-2 text-right">${fmtLkr(t.amount_lkr)}</td>
        <td class="py-2 text-right">${Number(t.units).toFixed(6)}</td>
        <td class="py-2 text-right">${fmtLkr(t.price_lkr)}</td>
        <td class="py-2 text-right">
          <button data-edit="${t.id}" class="text-xs text-sky-400 hover:underline">edit</button>
          <button data-del="${t.id}" class="ml-2 text-xs text-rose-400 hover:underline">del</button>
        </td></tr>`,
    )
    .join("");
  $("txtable").innerHTML =
    `<thead><tr class="text-left text-xs uppercase text-slate-500">
      <th class="py-1">Date</th><th class="py-1">Coin</th><th class="py-1">Side</th><th class="py-1 text-right">Amount</th><th class="py-1 text-right">Units</th><th class="py-1 text-right">Price</th><th></th>
    </tr></thead><tbody>${body}</tbody>`;
  window.__txs = txs;
  $("txtable").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => delTx(b.dataset.del)));
  $("txtable").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openEdit(b.dataset.edit)));
}

function renderNews(items) {
  $("news").innerHTML = items.length
    ? items.map((n) => `<li class="truncate"><a class="text-slate-300 hover:text-indigo-300" href="${n.link}" target="_blank" rel="noopener">• ${n.title}</a></li>`).join("")
    : '<li class="text-slate-500">No headlines.</li>';
}

// ---------- loaders ----------
async function loadAll() {
  try {
    const [market, portfolio, projection, analyst, txs, news, analytics, accuracy] = await Promise.all([
      api("/api/market"),
      api("/api/portfolio"),
      api("/api/projection"),
      api("/api/analyst"),
      api("/api/transactions"),
      api("/api/news").catch(() => ({ items: [] })),
      api("/api/analytics").catch(() => null),
      api("/api/analyst/accuracy").catch(() => null),
    ]);
    renderStats(portfolio);
    renderDonut(portfolio.holdings);
    renderDcaLump(projection.dcaVsLump);
    renderBands(projection.bands);
    renderLadder(market.allocation, market.coins);
    renderAnalyst(analyst.report, analyst.source);
    renderAccuracy(accuracy);
    renderAnalytics(analytics);
    renderTx(txs.transactions);
    renderNews(news.items || []);
    const fg = market.fearGreed || {};
    $("fg-pill").textContent = `Fear & Greed: ${fg.value ?? "—"} ${fg.classification ? "(" + fg.classification + ")" : ""}`;
  } catch (e) {
    console.error(e);
  }
}

// ---------- actions ----------
function openModal(edit) {
  editingId = edit || null;
  $("modal-title").textContent = edit ? "Edit transaction" : "Log purchase";
  $("modal-msg").textContent = "";
  const sel = $("f-symbol");
  sel.innerHTML = [...CONFIG.coins, "USDT"].map((c) => `<option>${c}</option>`).join("");
  $("modal").classList.remove("hidden");
  $("modal").classList.add("flex");
}
function closeModal() { $("modal").classList.add("hidden"); $("modal").classList.remove("flex"); editingId = null; }

function openEdit(id) {
  const t = (window.__txs || []).find((x) => x.id === id);
  if (!t) return;
  openModal(id);
  $("f-symbol").value = t.symbol;
  $("f-side").value = t.side;
  $("f-amount").value = t.amount_lkr;
  $("f-price").value = t.price_lkr;
}

async function saveModal() {
  const payload = {
    symbol: $("f-symbol").value,
    side: $("f-side").value,
    amount_lkr: Number($("f-amount").value),
    price_lkr: $("f-price").value ? Number($("f-price").value) : undefined,
  };
  $("modal-msg").textContent = "Saving…";
  try {
    if (editingId) await api("/api/transactions/" + editingId, { method: "PUT", body: JSON.stringify(payload) });
    else await api("/api/transactions", { method: "POST", body: JSON.stringify(payload) });
    closeModal();
    loadAll();
  } catch (e) {
    $("modal-msg").innerHTML = `<span class="text-rose-400">${e.message}</span>`;
  }
}

async function delTx(id) {
  if (!confirm("Delete this transaction?")) return;
  await api("/api/transactions/" + id, { method: "DELETE" });
  loadAll();
}

async function runAnalyst() {
  const btn = $("btn-analyst");
  btn.textContent = "Analysing…";
  btn.disabled = true;
  try {
    const { report, source } = await api("/api/analyst", { method: "POST" });
    renderAnalyst(report, source);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.textContent = "Run analyst";
    btn.disabled = false;
  }
}

async function refreshAll() {
  const btn = $("btn-refresh");
  btn.textContent = "Refreshing…";
  btn.disabled = true;
  try {
    await api("/api/refresh", { method: "POST" });
    await loadAll();
  } catch (e) {
    console.error(e);
  } finally {
    btn.textContent = "↻ Refresh";
    btn.disabled = false;
  }
}

async function doImport() {
  $("import-msg").textContent = "Importing…";
  try {
    const r = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({ format: $("import-format").value, data: $("import-format").value === "json" ? JSON.parse($("import-text").value) : $("import-text").value }),
    });
    $("import-msg").innerHTML = `<span class="text-emerald-400">Imported ${r.imported}/${r.total}.</span>`;
    loadAll();
  } catch (e) {
    $("import-msg").innerHTML = `<span class="text-rose-400">${e.message}</span>`;
  }
}

// ---------- init ----------
async function init() {
  try { CONFIG = await api("/api/config"); } catch (e) { /* keep defaults */ }
  $("btn-log").onclick = () => openModal(null);
  $("modal-cancel").onclick = closeModal;
  $("modal-save").onclick = saveModal;
  $("btn-analyst").onclick = runAnalyst;
  $("btn-refresh").onclick = refreshAll;
  $("btn-import").onclick = () => { $("import-modal").classList.remove("hidden"); $("import-modal").classList.add("flex"); };
  $("import-cancel").onclick = () => { $("import-modal").classList.add("hidden"); $("import-modal").classList.remove("flex"); };
  $("import-save").onclick = doImport;
  await loadAll();
  setInterval(loadAll, 120000); // gentle auto-refresh
}
init();
