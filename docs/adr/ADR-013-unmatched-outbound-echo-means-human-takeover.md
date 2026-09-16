# ADR-013: Unmatched outbound echo triggers human takeover

**Status:** Accepted

## Decision

An outbound platform echo correlated to a stored app send is our own echo and does not pause AI. An outbound echo that cannot be correlated to an app operation/platform message ID is treated as manual/native human activity and pauses automation.

## Consequences

- channel adapters must preserve identifiers needed for correlation;
- message-text matching alone is insufficient;
- native Instagram/WhatsApp human replies can hand off control even when they bypass our dashboard.
