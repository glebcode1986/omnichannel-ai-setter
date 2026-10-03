-- The operator's own interface language (LOCALIZATION.md, Issue #58).
--
-- On the user, and deliberately nowhere near a Business Profile. The language someone reads the software in
-- has nothing to do with the language the assistant answers customers in: an agency operator may read
-- Russian while replying in German on behalf of a business configured in English, and all three are
-- correct at once. Coupling them would put the operator's language into a customer's inbox.
--
-- NULL means the product's fallback locale rather than "unknown", so an account that never expressed a
-- preference needs no backfill and no default row.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ui_locale" TEXT;

