// Seed the initial coin universe. Idempotent — re-run any time.
//   npm run seed

import { prisma } from "../lib/prisma.js";
import { seedCoins, DEFAULT_COINS } from "../ingestion/coinsSeed.js";

seedCoins()
  .then((n) => {
    console.log(`seeded ${n} coins: ${DEFAULT_COINS.map((c) => c.symbol).join(", ")}`);
    return prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
