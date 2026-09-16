# Billing & Entitlements Specification — v0.1

## Principle

Billing provider state must never become product domain state directly. The product owns a normalized subscription/entitlement model; Stripe/Paddle/another provider is an adapter behind a port.

The server is authoritative for paid-feature access. UI hiding/disabling is convenience only and never the security or billing boundary.

## Core concepts

- `PlanDefinition`: versioned commercial package definition.
- `PlanVersion`: immutable snapshot of features/limits/pricing references used by a subscription.
- `WorkspaceSubscription`: normalized subscription state for one workspace.
- `EntitlementSnapshot`: effective features/limits after plan, trial, add-ons, overrides and grace-state rules.
- `BillingAccount`: provider-neutral billing identity for a workspace/customer.
- `BillingProviderRef`: opaque provider IDs stored only in billing infrastructure/persistence.
- `UsageCycle`: metering period with authoritative start/end timestamps.
- `UsageCounter`: server-maintained counters per metric/cycle.

## Subscription states

Normalized states:

- `TRIALING`
- `ACTIVE`
- `PAST_DUE`
- `GRACE`
- `CANCELED_PENDING_END`
- `INACTIVE`

Provider-specific states map into these. Product behavior must not branch directly on raw provider strings.

## Entitlement types

### Feature flags

Examples:
- AI draft generation
- AUTOPILOT
- Instagram connection
- WhatsApp connection
- WhatsApp template autopilot
- voice transcription
- analytics/audit depth
- advanced style training
- multi-member workspace
- API/export features when added later

### Hard capacity limits

Examples:
- connected channel accounts
- workspace members/seats
- active knowledge sources/chunks/storage
- saved style examples
- template-autopilot allowlist size if commercialized

### Period usage quotas

Initial customer-facing quota candidate:
- `AI_GENERATION_CYCLES`

Optional/future metrics:
- `VOICE_TRANSCRIPTION_SECONDS`
- `SIMULATION_GENERATION_CYCLES`
- storage/media retention

Provider-level token/cost telemetry is tracked separately from customer-facing quotas.

## Enforcement rules

Every paid operation evaluates an `EntitlementContext` server-side before side effects.

At minimum re-check entitlement:
- before starting an AI generation cycle;
- before scheduling/authorizing AUTOPILOT delivery when AUTOPILOT is gated by plan;
- immediately before delayed send, because subscription/plan may change during delay;
- before connecting an additional channel account;
- before adding a member/seat;
- before starting paid transcription or other metered provider work.

Entitlement loss is another final-send invalidation reason. A scheduled automated customer message must not bypass a subscription/feature change that occurred while it waited.

## Quota behavior

Webhook ingestion and conversation persistence continue even when an AI quota is exhausted. Do not drop customer messages because billing is exhausted.

When AI quota is unavailable:
- new AI generation is held/skipped with normalized reason `BILLING_LIMIT`;
- conversation remains readable and manually manageable according to effective workspace access state;
- no fake AI reply is generated;
- review/audit UI explains the commercial block separately from policy/safety failure.

Usage alerts should support configurable thresholds (for example 80%, 100%). Overage is a commercial policy, not assumed by the domain model.

## Trial / grace behavior

Trial length, card requirement and grace duration are commercial configuration, not hard-coded domain constants.

A grace state may preserve selected features temporarily, but exact behavior must be explicit in the effective entitlement snapshot. Do not infer grace permissions from timestamps in UI code.

## Downgrade / cancellation invariants

- Never delete customer data because a plan loses an entitlement.
- Existing channel/account records may become disabled/read-only rather than deleted.
- Existing knowledge/style data remains stored subject to retention policy; creation/edit capacity may be restricted.
- Pending automated sends revalidate current entitlement before send.
- Provider webhooks are idempotent and may arrive duplicated/out of order.
- Historical plan version/entitlement decisions remain auditable.

## Roles

Billing and plan changes require OWNER (and later explicitly delegated billing role if added). ADMIN/AGENT must not mutate subscription/provider state unless product policy explicitly grants it.

## Provider boundary

Conceptual port:

```ts
interface BillingProvider {
  createCheckout(input: CheckoutRequest): Promise<CheckoutResult>;
  createPortalSession(input: PortalRequest): Promise<PortalResult>;
  verifyWebhook(input: RawBillingWebhook): Promise<VerificationResult>;
  normalizeWebhook(input: RawBillingWebhook): Promise<NormalizedBillingEvent[]>;
}
```

Provider SDK types, secrets, webhook signatures and customer/subscription IDs stay in the billing adapter/infrastructure package and persistence fields designed for opaque provider references.

## Audit requirements

Audit:
- subscription state changes;
- plan/version changes;
- trials/grace transitions;
- manual entitlement overrides;
- quota/overage policy changes;
- checkout/portal initiation actor;
- billing webhook event ID and normalized transition (without sensitive payment data).
