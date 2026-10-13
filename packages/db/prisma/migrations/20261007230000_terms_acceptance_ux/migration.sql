-- The current required document versions, the reader's own language, and a linkable refund policy (#47).
--
-- Three changes, and the first two exist because #46 left the store and the database disagreeing about
-- what "accepted" means.
--
-- `checkout_contracts_require_acceptance` asks only for *an* acceptance of each required *kind*, while
-- `openCheckoutContract` offers only the current version of each kind in one locale. The gap is not
-- theoretical: a caller reaching the tables directly could satisfy the trigger with a superseded version,
-- and the issue's words are "the current required document versions are explicitly accepted". So the
-- applicability trigger now also requires each acceptance to name the *current* version of its kind and
-- locale, and the coverage trigger reads the requirement from the current version rather than from any
-- effective row — which also closes the opposite hole, where an old version marked required went on
-- demanding an acceptance after a newer version had stopped requiring one.
--
-- The second disagreement is the locale. `readLegalDocumentOffers` filtered by an exact locale while this
-- trigger filters by none, so a workspace whose interface is in a language the offer has not been
-- translated into was offered *no documents at all* and then had its checkout killed by this trigger with
-- a raw exception. The product half of that fix is locale negotiation in the store; the evidence half is
-- `legal_acceptances.locale`, which records the language of the page somebody accepted on.

-- AlterEnum
ALTER TYPE "LegalDocumentKind" ADD VALUE 'REFUND_POLICY';

-- AlterTable
ALTER TABLE "legal_acceptances" ADD COLUMN     "locale" TEXT NOT NULL;


