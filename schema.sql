-- Crypto DCA & Intelligent Portfolio Engine — PostgreSQL schema.
-- Safe to run repeatedly (idempotent). Executed automatically on server boot.

-- Transactions: every buy/sell logged. Sells use side='SELL' with positive units
-- (the app treats them as reducing holdings). gen_random_uuid() is built in on PG13+.
CREATE TABLE IF NOT EXISTS transactions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol      VARCHAR(10) NOT NULL,
    side        VARCHAR(4)  NOT NULL DEFAULT 'BUY',
    amount_lkr  NUMERIC(14,2) NOT NULL,
    units       NUMERIC(18,8) NOT NULL,
    price_lkr   NUMERIC(18,2) NOT NULL,
    fee_lkr     NUMERIC(10,2) NOT NULL DEFAULT 0,
    note        TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_symbol_idx ON transactions (symbol);
CREATE INDEX IF NOT EXISTS transactions_created_at_idx ON transactions (created_at);

-- AI analyst reports, stored to track past recommendation accuracy over time.
-- snapshot_json captures prices at report time so accuracy can be measured later.
CREATE TABLE IF NOT EXISTS ai_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_json   JSONB NOT NULL,
    snapshot_json JSONB,
    source        VARCHAR(16) NOT NULL DEFAULT 'gemini',
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_reports_created_at_idx ON ai_reports (created_at);

-- Per-symbol market cache refreshed by a cron job (indicators + spot price).
CREATE TABLE IF NOT EXISTS price_cache (
    symbol         VARCHAR(10) PRIMARY KEY,
    price_usd      NUMERIC(18,4),
    price_lkr      NUMERIC(18,2),
    sma_200        NUMERIC(18,4),
    sma_50         NUMERIC(18,4),
    ema_20         NUMERIC(18,4),
    rsi_14         NUMERIC(8,4),
    mayer_multiple NUMERIC(8,4),
    change_24h     NUMERIC(8,4),
    ladder_json    JSONB,
    updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
