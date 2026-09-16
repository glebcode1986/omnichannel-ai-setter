# Review Contract — R6 Codex/Astra

**Issue:** #45 `[R6] Codex/Astra independent billing, quota and entitlement review`  
**Role:** independent reviewer/test author, not primary feature implementer.

## Read first
All Phase 6 specs/ADRs, exact implementation issue/contract, then the PR diff.

## Review invariants
- provider billing types/IDs/statuses do not leak into domain/application/product feature logic;
- workspace scoping and OWNER authorization on billing mutations;
- webhook verification fails closed and events are idempotent/reorder-safe;
- logical usage operation cannot be charged twice;
- last-quota-unit reservation is atomic under concurrency;
- provider retries/tokens do not become customer usage accidentally;
- delayed automated sends revalidate current entitlement;
- billing exhaustion does not drop inbound messages;
- downgrade/cancel does not delete data;
- stale UI cannot authorize a paid action;
- provider secrets/payment details are not logged/stored improperly;
- plan/version/override/usage decisions remain auditable.

## Adversarial tests
Forged/replayed/reordered billing webhook, cross-workspace provider ref, two workers racing final quota unit, provider timeout/retry, entitlement loss during delayed send, downgrade over capacity, stale checkout-success client, usage counter/ledger mismatch and reconciliation.

## Deliverable
Return `PASS` or `CHANGES_REQUESTED` with exact evidence. Add independent regression tests where practical. Systemic failures require spec/ADR correction, not provider-specific exceptions.