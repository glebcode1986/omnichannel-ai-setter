-- Seller profiles, billing routes, arrangements, checkout contracts and legal acceptance (#46, ADR-019).
--
-- No payment provider is integrated here and none is named. `provider` and `provider_account_ref` are
-- opaque strings; everything the product reasons about — the settlement model, the capability list, the
-- arrangement kind — is in its own vocabulary, so adding a provider adds rows rather than changing plan
-- semantics.
--
-- Four invariants in this file are structural rather than remembered, and each one is here because the
-- consequence of forgetting it is a charge nobody authorized:
--
--   * at most one live charge path per workspace (a partial unique index), so a provider switch cannot
--     leave two providers billing the same customer;
--   * a checkout contract is frozen once written (a trigger), because it is the evidence of what was
--     offered and on whose behalf, not a cache of it;
--   * a checkout cannot commit without an acceptance of every required legal document (a *deferred*
--     constraint trigger, because the acceptances reference the contract and therefore come after it);
--   * a normalized provider event is recorded once per route (a unique index), so a replayed webhook is
--     refused by the database rather than by a check some future caller forgets.
-- CreateEnum
CREATE TYPE "SettlementModel" AS ENUM ('DIRECT_PSP', 'MERCHANT_OF_RECORD', 'CRYPTO_PROCESSOR');

-- CreateEnum
CREATE TYPE "BillingArrangementKind" AS ENUM ('RECURRING', 'PREPAID_TERM');

-- CreateEnum
CREATE TYPE "BillingArrangementState" AS ENUM ('PENDING', 'ACTIVE', 'ENDED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CheckoutState" AS ENUM ('OPEN', 'SETTLED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "LegalDocumentKind" AS ENUM ('TERMS_OF_SERVICE', 'PUBLIC_OFFER', 'PRIVACY_POLICY');

-- CreateEnum
CREATE TYPE "BillingEventKind" AS ENUM ('PAYMENT_SETTLED', 'PAYMENT_FAILED', 'PAYMENT_UNDERPAID', 'QUOTE_EXPIRED', 'SUBSCRIPTION_RENEWED', 'SUBSCRIPTION_CANCELED', 'REFUNDED', 'CHARGEBACK');

-- CreateTable
CREATE TABLE "seller_profiles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "support_email" TEXT NOT NULL,
    "legal_config_ref" TEXT,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_routes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_ref" TEXT,
    "seller_profile_id" TEXT NOT NULL,
    "settlement_model" "SettlementModel" NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intervals" "BillingInterval"[] DEFAULT ARRAY[]::"BillingInterval"[],
    "markets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_arrangements" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "billing_route_id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "kind" "BillingArrangementKind" NOT NULL,
    "state" "BillingArrangementState" NOT NULL DEFAULT 'PENDING',
    "interval" "BillingInterval" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider_reference" TEXT,
    "started_at" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_arrangements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_contracts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "billing_route_id" TEXT NOT NULL,
    "seller_profile_id" TEXT NOT NULL,
    "seller_legal_name" TEXT NOT NULL,
    "seller_jurisdiction" TEXT NOT NULL,
    "arrangement_kind" "BillingArrangementKind" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "base_amount_minor" INTEGER NOT NULL,
    "base_currency" TEXT NOT NULL,
    "charge_amount_minor" INTEGER NOT NULL,
    "charge_currency" TEXT NOT NULL,
    "quote_expires_at" TIMESTAMP(3),
    "provider_checkout_ref" TEXT,
    "state" "CheckoutState" NOT NULL DEFAULT 'OPEN',
    "arrangement_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" TEXT NOT NULL,
    "kind" "LegalDocumentKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "seller_profile_id" TEXT,
    "content_ref" TEXT NOT NULL,
    "required_for_checkout" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "legal_document_id" TEXT NOT NULL,
    "checkout_contract_id" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "billing_route_id" TEXT NOT NULL,
    "arrangement_id" TEXT,
    "checkout_contract_id" TEXT,
    "kind" "BillingEventKind" NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "activation_source" TEXT NOT NULL,
    "amount_minor" INTEGER,
    "currency" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effect" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_code_key" ON "seller_profiles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "billing_routes_code_key" ON "billing_routes"("code");

-- CreateIndex
CREATE INDEX "billing_routes_enabled_priority_idx" ON "billing_routes"("enabled", "priority");

-- CreateIndex
CREATE INDEX "billing_arrangements_workspace_id_state_idx" ON "billing_arrangements"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "billing_arrangements_one_live_key" ON "billing_arrangements"("workspace_id") WHERE (state <> 'ENDED' AND state <> 'SUPERSEDED');

-- CreateIndex
CREATE INDEX "checkout_contracts_workspace_id_state_idx" ON "checkout_contracts"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "legal_documents_kind_effective_from_idx" ON "legal_documents"("kind", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "legal_documents_kind_locale_version_key" ON "legal_documents"("kind", "locale", "version");

-- CreateIndex
CREATE INDEX "legal_acceptances_workspace_id_accepted_at_idx" ON "legal_acceptances"("workspace_id", "accepted_at");

-- CreateIndex
CREATE UNIQUE INDEX "legal_acceptances_checkout_contract_id_legal_document_id_key" ON "legal_acceptances"("checkout_contract_id", "legal_document_id");

-- CreateIndex
CREATE INDEX "billing_events_workspace_id_occurred_at_idx" ON "billing_events"("workspace_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_billing_route_id_provider_event_id_key" ON "billing_events"("billing_route_id", "provider_event_id");

-- AddForeignKey
ALTER TABLE "billing_routes" ADD CONSTRAINT "billing_routes_seller_profile_id_fkey" FOREIGN KEY ("seller_profile_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_arrangements" ADD CONSTRAINT "billing_arrangements_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_arrangements" ADD CONSTRAINT "billing_arrangements_billing_route_id_fkey" FOREIGN KEY ("billing_route_id") REFERENCES "billing_routes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_arrangements" ADD CONSTRAINT "billing_arrangements_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_arrangements" ADD CONSTRAINT "billing_arrangements_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "billing_arrangements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_billing_route_id_fkey" FOREIGN KEY ("billing_route_id") REFERENCES "billing_routes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_seller_profile_id_fkey" FOREIGN KEY ("seller_profile_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_arrangement_id_fkey" FOREIGN KEY ("arrangement_id") REFERENCES "billing_arrangements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_seller_profile_id_fkey" FOREIGN KEY ("seller_profile_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_legal_document_id_fkey" FOREIGN KEY ("legal_document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_checkout_contract_id_fkey" FOREIGN KEY ("checkout_contract_id") REFERENCES "checkout_contracts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_billing_route_id_fkey" FOREIGN KEY ("billing_route_id") REFERENCES "billing_routes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_arrangement_id_fkey" FOREIGN KEY ("arrangement_id") REFERENCES "billing_arrangements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_checkout_contract_id_fkey" FOREIGN KEY ("checkout_contract_id") REFERENCES "checkout_contracts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ---------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express (#46, ADR-019)
-- ---------------------------------------------------------------------------------------------------------

-- A seller nobody can name and nobody can write to is not a seller. The jurisdiction is ISO 3166-1
-- alpha-2 because it is read by tax and invoice configuration, and a lower-case or three-letter code
-- would silently fail to match the configuration it is meant to select.
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_shape_check" CHECK (
  btrim("legal_name") <> ''
  AND btrim("display_name") <> ''
  AND "jurisdiction" ~ '^[A-Z]{2}$'
  -- Deliberately a shape rather than a grammar: an address nobody can reach is caught by sending to it,
  -- and a regular expression that tried to be RFC 5322 would refuse real addresses.
  AND "support_email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
);

-- The product's own capability names, spelled here as well as in `packages/domain/src/billing-routing.ts`.
-- The duplication is the price of having the database refuse a route that claims something no code can
-- consult; `billing-routing.integration.test.ts` holds the two lists against each other so they cannot
-- drift apart in silence.
ALTER TABLE "billing_routes" ADD CONSTRAINT "billing_routes_capabilities_known_check" CHECK (
  "capabilities" <@ ARRAY[
    'RECURRING_SUBSCRIPTIONS','PREPAID_TERM','REFUNDS','DISPUTES','TAX_CALCULATION','TAX_REMITTANCE',
    'INVOICES','CUSTOMER_PORTAL','VERIFIED_WEBHOOKS','AUTHORITATIVE_RECONCILIATION','PRORATION',
    'MULTI_CURRENCY','TIMED_QUOTES'
  ]::TEXT[]
);

-- ISO 4217 is three letters; payment assets are longer and may carry digits. Upper case either way, and
-- the first character is a letter, so a padded or lower-case code cannot create a second price book for
-- the same currency.
ALTER TABLE "billing_routes" ADD CONSTRAINT "billing_routes_terms_check" CHECK (
  btrim("provider") <> ''
  AND array_length("currencies", 1) >= 1
  AND array_length("intervals", 1) >= 1
  -- `ONE_TIME` is a top-up, which is not an arrangement at all; a route offering one as a billing
  -- interval would describe a subscription nobody could cancel.
  AND NOT ('ONE_TIME' = ANY("intervals"))
);

-- The coherence rules, as constraints. The domain checks the same five and returns all of them at once,
-- because an operator fixing a route wants the whole list; this is what makes an incoherent row
-- impossible rather than merely discouraged.
ALTER TABLE "billing_routes" ADD CONSTRAINT "billing_routes_coherence_check" CHECK (
  -- A Merchant of Record that does not remit tax is not a Merchant of Record.
  ("settlement_model" <> 'MERCHANT_OF_RECORD' OR 'TAX_REMITTANCE' = ANY("capabilities"))
  -- A crypto processor charges a time-bounded quote in an asset. Without quotes it is a card processor
  -- that has been labelled wrongly, and the label is what decides how a settlement is judged.
  AND ("settlement_model" <> 'CRYPTO_PROCESSOR' OR 'TIMED_QUOTES' = ANY("capabilities"))
  -- A route that can drive neither a subscription nor a prepaid term can sell nothing.
  AND ('RECURRING_SUBSCRIPTIONS' = ANY("capabilities") OR 'PREPAID_TERM' = ANY("capabilities"))
  -- Nothing arriving on a route with neither verified webhooks nor authoritative reconciliation could
  -- ever become a fact, so such a route could never activate an entitlement. A browser redirect is not
  -- a third option, which is the whole reason this is a constraint and not a comment.
  AND ('VERIFIED_WEBHOOKS' = ANY("capabilities") OR 'AUTHORITATIVE_RECONCILIATION' = ANY("capabilities"))
  -- More than one currency on a route that has not said it can charge in more than one.
  AND (array_length("currencies", 1) = 1 OR 'MULTI_CURRENCY' = ANY("capabilities"))
);

-- Currency and market codes, one element at a time. `unnest` in a CHECK is not allowed, so the shape is
-- asserted by comparing the array against itself filtered — true exactly when every element matches.
CREATE OR REPLACE FUNCTION "currency_codes_valid"(codes TEXT[]) RETURNS BOOLEAN AS $$
    SELECT bool_and(code ~ '^[A-Z][A-Z0-9]{2,11}$') FROM unnest(codes) AS code;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "market_codes_valid"(codes TEXT[]) RETURNS BOOLEAN AS $$
    SELECT COALESCE(bool_and(code ~ '^[A-Z]{2}$'), TRUE) FROM unnest(codes) AS code;
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "billing_routes" ADD CONSTRAINT "billing_routes_codes_check" CHECK (
  "currency_codes_valid"("currencies") AND "market_codes_valid"("markets")
);

-- An arrangement describes money over time, so the money is whole and the clock agrees with the state.
ALTER TABLE "billing_arrangements" ADD CONSTRAINT "billing_arrangements_money_check" CHECK (
  "amount_minor" >= 0 AND "currency" ~ '^[A-Z][A-Z0-9]{2,11}$' AND "interval" <> 'ONE_TIME'
);

ALTER TABLE "billing_arrangements" ADD CONSTRAINT "billing_arrangements_clock_check" CHECK (
  -- An arrangement that is paying for service began doing so at a knowable instant.
  ("state" <> 'ACTIVE' OR "started_at" IS NOT NULL)
  -- A prepaid term grants service until a stated date and nothing more. Without one it would be a
  -- renewal nobody agreed to, which is the entire difference between the two kinds.
  AND ("kind" <> 'PREPAID_TERM' OR "state" <> 'ACTIVE' OR "current_period_end" IS NOT NULL)
  AND (("state" <> 'ENDED' AND "state" <> 'SUPERSEDED') OR "ended_at" IS NOT NULL)
  AND ("ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at")
  -- A row is not its own successor.
  AND ("superseded_by_id" IS NULL OR "superseded_by_id" <> "id")
  -- A superseded row names what replaced it; that is what makes the migration trail readable.
  AND ("state" <> 'SUPERSEDED' OR "superseded_by_id" IS NOT NULL)
);

-- At most one live charge path per workspace: the index that makes "one active commercial arrangement
-- must not be double-charged across two providers" an impossibility rather than a rule. Its predicate is
-- declared in `schema.prisma`, where the reason it is spelled as two inequalities is written down.

-- The claim re-resolves the entitlement immediately before it takes a send, so everything that can make
-- a workspace's commercial state change has to be ordered against it (#40's reasoning, one table over).
--
-- An arrangement activating is what makes paid work allowed, and although `readEntitlement` reads the
-- subscription rather than this table, the two are written in the same transaction — and the alternative
-- was to reason that only the subscription write matters, which is true today and is the kind of true a
-- later field addition quietly breaks.
CREATE TRIGGER "billing_arrangements_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "billing_arrangements"
    FOR EACH ROW EXECUTE FUNCTION "entitlement_take_key"();

-- A contract is a statement about money, a seller and a plan, so each of the three is well-formed.
ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_money_check" CHECK (
  "base_amount_minor" >= 0
  AND "charge_amount_minor" >= 0
  AND "base_currency" ~ '^[A-Z][A-Z0-9]{2,11}$'
  AND "charge_currency" ~ '^[A-Z][A-Z0-9]{2,11}$'
  AND "interval" <> 'ONE_TIME'
  AND "seller_jurisdiction" ~ '^[A-Z]{2}$'
  AND btrim("seller_legal_name") <> ''
);

ALTER TABLE "checkout_contracts" ADD CONSTRAINT "checkout_contracts_quote_check" CHECK (
  -- Charging in something other than the catalogue's currency is a quote, and a quote without an expiry
  -- is a rate nobody can be held to. The converse is allowed: a provider may put a clock on a checkout
  -- session priced in the base currency.
  ("charge_currency" = "base_currency" OR "quote_expires_at" IS NOT NULL)
  AND ("quote_expires_at" IS NULL OR "quote_expires_at" > "opened_at")
  -- A settled checkout produced the arrangement it paid for. Without that link the evidence and the
  -- charge path are two unrelated rows.
  AND ("state" <> 'SETTLED' OR "arrangement_id" IS NOT NULL)
);

/*
  A checkout contract is frozen once written.

  It is the product's evidence of what was offered, to whom, by which seller and on what terms — not a
  cache of those facts. Three columns are exempt and each is exempt for a stated reason:

    * `state`, because the contract's fate is not one of its terms;
    * `provider_checkout_ref`, write-once, because the provider's session object only exists after the
      contract does. Write-once rather than mutable: a second reference would mean a second session, and
      an entitlement later granted against one of them could not be matched to the other;
    * `arrangement_id`, write-once, for the same reason — the arrangement is created by the settlement.

  Everything else, including the seller snapshot, is immutable. Changing a selling entity must not rewrite
  what a customer was told last March.
*/
CREATE OR REPLACE FUNCTION "checkout_contracts_immutable"() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
       OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
       OR NEW."plan_version_id" IS DISTINCT FROM OLD."plan_version_id"
       OR NEW."billing_route_id" IS DISTINCT FROM OLD."billing_route_id"
       OR NEW."seller_profile_id" IS DISTINCT FROM OLD."seller_profile_id"
       OR NEW."seller_legal_name" IS DISTINCT FROM OLD."seller_legal_name"
       OR NEW."seller_jurisdiction" IS DISTINCT FROM OLD."seller_jurisdiction"
       OR NEW."arrangement_kind" IS DISTINCT FROM OLD."arrangement_kind"
       OR NEW."interval" IS DISTINCT FROM OLD."interval"
       OR NEW."base_amount_minor" IS DISTINCT FROM OLD."base_amount_minor"
       OR NEW."base_currency" IS DISTINCT FROM OLD."base_currency"
       OR NEW."charge_amount_minor" IS DISTINCT FROM OLD."charge_amount_minor"
       OR NEW."charge_currency" IS DISTINCT FROM OLD."charge_currency"
       OR NEW."quote_expires_at" IS DISTINCT FROM OLD."quote_expires_at"
       OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        -- The default SQLSTATE (P0001) on purpose: a client library rewrites a constraint-shaped code
        -- into its own wording and the reason is lost, while a raised exception arrives as written.
        RAISE EXCEPTION 'checkout_contracts are immutable: open a new checkout instead';
    END IF;
    IF OLD."provider_checkout_ref" IS NOT NULL AND NEW."provider_checkout_ref" IS DISTINCT FROM OLD."provider_checkout_ref" THEN
        RAISE EXCEPTION 'a checkout already has a provider reference; a second one would be a second session';
    END IF;
    IF OLD."arrangement_id" IS NOT NULL AND NEW."arrangement_id" IS DISTINCT FROM OLD."arrangement_id" THEN
        RAISE EXCEPTION 'a checkout already produced an arrangement';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "checkout_contracts_no_change"
    BEFORE UPDATE ON "checkout_contracts"
    FOR EACH ROW EXECUTE FUNCTION "checkout_contracts_immutable"();

CREATE OR REPLACE FUNCTION "checkout_contracts_no_delete_fn"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'checkout_contracts are never deleted: they are the record of what was offered';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "checkout_contracts_no_delete"
    BEFORE DELETE ON "checkout_contracts"
    FOR EACH ROW EXECUTE FUNCTION "checkout_contracts_no_delete_fn"();

-- A legal document version is an identity somebody accepted, so it is well-formed and it never changes.
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_shape_check" CHECK (
  "version" >= 1 AND btrim("locale") <> '' AND btrim("content_ref") <> ''
);

CREATE OR REPLACE FUNCTION "legal_documents_immutable"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'legal_documents are immutable: publish a new version instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "legal_documents_no_change"
    BEFORE UPDATE OR DELETE ON "legal_documents"
    FOR EACH ROW EXECUTE FUNCTION "legal_documents_immutable"();

-- An acceptance is evidence of consent, so it is append-only. Nothing in the product edits one, and a
-- deletion would remove the only record that a person agreed to anything.
CREATE OR REPLACE FUNCTION "legal_acceptances_append_only"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'legal_acceptances are append-only: consent already given is not edited or removed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "legal_acceptances_no_change"
    BEFORE UPDATE OR DELETE ON "legal_acceptances"
    FOR EACH ROW EXECUTE FUNCTION "legal_acceptances_append_only"();

/*
  An acceptance given for a checkout has to be an acceptance of a document that checkout was actually
  offered under.

  Without this, a contract could satisfy the requirement below by naming a document belonging to another
  selling entity, or one that only became effective afterwards — both of which would record consent to
  terms the customer never saw.
*/
CREATE OR REPLACE FUNCTION "legal_acceptances_applicable"() RETURNS TRIGGER AS $$
DECLARE
    contract RECORD;
    document RECORD;
BEGIN
    IF NEW."checkout_contract_id" IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT "workspace_id", "seller_profile_id", "opened_at" INTO contract
      FROM "checkout_contracts" WHERE "id" = NEW."checkout_contract_id";
    SELECT "seller_profile_id", "effective_from" INTO document
      FROM "legal_documents" WHERE "id" = NEW."legal_document_id";
    IF contract."workspace_id" IS DISTINCT FROM NEW."workspace_id" THEN
        RAISE EXCEPTION 'an acceptance belongs to the workspace whose checkout it was given for';
    END IF;
    IF document."seller_profile_id" IS NOT NULL AND document."seller_profile_id" IS DISTINCT FROM contract."seller_profile_id" THEN
        RAISE EXCEPTION 'legal document belongs to another seller profile than the checkout it was accepted for';
    END IF;
    IF document."effective_from" > contract."opened_at" THEN
        RAISE EXCEPTION 'legal document was not yet effective when the checkout was opened';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "legal_acceptances_applicable_trigger"
    BEFORE INSERT ON "legal_acceptances"
    FOR EACH ROW EXECUTE FUNCTION "legal_acceptances_applicable"();

/*
  A checkout cannot commit without an acceptance of every required legal document.

  Deferred, and it has to be: the acceptances carry a foreign key to the contract, so the contract is
  written first and a plain `AFTER INSERT` trigger would fire before any acceptance could exist. A
  `CONSTRAINT TRIGGER ... INITIALLY DEFERRED` runs at commit, which is the only moment at which the
  question "were the terms accepted for this checkout?" has a stable answer.

  Required is read from the documents rather than from the route, because which documents a market
  requires is a product and legal decision the owner has not made yet — `required_for_checkout` is where
  that decision gets recorded when it is made, and a jurisdiction that needs a privacy acceptance at
  checkout gets one by marking the document, not by changing this trigger.
*/
CREATE OR REPLACE FUNCTION "checkout_contracts_require_acceptance"() RETURNS TRIGGER AS $$
DECLARE
    missing TEXT;
BEGIN
    SELECT string_agg(DISTINCT d."kind"::TEXT, ', ' ORDER BY d."kind"::TEXT) INTO missing
      FROM "legal_documents" d
     WHERE d."required_for_checkout"
       AND d."effective_from" <= NEW."opened_at"
       AND (d."seller_profile_id" IS NULL OR d."seller_profile_id" = NEW."seller_profile_id")
       AND NOT EXISTS (
             SELECT 1 FROM "legal_acceptances" a
               JOIN "legal_documents" ad ON ad."id" = a."legal_document_id"
              WHERE a."checkout_contract_id" = NEW."id" AND ad."kind" = d."kind"
           );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'checkout % has no accepted %', NEW."id", missing;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "checkout_contracts_acceptance_present"
    AFTER INSERT ON "checkout_contracts"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "checkout_contracts_require_acceptance"();

-- A normalized event says what happened, in the product's vocabulary, and says how it became a fact.
-- `VERIFIED_EVENT` and `RECONCILIATION` are the only two; a browser redirect is not a third, and this is
-- where that is a constraint rather than a convention.
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_shape_check" CHECK (
  "activation_source" IN ('VERIFIED_EVENT', 'RECONCILIATION')
  AND "effect" IN ('ACTIVATE', 'EXTEND', 'SUSPEND', 'END', 'NONE')
  AND btrim("provider_event_id") <> ''
  -- An amount without a currency is a number nobody can spend, and a currency without an amount names
  -- nothing. Both absent is an event about no money, which is ordinary.
  AND (("amount_minor" IS NULL) = ("currency" IS NULL))
  AND ("amount_minor" IS NULL OR "amount_minor" >= 0)
  AND ("currency" IS NULL OR "currency" ~ '^[A-Z][A-Z0-9]{2,11}$')
);

-- Append-only. Reconciliation may add a repairing event; it never rewrites one that arrived, because the
-- original is what a dispute is argued from.
CREATE OR REPLACE FUNCTION "billing_events_append_only"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'billing_events are append-only: record a correcting event instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_events_no_change"
    BEFORE UPDATE OR DELETE ON "billing_events"
    FOR EACH ROW EXECUTE FUNCTION "billing_events_append_only"();


-- Two more kinds belong to the workspace rather than to one Business Profile (#46).
--
-- A seller entity sells to the workspace and a charge path pays for the workspace, so neither names a
-- profile; filing them under one would hide them from the only view where they make sense. Still exact
-- rather than permissive, for the reason #38 gave: a kind that *is* about one profile must still name one,
-- or the Business Profile audit view quietly loses rows.
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_scope_check";

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check" CHECK (
  (
    "kind" IN (
      'MEMBER_CHANGED', 'SUBSCRIPTION_CHANGED', 'ENTITLEMENT_OVERRIDDEN', 'DELETION_REQUESTED', 'DELETION_COMPLETED',
      'CHECKOUT_OPENED', 'BILLING_ARRANGEMENT_CHANGED'
    )
    AND "business_profile_id" IS NULL
  )
  OR (
    "kind" NOT IN ('MEMBER_CHANGED', 'SUBSCRIPTION_CHANGED', 'ENTITLEMENT_OVERRIDDEN', 'CHECKOUT_OPENED', 'BILLING_ARRANGEMENT_CHANGED')
    AND "business_profile_id" IS NOT NULL
  )
);
