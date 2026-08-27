"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { AddPurchaseForm } from "@/components/AddPurchaseForm";
import { HoldingsTable, PortfolioSummary } from "@/components/PortfolioView";
import { PurchasesList } from "@/components/PurchasesList";
import { PortfolioHistoryChart } from "@/components/charts/PortfolioHistoryChart";
import { apiFetch } from "@/lib/api";
import type { Coin, Portfolio, PortfolioPoint, Purchase } from "@/lib/types";

export default function DashboardPage() {
  return (
    <AppShell>
      <Tracker />
    </AppShell>
  );
}

function Tracker() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [history, setHistory] = useState<PortfolioPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pf, pl, hist] = await Promise.all([
        apiFetch<Portfolio>("/api/portfolio"),
        apiFetch<{ purchases: Purchase[] }>("/api/purchases"),
        apiFetch<{ points: PortfolioPoint[] }>("/api/portfolio/history"),
      ]);
      setPortfolio(pf);
      setPurchases(pl.purchases);
      setHistory(hist.points);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load portfolio");
    } finally {
      setLoaded(true);
    }
  }, []);

  const refreshPrices = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    setFlash(null);
    try {
      await apiFetch("/api/ingest/refresh", { method: "POST", body: JSON.stringify({ mode: "incremental" }) });
      await refresh();
      setFlash("Prices updated to the latest available.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh prices");
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setError(null);
    setFlash("Loading price history… this can take a few minutes. You can keep using the app.");
    try {
      await apiFetch("/api/ingest/refresh", {
        method: "POST",
        body: JSON.stringify({ mode: "backfill" }),
      });
      // Poll until the background backfill finishes.
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await apiFetch<{ running: boolean; lastError: string | null }>("/api/ingest/status");
        if (!s.running) {
          if (s.lastError) throw new Error(s.lastError);
          break;
        }
      }
      await refresh();
      setFlash("Price history loaded. You can now log purchases at past dates.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load price history");
      setFlash(null);
    } finally {
      setLoadingHistory(false);
    }
  }, [refresh]);

  useEffect(() => {
    apiFetch<{ coins: Coin[] }>("/api/coins")
      .then((r) => setCoins(r.coins))
      .catch((e) => setError(e.message));
    refresh();
  }, [refresh]);

  const noCoins = loaded && coins.length === 0;
  const empty = loaded && purchases.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Portfolio</h1>
          <p className="text-sm text-slate-500">
            Log the crypto you&apos;ve bought; values update with the latest prices.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadHistory}
            disabled={loadingHistory || refreshing || noCoins}
            className="btn-secondary"
            title="Pull full historical prices (one-time, takes a few minutes)"
          >
            {loadingHistory ? "Loading history…" : "⭳ Load price history"}
          </button>
          <button
            onClick={refreshPrices}
            disabled={refreshing || loadingHistory || noCoins}
            className="btn-secondary"
            title="Pull the latest prices"
          >
            {refreshing ? "Refreshing…" : "↻ Refresh prices"}
          </button>
          <Link href="/plans" className="btn-secondary">
            Forecasts →
          </Link>
        </div>
      </div>

      {flash && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{flash}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {noCoins && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
          No coins are set up yet — this usually resolves on the next deploy (coins seed
          automatically). If it persists, redeploy the service.
        </div>
      )}

      {!noCoins && empty && (
        <div className="rounded-lg bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
          <strong>First time?</strong> Click <strong>⭳ Load price history</strong> above to pull
          historical prices (one-time, a few minutes), then log a purchase below.
        </div>
      )}

      {portfolio && portfolio.totals.purchaseCount > 0 && (
        <PortfolioSummary portfolio={portfolio} />
      )}

      {!noCoins && <AddPurchaseForm coins={coins} onAdded={refresh} />}

      {empty ? (
        <div className="card flex flex-col items-center gap-2 py-10 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-2xl">
            💰
          </div>
          <h2 className="text-lg font-medium text-slate-800">No purchases yet</h2>
          <p className="max-w-sm text-sm text-slate-500">
            Add your first purchase above — pick a coin, the date you bought, and how much you
            spent in LKR. We&apos;ll fetch that day&apos;s price and track it.
          </p>
        </div>
      ) : (
        portfolio && (
          <>
            {history.length >= 2 && <PortfolioHistoryChart points={history} />}
            <HoldingsTable portfolio={portfolio} />
            <PurchasesList purchases={purchases} coins={coins} onChanged={refresh} />
          </>
        )
      )}
    </div>
  );
}
