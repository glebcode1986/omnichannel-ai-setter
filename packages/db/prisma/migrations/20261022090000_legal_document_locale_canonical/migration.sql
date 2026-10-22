-- One language, one current document (#47).
--
-- `legal_documents.locale` is grouped by to answer "which version is current in this reader's language?",
-- in `current_legal_documents()` here and in `readLegalDocumentOffers` in TypeScript. Both grouped by the
-- stored spelling, so `en-US` and `en-us` were two languages: publishing a replacement under the other
-- spelling left the superseded version current, offered it to the reader, and let the coverage trigger
-- accept consent to it. `publishLegalDocument` now canonicalizes on the way in, and this is the backstop
-- for a row that did not come through it.
--
-- The grouping key is the locale lowercased with `_` folded to `-`. That is deliberately *not* a claim to
-- implement BCP-47 canonicalization in SQL: it cannot see that `iw` and `he` are one language, and only
-- the TypeScript writer collapses those. What it does cover is exactly the class SQL can decide, and it
-- cannot over-collapse: two canonical tags never differ only in case or separator, because canonical case
-- is deterministic — so no two distinct languages can land in one group, while any two case-or-separator
-- spellings of one language always do.
--
-- `ORDER BY` has to carry the same expression as `DISTINCT ON`, and the date and version come after it:
-- once the aliases are in one group, the row PostgreSQL keeps is the newest of the group rather than
-- whichever spelling happened to sort first.
CREATE OR REPLACE FUNCTION "current_legal_documents"(for_seller_profile_id TEXT, as_of TIMESTAMP(3))
RETURNS TABLE ("id" TEXT, "kind" "LegalDocumentKind", "locale" TEXT, "required_for_checkout" BOOLEAN) AS $$
    SELECT DISTINCT ON (d."kind", lower(replace(d."locale", '_', '-')))
           d."id", d."kind", d."locale", d."required_for_checkout"
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
     ORDER BY d."kind", lower(replace(d."locale", '_', '-')), d."effective_from" DESC, d."version" DESC;
$$ LANGUAGE sql STABLE;

-- The two spellings a canonical tag provably never has: an underscore separator, and surrounding
-- whitespace. Both are forms the grouping above would still collapse correctly; the point of refusing
-- them is that `locale` is also *displayed* to the reader as the language a document is published in, and
-- `ru_RU` is not a language tag anybody should be shown. Nothing a canonical tag can be is rejected here,
-- so this can never refuse a legitimate publication.
ALTER TABLE "legal_documents"
  ADD CONSTRAINT "legal_documents_locale_well_formed"
  CHECK ("locale" = btrim("locale") AND "locale" <> '' AND position('_' in "locale") = 0);

-- And the state itself, not only the read of it: two rows of one kind and one language may not share a
-- version number. The declared `(kind, locale, version)` unique is on the stored spelling, so `en-US` v1
-- and `en-us` v1 satisfied it — which is how two first versions of one document came to exist with
-- neither superseding the other. Folded the same way the function groups.
CREATE UNIQUE INDEX "legal_documents_kind_language_version_key"
  ON "legal_documents" ("kind", lower(replace("locale", '_', '-')), "version");
