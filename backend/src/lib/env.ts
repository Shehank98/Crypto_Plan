import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  databaseUrl: () => required("DATABASE_URL"),
  jwtSecret: () => required("JWT_SECRET"),
  jwtExpiresIn: () => optional("JWT_EXPIRES_IN", "7d"),
  // API_PORT wins so the combined single-service container can pin the API to
  // an internal port (Next.js takes Railway's PORT). Falls back to PORT, then 4000.
  port: () => parseInt(process.env.API_PORT ?? process.env.PORT ?? "4000", 10),

  coingeckoApiKey: () => optional("COINGECKO_API_KEY", ""),
  coingeckoBaseUrl: () => optional("COINGECKO_BASE_URL", "https://api.coingecko.com/api/v3"),

  fxBaseUrl: () => optional("FX_BASE_URL", "https://api.exchangerate.host"),
  fxAccessKey: () => optional("FX_ACCESS_KEY", ""),

  backfillFrom: () => optional("BACKFILL_FROM", "2019-01-01"),
};
