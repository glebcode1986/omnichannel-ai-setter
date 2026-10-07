-- The audit kinds a release decision writes (#60).
--
-- Its own migration, and the reason is a PostgreSQL rule this repository has already paid for once: a
-- value added to an enum by `ALTER TYPE ... ADD VALUE` cannot be *used* by a later statement in the same
-- transaction, and a migration file is one transaction. The next migration extends the severity CHECK,
-- which names these values — so they are added here and used there (55P04 otherwise).
ALTER TYPE "PlatformAuditKind" ADD VALUE 'RELEASE_RECORDED';
ALTER TYPE "PlatformAuditKind" ADD VALUE 'RELEASE_REVIEW_RECORDED';
ALTER TYPE "PlatformAuditKind" ADD VALUE 'ROLLOUT_ALLOWLIST_CHANGED';
