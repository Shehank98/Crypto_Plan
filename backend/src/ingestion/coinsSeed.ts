// The initial coin universe + a reusable idempotent seeder, so coins can be
// seeded both from the CLI script and automatically at server startup.

import { prisma } from "../lib/prisma.js";

export const DEFAULT_COINS = [
  { symbol: "BTC", name: "Bitcoin", coingeckoId: "bitcoin" },
  { symbol: "ETH", name: "Ethereum", coingeckoId: "ethereum" },
  { symbol: "BNB", name: "BNB", coingeckoId: "binancecoin" },
  { symbol: "SOL", name: "Solana", coingeckoId: "solana" },
];

/** Upsert the default coins. Idempotent — safe to run on every boot. */
export async function seedCoins(): Promise<number> {
  for (const c of DEFAULT_COINS) {
    await prisma.coin.upsert({
      where: { symbol: c.symbol },
      create: c,
      update: { name: c.name, coingeckoId: c.coingeckoId },
    });
  }
  return DEFAULT_COINS.length;
}
