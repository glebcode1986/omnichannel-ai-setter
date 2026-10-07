# ADR-019 — Multi-provider billing routing and seller profiles

## Status
Accepted product/architecture direction for Phase 6 commercial design. Concrete production provider and seller entity remain configurable decisions.

## Context
The product may accept payments through different classes of providers over time, including direct payment processors, Merchant-of-Record providers and crypto/payment processors. The commercial seller/recipient legal entity may also differ by market or provider arrangement (for example, one configured company in Ukraine or Romania, or a Merchant of Record acting as seller to the customer).

Provider choice and seller/legal-entity choice are related operationally but are not the same concept. They must not leak into plan/domain semantics or require product code to branch on Stripe/Paddle/crypto-specific identifiers.

## Decision
Introduce a provider-neutral billing-routing layer owned by the application/commercial boundary.

### SellerProfile
`SellerProfile` represents the commercial seller/merchant configuration used for a checkout/arrangement. It identifies the applicable legal/commercial profile through opaque configuration references and display/legal metadata needed by checkout/legal-document presentation. Secrets, processor account credentials and raw tax-provider configuration remain infrastructure concerns.

Changing a seller entity does not mutate historical subscriptions, invoices or acceptance records. Historical checkouts remain tied to the seller profile snapshot that applied when they were created.

### BillingRoute
A `BillingRoute` selects an allowed combination of:
- billing provider adapter;
- provider account/configuration;
- SellerProfile;
- supported currencies/payment assets;
- provider capabilities;
- allowed markets/plan intervals where configured.

The client never supplies authoritative provider-account or seller IDs. It requests a product checkout; the server selects a valid route from trusted configuration.

### Provider capabilities
Adapters expose normalized capabilities rather than pretending every provider behaves identically. Capabilities may include:
- recurring subscriptions;
- one-off/prepaid term payment;
- refunds;
- chargebacks/disputes;
- tax calculation;
- tax collection/remittance / Merchant-of-Record role;
- invoice/receipt generation;
- customer portal;
- signed/verified webhooks;
- proration;
- multi-currency;
- time-bounded crypto/payment quotes and settlement status.

Tax calculation and tax remittance are separate capabilities. A processor that can calculate tax is not automatically treated as Merchant of Record.

### BillingArrangement
Normalize commercial access through a `BillingArrangement` that can distinguish at least:
- `RECURRING` — provider-managed recurring subscription;
- `PREPAID_TERM` — a settled payment grants service until an explicit period end, without assuming automatic renewal.

This allows providers with different recurring-payment capabilities to drive the same normalized entitlement model without faking unsupported behavior.

### Checkout and activation
A checkout attempt snapshots at minimum:
- workspace/customer actor;
- immutable plan/version;
- catalog/base price and currency;
- selected trusted BillingRoute and SellerProfile;
- billing interval/arrangement type;
- applicable legal-document versions and acceptance record;
- provider checkout/request reference after creation.

A browser redirect or `success` page is never authoritative evidence of payment. Paid entitlements activate only after a verified provider event or authoritative provider reconciliation confirms the required paid/settled state.

### Money and crypto/payment quotes
Money is represented with minor units or an exact decimal-safe representation; floating-point money is forbidden.

The product catalog may have a base price in EUR while an adapter creates a time-bounded quote in another supported fiat currency or crypto asset. The quote does not rewrite the underlying plan/version price meaning. The adapter records quote/settlement metadata and normalized paid status. Expired, underpaid, ambiguous or otherwise unsettled payments do not activate paid entitlement.

### Provider switching
An active arrangement is bound to its BillingRoute. Switching provider or seller entity is an explicit migration/new-arrangement operation. Never create a second active charge path silently. Migration must prevent overlapping duplicate billing and preserve old provider references for audit/reconciliation.

### Webhooks and reconciliation
Each provider adapter owns signature/authenticity verification and raw provider parsing. It emits provider-neutral normalized billing events. Duplicate, replayed and reordered events are handled idempotently.

Reconciliation may repair missed/divergent provider state, but it does not erase original events or historical arrangement snapshots.

### Public Offer / Terms acceptance
Checkout requires an auditable, versioned acceptance snapshot before redirection to payment. The product should use an explicit acceptance control in the checkout UX rather than relying only on the later act of payment as evidence of consent.

Acceptance records are append-oriented and contain the applicable legal-document version IDs, actor/workspace, accepted timestamp and checkout attempt reference. Final legal wording, governing law, seller identity, refunds/cancellation wording and jurisdiction-specific requirements require product-owner/legal approval before production launch.

## Consequences
- Concrete providers can be added as adapters without changing plan/domain semantics.
- Ukraine/Romania/other seller profiles can be configured later without rebuilding the commercial core.
- Merchant of Record and direct-processor responsibilities remain distinguishable.
- Crypto/prepaid flows can coexist with recurring card subscriptions.
- Provider success redirects cannot grant unauthorized paid access.
- We accept additional implementation work for route selection, capability modeling, legal-document versioning and migration safety.

## Non-goals
- Choosing the first production payment provider.
- Choosing the final selling legal entity.
- Drafting final legal text or providing jurisdiction-specific legal advice.
- Storing raw card/payment credentials in application storage.
