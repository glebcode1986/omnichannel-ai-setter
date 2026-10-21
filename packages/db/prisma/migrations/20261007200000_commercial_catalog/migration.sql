-- CreateEnum
CREATE TYPE "CatalogAvailability" AS ENUM ('PUBLIC', 'PRIVATE', 'LEGACY');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "AddOnKind" AS ENUM ('RECURRING_CAPACITY', 'ONE_TIME_ALLOWANCE');

-- AlterTable
ALTER TABLE "plan_versions" DROP COLUMN "annual_price_cents",
DROP COLUMN "currency",
DROP COLUMN "monthly_price_cents",
ADD COLUMN     "availability" "CatalogAvailability" NOT NULL DEFAULT 'PRIVATE';

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "provider_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_definitions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addon_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_versions" (
    "id" TEXT NOT NULL,
    "addon_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "AddOnKind" NOT NULL,
    "availability" "CatalogAvailability" NOT NULL DEFAULT 'PRIVATE',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addon_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_prices" (
    "id" TEXT NOT NULL,
    "addon_version_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "provider_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addon_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_addons" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "addon_version_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "active_from" TIMESTAMP(3) NOT NULL,
    "active_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_topups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "metric" "UsageMetricKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "addon_version_id" TEXT,
    "purchased_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_topups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_version_id_currency_interval_key" ON "plan_prices"("plan_version_id", "currency", "interval");

-- CreateIndex
CREATE UNIQUE INDEX "addon_definitions_code_key" ON "addon_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "addon_versions_addon_id_version_key" ON "addon_versions"("addon_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "addon_prices_addon_version_id_currency_interval_key" ON "addon_prices"("addon_version_id", "currency", "interval");

-- CreateIndex
CREATE INDEX "workspace_addons_workspace_id_active_until_idx" ON "workspace_addons"("workspace_id", "active_until");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_addons_workspace_id_addon_version_id_key" ON "workspace_addons"("workspace_id", "addon_version_id");

-- CreateIndex
CREATE INDEX "usage_topups_workspace_id_metric_expires_at_idx" ON "usage_topups"("workspace_id", "metric", "expires_at");

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "addon_versions" ADD CONSTRAINT "addon_versions_addon_id_fkey" FOREIGN KEY ("addon_id") REFERENCES "addon_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "addon_prices" ADD CONSTRAINT "addon_prices_addon_version_id_fkey" FOREIGN KEY ("addon_version_id") REFERENCES "addon_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workspace_addons" ADD CONSTRAINT "workspace_addons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workspace_addons" ADD CONSTRAINT "workspace_addons_addon_version_id_fkey" FOREIGN KEY ("addon_version_id") REFERENCES "addon_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_topups" ADD CONSTRAINT "usage_topups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_topups" ADD CONSTRAINT "usage_topups_addon_version_id_fkey" FOREIGN KEY ("addon_version_id") REFERENCES "addon_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express (#43, PRICING_PACKAGING.md)
-- ---------------------------------------------------------------------------------------------------------

-- The immutability trigger named the three price columns this migration moved into `plan_prices`, so it
-- has to be rewritten rather than left pointing at fields `NEW` no longer has — which would make *every*
-- update to a plan version fail with a missing-field error instead of the sentence it means to raise.
--
-- The permitted change is the same one #38 allowed and no wider: whether the version is still for sale.
-- `retired_at` said that already and `availability` says it in more detail, so both are exempt — a
-- catalogue that could only withdraw a plan by publishing a new version would have to publish one nobody
-- can buy. Everything that defines the *terms* stays frozen, and the price book is immutable in its own
-- right, by its own trigger below.
CREATE OR REPLACE FUNCTION plan_versions_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."features" IS DISTINCT FROM OLD."features"
     OR NEW."limits" IS DISTINCT FROM OLD."limits"
     OR NEW."quotas" IS DISTINCT FROM OLD."quotas"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    -- The default SQLSTATE (P0001) on purpose: a client library rewrites a constraint-shaped code into
    -- its own wording and the reason is lost, while a raised exception reaches the caller as written.
    RAISE EXCEPTION 'plan_versions are immutable; publish a new version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Dropping the price columns dropped `plan_versions_shape_check` with them. What it protected that still
-- exists is the version number; the money invariants now live on `plan_prices`, where the money is.
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_shape_check" CHECK ("version" >= 1);

-- Money is a non-negative whole number of minor units. A negative price is not a discount, it is a bug;
-- a free item is priced at zero and said so.
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_amount_check" CHECK ("amount_cents" >= 0);
ALTER TABLE "addon_prices" ADD CONSTRAINT "addon_prices_amount_check" CHECK ("amount_cents" >= 0);

-- ISO 4217: three letters, upper case. The column is text because the list grows, but a lower-case or
-- padded code would silently create a second price book for the same currency.
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "addon_prices" ADD CONSTRAINT "addon_prices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- A subscription is charged on a recurring interval. `ONE_TIME` describes a top-up, which is not a
-- subscription at all, so a plan priced that way would be a plan nobody could be subscribed to.
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_interval_check" CHECK ("interval" <> 'ONE_TIME');

-- What an add-on sells and how it is billed have to agree.
--
-- Recurring capacity grants limits and is charged on an interval; a one-time allowance grants quota and is
-- charged once. A row claiming both, or neither, is not a product anybody priced — and `kind` lives on the
-- version rather than the definition precisely so this pairing can be enforced here rather than remembered.
ALTER TABLE "addon_versions" ADD CONSTRAINT "addon_versions_grant_check" CHECK (
  ("kind" = 'RECURRING_CAPACITY' AND "limits" <> '{}'::jsonb AND "quotas" = '{}'::jsonb)
  OR ("kind" = 'ONE_TIME_ALLOWANCE' AND "quotas" <> '{}'::jsonb AND "limits" = '{}'::jsonb)
);

ALTER TABLE "addon_versions" ADD CONSTRAINT "addon_versions_version_check" CHECK ("version" >= 1);

-- A purchase of none of something is not a purchase.
ALTER TABLE "workspace_addons" ADD CONSTRAINT "workspace_addons_quantity_check" CHECK ("quantity" >= 1);

-- A dated row describes a period, not an instant that ends before it begins.
ALTER TABLE "workspace_addons" ADD CONSTRAINT "workspace_addons_period_check" CHECK (
  "active_until" IS NULL OR "active_until" > "active_from"
);

-- A top-up is a positive balance that cannot be overspent, and it expires after it was bought.
ALTER TABLE "usage_topups" ADD CONSTRAINT "usage_topups_balance_check" CHECK (
  "amount" > 0 AND "consumed" >= 0 AND "consumed" <= "amount"
);
ALTER TABLE "usage_topups" ADD CONSTRAINT "usage_topups_clock_check" CHECK ("expires_at" > "purchased_at");

-- Published add-on versions are immutable, exactly as plan versions are (#38's reasoning, one table over).
--
-- A workspace buys a *version*, so editing one would change the terms of every workspace that bought it —
-- which is what grandfathering exists to prevent. A price change is a new version; the old one stays,
-- withdrawn from sale and still interpretable.
--
-- `availability` is exempt, and only it, for the same reason it is exempt on a plan version: whether
-- something is still for sale is not one of its terms, and withdrawing an add-on by publishing a new
-- version would mean publishing one nobody can buy.
CREATE OR REPLACE FUNCTION "addon_versions_immutable"() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."addon_id" IS DISTINCT FROM OLD."addon_id"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."limits" IS DISTINCT FROM OLD."limits"
       OR NEW."quotas" IS DISTINCT FROM OLD."quotas"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'addon_versions are immutable: publish a new version instead';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "addon_versions_no_update"
    BEFORE UPDATE ON "addon_versions"
    FOR EACH ROW EXECUTE FUNCTION "addon_versions_immutable"();

CREATE OR REPLACE FUNCTION "addon_versions_no_delete_fn"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'addon_versions rows are never deleted: a version a workspace bought must stay readable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "addon_versions_no_delete"
    BEFORE DELETE ON "addon_versions"
    FOR EACH ROW EXECUTE FUNCTION "addon_versions_no_delete_fn"();

-- And their prices, for the same reason: a price a customer was charged must stay readable exactly as it
-- was charged. Re-pricing publishes a new version with its own prices.
CREATE OR REPLACE FUNCTION "catalog_prices_immutable"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'catalogue prices are immutable: publish a new version instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_prices_no_change"
    BEFORE UPDATE OR DELETE ON "plan_prices"
    FOR EACH ROW EXECUTE FUNCTION "catalog_prices_immutable"();

CREATE TRIGGER "addon_prices_no_change"
    BEFORE UPDATE OR DELETE ON "addon_prices"
    FOR EACH ROW EXECUTE FUNCTION "catalog_prices_immutable"();

-- The entitlement key now has a third writer (#43).
--
-- `readEntitlement` reads `workspace_addons` too, and the delivery claim re-resolves the entitlement
-- inside its own transaction — so a purchase or a removal committing between that read and the claim has
-- to be ordered against it exactly as a subscription change is. The alternative was to reason that an
-- add-on grants only *limits* while the claim compares only features and payment, which is true today and
-- is the kind of true that a later field addition quietly breaks.
--
-- `addon_versions` needs no key: it is immutable, and a row that cannot be updated cannot be invalidated
-- between a read and a claim.
CREATE TRIGGER "workspace_addons_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "workspace_addons"
    FOR EACH ROW EXECUTE FUNCTION "entitlement_take_key"();
