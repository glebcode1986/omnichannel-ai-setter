-- What a workspace pays for, and who was given more than they pay for (#38).
--
-- Admin-only, like membership changes: an agent has no reason to read either, and an override visible to
-- everybody is an invitation to ask why somebody else got one.
ALTER TYPE "AuditEventKind" ADD VALUE 'SUBSCRIPTION_CHANGED';
ALTER TYPE "AuditEventKind" ADD VALUE 'ENTITLEMENT_OVERRIDDEN';
