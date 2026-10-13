-- Provider-neutral plan, subscription and entitlement primitives (#38, ADR-017).
--
-- No payment provider is integrated here and none is named. Provider identifiers are opaque strings on
-- `billing_accounts`; everything the product reasons about is in its own vocabulary, so replacing the
-- provider changes rows rather than plan semantics.
CREATE TYPE "SubscriptionState" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELED_PENDING_END', 'INACTIVE');

CREATE TABLE "plan_definitions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plan_definitions_code_key" ON "plan_definitions"("code");

CREATE TABLE "plan_versions" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limits" JSONB NOT NULL DEFAULT '{}',
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "monthly_price_cents" INTEGER,
    "annual_price_cents" INTEGER,
    "currency" TEXT,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plan_versions_plan_id_version_key" ON "plan_versions"("plan_id", "version");
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Versions start at 1 and money is never negative. Prices are in minor units of `currency`, so a price
-- without a currency is a number nobody can spend.
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_shape_check" CHECK (
  "version" >= 1
  AND ("monthly_price_cents" IS NULL OR "monthly_price_cents" >= 0)
  AND ("annual_price_cents" IS NULL OR "annual_price_cents" >= 0)
  AND (("monthly_price_cents" IS NULL AND "annual_price_cents" IS NULL) OR "currency" IS NOT NULL)
);

/*
  A plan version is immutable once written.
  
  A workspace subscribes to a version, so editing one would silently change the terms of every workspace
  on it — which is exactly what grandfathering exists to prevent. Withdrawing it from sale is the one
  permitted change, so `retired_at` is the only column the trigger lets through.
*/
CREATE OR REPLACE FUNCTION plan_versions_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."features" IS DISTINCT FROM OLD."features"
     OR NEW."limits" IS DISTINCT FROM OLD."limits"
     OR NEW."quotas" IS DISTINCT FROM OLD."quotas"
     OR NEW."monthly_price_cents" IS DISTINCT FROM OLD."monthly_price_cents"
     OR NEW."annual_price_cents" IS DISTINCT FROM OLD."annual_price_cents"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    -- The default SQLSTATE (P0001) on purpose: a client library rewrites a constraint-shaped code into
    -- its own wording and the reason is lost, while a raised exception reaches the caller as written.
    RAISE EXCEPTION 'plan_versions are immutable; publish a new version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER plan_versions_immutable_trigger
  BEFORE UPDATE ON "plan_versions"
  FOR EACH ROW EXECUTE FUNCTION plan_versions_immutable();

-- A published version is never deleted either: a workspace grandfathered onto it would lose the record
-- of what it bought.
CREATE OR REPLACE FUNCTION plan_versions_no_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'plan_versions are never deleted; retire them instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER plan_versions_no_delete_trigger
  BEFORE DELETE ON "plan_versions"
  FOR EACH ROW EXECUTE FUNCTION plan_versions_no_delete();

CREATE TABLE "workspace_subscriptions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "state" "SubscriptionState" NOT NULL DEFAULT 'TRIALING',
    "period_ends_at" TIMESTAMP(3),
    "trial_ends_at" TIMESTAMP(3),
    "grace_started_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_subscriptions_workspace_id_key" ON "workspace_subscriptions"("workspace_id");
CREATE INDEX "workspace_subscriptions_state_period_ends_at_idx" ON "workspace_subscriptions"("state", "period_ends_at");
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The state and its clock agree. A trial with no end never ends; a cancellation with no date cannot be
-- shown to anybody; grace with no start cannot be measured, and its three days are product policy rather
-- than a provider's retry schedule.
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_clock_check" CHECK (
  ("state" <> 'TRIALING' OR "trial_ends_at" IS NOT NULL)
  AND ("state" <> 'GRACE' OR "grace_started_at" IS NOT NULL)
  AND ("state" <> 'CANCELED_PENDING_END' OR ("canceled_at" IS NOT NULL AND "period_ends_at" IS NOT NULL))
);

CREATE TABLE "entitlement_overrides" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "features" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "granted_by_user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlement_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entitlement_overrides_workspace_id_key" ON "entitlement_overrides"("workspace_id");
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An override nobody can explain is one nobody dares remove.
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_reason_check" CHECK (btrim("reason") <> '');

CREATE TABLE "billing_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT,
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_accounts_workspace_id_key" ON "billing_accounts"("workspace_id");
CREATE INDEX "billing_accounts_provider_provider_customer_id_idx" ON "billing_accounts"("provider", "provider_customer_id");
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A provider reference without a provider names nothing; a provider is the thing that gives the opaque
-- strings their meaning, and without it nobody could tell which adapter they belong to.
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_provider_check" CHECK (
  "provider" IS NOT NULL OR ("provider_customer_id" IS NULL AND "provider_subscription_id" IS NULL)
);
