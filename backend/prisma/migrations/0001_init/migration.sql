-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coins" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coingecko_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" SERIAL NOT NULL,
    "coin_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "price_usd" DECIMAL(24,8) NOT NULL,
    "volume" DECIMAL(30,4),
    "market_cap" DECIMAL(30,4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "usd_to_lkr" DECIMAL(18,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_amount_lkr" DECIMAL(18,2) NOT NULL,
    "allocations" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_results" (
    "id" SERIAL NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "backtest_results" JSONB NOT NULL,
    "montecarlo_results" JSONB NOT NULL,
    "inputs_hash" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "coins_symbol_key" ON "coins"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "coins_coingecko_id_key" ON "coins"("coingecko_id");

-- CreateIndex
CREATE INDEX "price_history_coin_id_date_idx" ON "price_history"("coin_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "price_history_coin_id_date_key" ON "price_history"("coin_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_date_key" ON "fx_rates"("date");

-- CreateIndex
CREATE INDEX "fx_rates_date_idx" ON "fx_rates"("date");

-- CreateIndex
CREATE INDEX "plans_user_id_idx" ON "plans"("user_id");

-- CreateIndex
CREATE INDEX "plan_results_plan_id_idx" ON "plan_results"("plan_id");

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_coin_id_fkey" FOREIGN KEY ("coin_id") REFERENCES "coins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_results" ADD CONSTRAINT "plan_results_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

