import { Router } from "express";
import { asyncHandler, HttpError, requireAuth } from "./middleware.js";
import { runIngest } from "../ingestion/ingest.js";

// Simple in-process guard so a manual refresh can't overlap another run.
let running = false;

export const ingestRouter = Router();
ingestRouter.use(requireAuth);

// Pull the latest prices + fx on demand (trailing-days incremental ingest).
ingestRouter.post(
  "/refresh",
  asyncHandler(async (_req, res) => {
    if (running) throw new HttpError(409, "A price refresh is already in progress.");
    running = true;
    try {
      const summary = await runIngest("incremental");
      res.json({ ok: true, summary });
    } finally {
      running = false;
    }
  }),
);
