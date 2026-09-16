# Task Contract — P6-04 Claude

**Issue:** #41 `[P6-04] Implement billing provider adapter and verified webhook lifecycle`  
**Branch:** `feat/p6-04-billing-provider`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38 entitlement model is stable **and** product owner has selected the first billing provider / merchant-jurisdiction route to enable in production. The architecture itself must remain multi-provider and provider-neutral.

## Read first
`BILLING_ENTITLEMENTS.md`, ADR-017, ADR-019, `PHASE6_COMMERCIALIZATION_PLAN.md`, Issue #41, `docs/research/FASTYADS_BILLING_REFERENCE.md`, and implementation-time provider docs.

Before coding, inspect the existing billing implementation directly in `glebcode1986/fastyads`:

- primary working payment flow: `prod/api/src/routes/checkout.ts` (compare with `dev`);
- Stripe: `prod/api/src/services/stripe.ts`;
- Cryptomus: `prod/api/src/services/cryptomus.ts`;
- WayForPay: `prod/api/src/services/wayforpay.ts`;
- PayPal: `prod/api/src/services/paypal.ts`;
- lifecycle/race patterns: `dev/api/src/services/subscription-lifecycle.ts`;
- plan/archive behavior: `dev/api/src/config/plans.ts`.

Do not assume `main` is the newest billing implementation. `prod` is the primary production reference and `dev` contains newer hardening/admin/legal work.

## Objective
Implement the first concrete billing provider behind the provider-neutral application port while preserving an architecture where additional providers can be added without changing product/domain logic.

## Adapt, do not copy blindly
FastyAds is a useful production reference, but this project is multi-tenant/workspace-based and has different entitlements. Reuse the proven payment algorithms and regression knowledge, not FastyAds user/token semantics.

Required adaptation:
- scope billing to `workspaceId`, never only `userId`;
- OWNER-only billing mutations;
- normalize provider events before product logic sees them;
- keep provider SDKs/types/statuses/price IDs in infrastructure;
- map successful payment to immutable plan/subscription/entitlement state, not FastyAds token grants;
- keep success redirects informational only;
- preserve atomic fulfillment, idempotency, reconciliation and late-payment safety patterns from FastyAds.

## Required behavior
- checkout + customer-portal integration where supported;
- create a server-side checkout/order record before redirecting to provider;
- persist expected amount/currency/plan version and opaque provider references;
- raw webhook verification fails closed;
- deterministic normalized billing events;
- duplicate/reordered/replayed events are idempotent;
- fulfillment is atomic with order locking/dedup/state transition;
- secure opaque provider references with workspace isolation;
- no raw card/payment data in our DB/logs;
- reconciliation path for missed/provider-divergent state;
- late settlement never silently loses captured money;
- provider SDK/types remain private to adapter/infrastructure;
- refund/chargeback handling cannot revoke a newer valid subscription;
- cancellation/end-of-period state is revalidated server-side.

## Forbidden
Do not choose a provider implicitly. Do not let provider status/price IDs become application/domain enums or feature checks. Do not paste the monolithic FastyAds checkout route into an app/composition root. Do not port FastyAds credits/tokens as the setter's customer billing model.

## Tests
At minimum cover:
- valid/invalid/missing signature;
- duplicate/reordered/replayed webhook;
- workspace/provider-ID isolation;
- checkout failure/API timeout;
- stale success redirect without verified payment;
- amount/currency mismatch and invalid/non-finite amount hardening;
- provider timeout followed by safe retry/reconciliation;
- missed webhook reconciliation;
- concurrent fulfillment of the same payment;
- late payment after local order expiry;
- cancel/end-period transitions;
- refund/chargeback replay;
- refund of a superseded subscription does not revoke the newer one;
- current subscription refund stops future recurring billing;
- provider-specific regression cases from `FASTYADS_BILLING_REFERENCE.md` relevant to the selected adapter.

Use provider test mode/fixtures only.

## PR
Cite current provider docs/API version used and cite the FastyAds source files/patterns adapted. Run root/integration/security tests. No real charges. Do not merge.