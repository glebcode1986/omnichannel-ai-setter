-- Reading a customer's data out, and deleting it, are themselves auditable actions (#57).
--
-- They are the two that move personal data out of this product or out of existence, so "who did this,
-- and when" is the question an investigation starts with. Marked admin-only by `ADMIN_ONLY_AUDIT_KINDS`
-- for the same reason membership changes are: showing the rows to everybody would make "somebody
-- exported this thread at 14:02" ordinary reading.
ALTER TYPE "AuditEventKind" ADD VALUE 'DATA_EXPORTED';
ALTER TYPE "AuditEventKind" ADD VALUE 'DELETION_REQUESTED';
ALTER TYPE "AuditEventKind" ADD VALUE 'DELETION_COMPLETED';
