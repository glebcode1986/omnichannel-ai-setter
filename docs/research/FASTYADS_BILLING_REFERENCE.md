# FastyAds Billing Reference for Omnichannel AI Setter

This document maps the existing, production-used billing implementation in `glebcode1986/fastyads` to the Phase 6 billing work in `glebcode1986/omnichannel-ai-setter`.

## Source priority

Use the FastyAds branches as reference, not as code to copy blindly:

1. `prod` — primary reference for working payment flows and production hardening.
2. `dev` — reference for newer hardening, admin-managed plans/legal docs, and regression fixes not yet in prod.
3. `main` — historical/context only; do not assume it contains the latest billing behavior.

The FastyAds branches have diverged. Always inspect the exact referenced branch/file before adapting behavior.

## Payment flow reference

### Unified checkout + fulfillment
Primary reference:
- repo: `glebcode1986/fastyads`
- branch: `prod` and compare with `dev`
- file: `api/src/routes/checkout.ts`

Patterns to preserve conceptually:
- create a server-side order before redirecting to a provider;
- persist expected amount/currency/product identity;
- verify provider webhook before granting anything;
- validate amount and currency server-side;
- lock the order row during fulfillment (`SELECT ... FOR UPDATE` or equivalent);
- deduplicate provider events inside the same transaction;
- atomically transition order + grant entitlement;
- notifications/partner/admin side effects happen after commit;
- support reconciliation for missed webhooks;
- late settlement must never silently lose captured money;
- stale/success-return browser pages never grant entitlement.

Do **not** copy FastyAds token-grant semantics. Omnichannel AI Setter is workspace/subscription/entitlement based and has different commercial rules.

### Stripe adapter
Reference:
- `prod/api/src/services/stripe.ts`

Useful patterns:
- separate one-time and recurring checkout creation;
- integer minor-unit conversion;
- `cancel_at_period_end` and resume behavior;
- raw webhook signature verification;
- fail closed if webhook signing secret is missing;
- opaque provider IDs kept inside infrastructure/billing records;
- reconciliation for missed events.

### Cryptomus adapter
Reference:
- `prod/api/src/services/cryptomus.ts`

Useful patterns:
- signed invoice creation;
- raw-body-aware callback verification;
- invoice currency separated from payer crypto currency;
- underpayment tolerance handled explicitly;
- only settled statuses grant service;
- ambiguous/unusable amount does not silently grant or destroy the order.

### WayForPay adapter
Reference:
- `prod/api/src/services/wayforpay.ts`

Useful patterns:
- signed checkout request;
- callback signature verification;
- currency validation;
- fiscal receipt metadata capture as best-effort after the payment decision.

### PayPal adapter
Reference:
- `prod/api/src/services/paypal.ts`

Useful patterns:
- IPN verification;
- transport/provider outage is not treated as a forged payment;
- return URL is UX only; verified provider notification is authoritative.

## Subscription lifecycle reference

Reference:
- `dev/api/src/services/subscription-lifecycle.ts` (compare with `prod` when behavior differs)

Useful patterns:
- renewal/expiry races must be compare-and-swap/revalidated at write time;
- provider delivery delay may require an explicit grace state without granting free service;
- periodic jobs must be idempotent under multiple workers;
- reminders and post-commit notifications must never roll back subscription state.

For the setter, adapt these ideas to `WorkspaceSubscription` / entitlement snapshots rather than FastyAds user/token rows.

## Refund / chargeback reference

Reference:
- `dev/api/src/routes/checkout.ts` and corresponding prod implementation.

Regression cases to carry over:
- replayed refund webhook;
- refund for an old/superseded subscription must not revoke a newer valid subscription;
- provider transaction IDs may have several equivalent forms and must be reconciled deliberately;
- unmatched refund/chargeback requires operational alert, not silent success;
- future recurring billing must be cancelled when the refunded subscription is the currently active one;
- revocation must be idempotent.

## Plan catalog reference

Reference:
- `dev/api/src/config/plans.ts`

Useful patterns:
- one server-authoritative plan catalog;
- provider price IDs must not be the product plan identity;
- archived plans continue resolving for existing subscribers but are not purchasable by new customers;
- plan configuration may be overridden/admin-managed without rewriting historical purchases.

Setter-specific requirement: use immutable `PlanVersion` semantics from Phase 6 specs; do not reuse FastyAds token fields.

## Legal documents / consent reference

References:
- `dev/src/legal/types.ts`
- `dev/src/legal/index.ts`
- `dev/src/legal/en.ts` and translations
- `dev/db/migrations/093_legal_documents.sql`
- `dev/db/migrations/095_legal_consent_version.sql`

Useful patterns:
- `privacy`, `terms`, `refund`, `offer` as separate legal documents;
- English source with localized variants;
- published legal versions are immutable;
- user acceptance stores the exact document version and locale;
- admin edits create a new version instead of rewriting history.

Do **not** copy FastyAds legal text verbatim. The setter must replace FastyAds-specific language (credits, image/video generation, named service provider) with setter-specific concepts: workspaces, Instagram/WhatsApp messaging, customer message content, Meta integrations, AI drafting/autopilot, voice transcription, team access, retention, and the selected seller/legal entity.

## Architecture adaptation rules

The new product is multi-tenant and must remain provider-neutral:
- billing is scoped to `workspaceId`, not `userId`;
- OWNER-only billing mutations;
- application/domain must not import Stripe/Cryptomus/WayForPay/PayPal SDKs or enums;
- provider adapters implement application-owned billing ports;
- entitlement decisions are server-authoritative;
- provider state is normalized before entering product logic;
- no raw card data is stored;
- provider references are opaque and workspace-scoped;
- success redirects are informational only;
- webhook/reconciliation state changes are idempotent and auditable.

## Mandatory regression scenarios to port from FastyAds experience

At minimum test:
- forged/missing-signature webhook;
- duplicate and reordered webhook;
- checkout success URL opened without confirmed payment;
- missed webhook followed by reconciliation;
- amount/currency mismatch;
- non-finite/invalid amount hardening;
- Cryptomus payer-currency vs invoice-currency mismatch;
- Stripe renewal/expiry race;
- two workers processing one payment;
- late settlement after local order expiry;
- provider timeout during verification;
- refund/chargeback replay;
- refund of superseded subscription;
- current subscription refund cancels future recurring billing;
- cross-workspace provider reference isolation.

## Implementation instruction for Claude

Before implementing P6-04 or later payment/legal work, Claude must inspect the exact FastyAds files above directly in GitHub. Reuse concepts and proven algorithms where they fit, but rewrite them to respect the setter's monorepo boundaries, workspace model, entitlement model, and Phase 6 ADRs. Do not paste the monolithic FastyAds checkout route into an app/composition root.