-- ---------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express (#47)
-- ---------------------------------------------------------------------------------------------------------

-- A locale nobody can read is not a locale. The column is free text because the set of published
-- languages grows; `openCheckoutContract` canonicalizes the tag through `canonicalLanguageTag` before it
-- arrives, so `RU-ru` and `ru-RU` cannot become two languages in a query that groups by this column.
--
-- Added `NOT NULL` with no default and no backfill, which is safe here and would not be in general: #46
-- is unmerged, no deployment has ever been able to open a checkout (`checkoutAvailable` is false without
-- a provider adapter, and #41 has not chosen one), so the table is empty by construction wherever this
-- migration runs.
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_locale_check" CHECK (btrim("locale") <> '');

-- A published location a reader can actually open (#47).
--
-- `content_ref` stays opaque in the sense that matters — nothing parses it, nothing branches on it, and
-- the text is not stored here — but it is rendered as the link somebody reads *before* they tick the box,
-- so it has to be a URL. Every value written under #46 was a path fragment (`terms/en/1`), which as an
-- `href` on the checkout route resolves to a page that does not exist: a checkbox asking for consent to
-- something unreadable, which is the one thing this issue exists to prevent.
--
-- `https` only. A contract handed over a channel that can be rewritten in transit is not evidence of
-- anything.
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_content_ref_check" CHECK ("content_ref" ~ '^https://[^[:space:]]+$');

/*
  The current document of each kind and locale, for a checkout opened at a given instant.

  One function, used by both triggers below, because the whole point of this migration is that they stop
  disagreeing. The precedence is the store's own, written once here:

    * only documents already in force at `opened_at` — a version published for next month exists and is
      not offered, so it cannot be accepted either;
    * only documents applicable to this seller entity — its own, or the global ones;
    * a seller-specific document displaces a global one of the same kind and locale however new the global
      one is, because an entity that published its own offer has superseded the generic text for its own
      checkouts;
    * and within that, the newest in force, then the highest version.
*/
--
-- The parameters are prefixed, and that is not a style choice. A parameter named `seller_profile_id` is
-- shadowed by the column of the same name, and PostgreSQL resolves the ambiguity in favour of the column
-- *silently* — so `d."seller_profile_id" = seller_profile_id` compares the column to itself and every
-- seller's documents become applicable to every seller. The existing acceptance suite caught it, which is
-- the only reason this comment exists rather than the bug.
--
-- Specificity dominates locale, and the order matters. `DISTINCT ON (kind, locale)` over the applicable
-- rows would keep a global `ru` document alongside the seller's own `en` one, and a Russian reader would
-- then be offered the platform's generic offer for a checkout whose contract names that seller's legal
-- name and jurisdiction — the entity's own text losing on language before it could win on being its own.
-- So a kind the seller has published at all is read *only* from the seller's own versions, and
-- `readLegalDocumentOffers` filters the same way before it negotiates a locale.
CREATE OR REPLACE FUNCTION "current_legal_documents"(for_seller_profile_id TEXT, as_of TIMESTAMP(3))
RETURNS TABLE ("id" TEXT, "kind" "LegalDocumentKind", "locale" TEXT, "required_for_checkout" BOOLEAN) AS $$
    SELECT DISTINCT ON (d."kind", d."locale") d."id", d."kind", d."locale", d."required_for_checkout"
      FROM "legal_documents" d
     WHERE d."effective_from" <= as_of
       AND (d."seller_profile_id" IS NULL OR d."seller_profile_id" = for_seller_profile_id)
       AND (
             d."seller_profile_id" = for_seller_profile_id
             OR NOT EXISTS (
                  SELECT 1 FROM "legal_documents" own
                   WHERE own."kind" = d."kind"
                     AND own."seller_profile_id" = for_seller_profile_id
                     AND own."effective_from" <= as_of
                )
           )
     ORDER BY d."kind", d."locale", d."effective_from" DESC, d."version" DESC;
$$ LANGUAGE sql STABLE;

/*
  An acceptance given for a checkout has to name a document that checkout was actually offered under, in
  the version it was offered in.

  The applicability half was already here in #46: the right workspace, the right seller entity, already in
  force. What is new is "in the version it was offered in" — without it, a caller could satisfy the
  coverage trigger below with a superseded version, which is consent to terms that are no longer the
  terms. The message names the superseded document on purpose: the screen's answer to it is "the terms
  changed, read them again", not a generic refusal.
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
    SELECT "seller_profile_id", "effective_from", "kind", "locale" INTO document
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
    IF NOT EXISTS (
        SELECT 1 FROM "current_legal_documents"(contract."seller_profile_id", contract."opened_at") current
         WHERE current."id" = NEW."legal_document_id"
    ) THEN
        RAISE EXCEPTION 'legal document % is superseded; the current % (%) has to be accepted instead',
            NEW."legal_document_id", document."kind", document."locale";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/*
  A checkout cannot commit without an acceptance of every required legal document.

  Still deferred, and still for the reason #46 gave: the acceptances carry a foreign key to the contract,
  so the contract is written first and a plain `AFTER INSERT` trigger would fire before any acceptance
  could exist.

  What changed is where "required" is read from. It is now the *current* version's own flag rather than any
  effective row's, so a withdrawn requirement actually stops being required — and a kind counts as required
  when the current document of that kind in **any** applicable locale requires it. That last clause is
  deliberately the conservative reading, and it is also exactly what `requiredKindsOf` in
  `billing-routing-store.ts` computes: the two have to agree, or a reader in one language is offered a
  checkbox nobody asked for while a reader in another is refused for want of one they were never shown.
*/
CREATE OR REPLACE FUNCTION "checkout_contracts_require_acceptance"() RETURNS TRIGGER AS $$
DECLARE
    missing TEXT;
BEGIN
    SELECT string_agg(DISTINCT required."kind"::TEXT, ', ' ORDER BY required."kind"::TEXT) INTO missing
      FROM "current_legal_documents"(NEW."seller_profile_id", NEW."opened_at") required
     WHERE required."required_for_checkout"
       AND NOT EXISTS (
             SELECT 1 FROM "legal_acceptances" a
               JOIN "legal_documents" ad ON ad."id" = a."legal_document_id"
              WHERE a."checkout_contract_id" = NEW."id" AND ad."kind" = required."kind"
           );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'checkout % has no accepted %', NEW."id", missing;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
