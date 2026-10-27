-- Severity for the three release kinds, in the database as well as in the domain (#60).
--
-- The CHECK is rewritten rather than extended, because it is one constraint listing every kind: a kind
-- absent from all three arms would be refused outright, which is the property that makes the pairing
-- enforced rather than conventional.
--
-- Why each:
--
-- `RELEASE_RECORDED` is `WARNING`, for the kill switch's own reason read in the other direction. A kill
-- switch is a deliberate, visible, reversible act that stops the product doing something; recording a
-- release is a deliberate, visible act that can *start* the product doing something — it is what moves
-- the §18 stage in force, and therefore what can permit unattended sending across the platform. That is
-- the same kind of serious, not a lesser one, and it is the row an incident review reads after the switch.
--
-- `ROLLOUT_ALLOWLIST_CHANGED` is `WARNING` for the narrower version of the same fact: it is what permits
-- one Business Profile to send unattended during a limited rollout.
--
-- `RELEASE_REVIEW_RECORDED` is `INFO`. Filing somebody's verdict changes no permission by itself — a
-- `PASS` only matters in combination with gates that already permit a release, and a
-- `CHANGES_REQUESTED` only ever subtracts.
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_severity_check";

ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_severity_check" CHECK (
  ("kind" IN ('BREAK_GLASS_OPENED', 'CUSTOMER_CONTENT_READ') AND "severity" = 'CRITICAL')
  OR (
    "kind" IN (
      'PLATFORM_MEMBER_CHANGED',
      'SUPPORT_SESSION_OPENED',
      'KILL_SWITCH_PULLED',
      'KILL_SWITCH_LIFTED',
      'RELEASE_RECORDED',
      'ROLLOUT_ALLOWLIST_CHANGED'
    )
    AND "severity" = 'WARNING'
  )
  OR (
    "kind" IN ('WORKSPACE_INSPECTED', 'SUPPORT_SESSION_REVOKED', 'RECONCILIATION_REQUESTED', 'RELEASE_REVIEW_RECORDED')
    AND "severity" = 'INFO'
  )
);
