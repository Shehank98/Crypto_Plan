// CLI entrypoint for ingestion.
//   npm run ingest:backfill      # full history
//   npm run ingest:incremental   # latest day, for a daily cron
//   tsx src/scripts/ingest.ts backfill|incremental

import { prisma } from "../lib/prisma.js";
import { runIngest, type IngestMode } from "../ingestion/ingest.js";

async function main() {
  const arg = process.argv[2];
  const mode: IngestMode = arg === "backfill" ? "backfill" : "incremental";
  console.log(`Starting ingest in "${mode}" mode...`);
  const summary = await runIngest(mode);
  console.log("Ingest complete:", JSON.stringify(summary, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("Ingest failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
