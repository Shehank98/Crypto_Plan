// Seed the initial coin universe. Extensible: add rows here (or via the DB)
// and re-run. Keyed by symbol / coingeckoId so re-runs are idempotent.

import { prisma } from "../lib/prisma.js";

const COINS = [
  { symbol: "BTC", name: "Bitcoin", coingeckoId: "bitcoin" },
  { symbol: "ETH", name: "Ethereum", coingeckoId: "ethereum" },
  { symbol: "BNB", name: "BNB", coingeckoId: "binancecoin" },
  { symbol: "SOL", name: "Solana", coingeckoId: "solana" },
];

async function main() {
  for (const c of COINS) {
    await prisma.coin.upsert({
      where: { symbol: c.symbol },
      create: c,
      update: { name: c.name, coingeckoId: c.coingeckoId },
    });
    console.log(`seeded ${c.symbol} (${c.coingeckoId})`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
