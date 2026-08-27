import cors from "cors";
import express from "express";
import { errorHandler } from "./middleware.js";
import { authRouter } from "./routes.auth.js";
import { coinsRouter } from "./routes.coins.js";
import { plansRouter } from "./routes.plans.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/coins", coinsRouter);
  app.use("/api/plans", plansRouter);

  // 404 for unmatched routes.
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  app.use(errorHandler);

  return app;
}
