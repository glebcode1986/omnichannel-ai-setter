-- A checkout and a charge path are material actions (#46, ADR-019).
--
-- Admin-only, like a subscription change: they name the selling entity, the amount and the person who
-- accepted the terms, and an agent has no reason to read any of it.
--
-- Its own migration, and it has to be. PostgreSQL refuses to *use* a new enum value in the transaction
-- that added it, and the next migration rewrites `audit_events_scope_check` to name both of these — so
-- adding the values and referencing them in one file would fail with 55P04 on an empty database.
ALTER TYPE "AuditEventKind" ADD VALUE 'CHECKOUT_OPENED';
ALTER TYPE "AuditEventKind" ADD VALUE 'BILLING_ARRANGEMENT_CHANGED';
