# Phase 6 Implementation Plan — Commercial SaaS / Billing / Usage

**Status:** Architecture prepared. Concrete payment provider and public prices are not selected yet.

## Goal

Turn the operational product into a sellable multi-tenant SaaS without coupling product behavior to one payment provider.

Target flow:

```text
workspace owner
  -> selects plan/trial
  -> provider-neutral checkout request
  -> billing provider
  -> verified/idempotent billing webhook
  -> normalized WorkspaceSubscription
  -> EntitlementSnapshot
  -> server-side gates + UsageCycle/ledger
  -> usage/quota UI + audit
```

## Work packages

### P6-01 — Entitlement/plan domain + persistence

Implement versioned plan definitions, subscription state, entitlement snapshots, overrides and workspace-scoped persistence. Do not integrate a payment provider yet.

### P6-02 — Usage ledger + quota reservation

Implement idempotent logical-operation usage ledger, usage cycles, atomic quota reservation/commit/release and materialized totals.

### P6-03 — Entitlement integration into AI/channel operations

Enforce server-side feature/quota gates before AI generation, channel capacity changes, paid transcription and delayed automated send. Billing exhaustion must never drop inbound webhooks/messages.

### P6-04 — Billing provider adapter + verified webhook lifecycle

Select one concrete production billing provider only after product/legal/payment-jurisdiction decision. Implement provider adapter, checkout/customer portal and webhook normalization behind ADR-017.

### P6-05 — Billing/settings/usage UI

Expose plan, trial/subscription status, entitlements, quota usage, reset date, invoices/portal link, upgrade/downgrade and clear exhaustion behavior.

### P6-06 — Plan packaging + trial/overage configuration

Load versioned Starter/Growth/Scale plan catalog from server-side product configuration. Final public prices, currencies, quota numbers, trial duration and overage behavior require product-owner acceptance.

### P6-07 — Commercial E2E + reconciliation

Exercise checkout/webhook/subscription transitions, quota concurrency, delayed-send entitlement revalidation, downgrade/cancel, usage reconciliation and multi-workspace isolation without real card charges in automated tests.

### R6 — independent Codex/Astra review

Review tenant isolation, webhook verification/idempotency, money/provider boundary, quota races, double charging, entitlement bypasses, stale delayed sends, downgrade/cancel behavior, audit and secret/PCI-sensitive logging.

## Dependency graph

```text
P6-01 plans/entitlements
   |         \
   v          v
P6-02 usage  P6-04 provider adapter
   |          /
   +----+----+
        v
P6-03 enforcement
        |
        +-------> P6-05 UI
        |
        +-------> P6-06 packaging config
                  |
                  v
               P6-07 E2E

R6 reviews incrementally.
```

P6-01/P6-02 can be implemented once Phase 1 DB/application boundaries are stable. P6-03 requires the relevant AI/delivery use cases. P6-04 waits for billing-provider/product-jurisdiction decision. P6-05 may begin with provider-neutral subscription/usage fixtures.

## Exit criteria

- every workspace resolves an authoritative entitlement snapshot;
- plan versions are immutable/auditable and historical subscriptions keep their meaning;
- one logical generation cannot be billed twice under duplicate workers/retries;
- hard quota reservation is safe under concurrency;
- inbound customer messages remain persisted when quota/subscription blocks AI;
- delayed automated sends revalidate current entitlement before delivery;
- billing webhook replay/reordering cannot corrupt subscription state;
- product UI never treats client-side entitlement state as authority;
- downgrade/cancel does not delete customer data;
- provider secrets/payment details are never stored/logged outside accepted provider references/flows;
- automated tests do not require real payment credentials/card charges.

## Open owner decisions before provider integration / launch

- billing provider and merchant/legal jurisdiction strategy;
- public monthly/annual prices + currencies;
- quotas per plan;
- trial duration/card requirement;
- overage model;
- annual discount;
- whether advanced features are plan-gated vs only capacity-gated.
