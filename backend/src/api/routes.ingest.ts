import { Router } from "express";
import { asyncHandler, HttpError, requireAuth } from "./middleware.js";
import { runIngest, type IngestSummary } from "../ingestion/ingest.js";

// In-process state so a manual run can't overlap and the UI can poll progress.
interface IngestState {
  running: boolean;
  mode: "incremental" | "backfill" | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastSummary: IngestSummary | null;
  lastError: string | null;
}
const state: IngestState = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  lastSummary: null,
  lastError: null,
};

export const ingestRouter = Router();
ingestRouter.use(requireAuth);

// Trigger ingestion. Body: { mode?: "incremental" | "backfill" }.
// - incremental (default): fast, runs synchronously and returns the summary.
// - backfill: full history, can take minutes — runs in the background and
//   returns 202 immediately; poll GET /status for completion.
ingestRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    if (state.running) {
      throw new HttpError(409, `A ${state.mode ?? ""} run is already in progress.`);
    }
    const mode = req.body?.mode === "backfill" ? "backfill" : "incremental";

    if (mode === "backfill") {
      state.running = true;
      state.mode = "backfill";
      state.startedAt = new Date().toISOString();
      state.finishedAt = null;
      state.lastError = null;
      // Fire-and-forget; completion is observed via GET /status.
      void runIngest("backfill")
        .then((summary) => {
          state.lastSummary = summary;
          state.lastError = null;
        })
        .catch((err) => {
          state.lastError = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          state.running = false;
          state.finishedAt = new Date().toISOString();
        });
      res.status(202).json({ started: true, mode });
      return;
    }

    // Incremental — quick enough to await.
    state.running = true;
    state.mode = "incremental";
    state.startedAt = new Date().toISOString();
    try {
      const summary = await runIngest("incremental");
      state.lastSummary = summary;
      state.lastError = null;
      res.json({ ok: true, mode, summary });
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }),
);

// Poll ingestion progress / last result.
ingestRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(state);
  }),
);
