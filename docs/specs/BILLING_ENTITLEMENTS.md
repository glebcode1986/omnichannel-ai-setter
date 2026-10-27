# Billing & Entitlements Specification — v0.2

## Principle

Billing provider state must never become product domain state directly. The product owns a normalized subscription/entitlement model; Stripe/Cryptomus/WayForPay/PayPal/Merchant-of-Record/another provider is an adapter behind a port.

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

Initial customer-facing capacities include:
- Business Profile slots (commercial unit; each may contain up to 1 Instagram + 1 WhatsApp connection);
- workspace members/seats;
- analytics retention/depth;
- active knowledge/style capacity where commercialized later.

### Period usage quotas

Initial customer-facing metered resource:
- `VOICE_TRANSCRIPTION_SECONDS`.

Core AI reply generation is **included/unmetered customer-facing** in the initial public plans. Logical AI generation cycles must still be metered internally for cost accounting, abuse/fair-use protection, capacity planning and reconciliation, but they are not an initial public billing quota.

Optional/future customer-facing metrics may include:
- explicit AI generation quota in a future plan version only by product-owner decision;
- simulation generation cycles;
- storage/media retention;
- other provider-backed metered features.

Provider-level token/cost telemetry is tracked separately from customer-facing quotas.

## Enforcement rules

Every paid operation evaluates an `EntitlementContext` server-side before side effects.

At minimum re-check entitlement:
- before starting AI generation when the workspace must have an active/trial entitlement;
- before scheduling/authorizing AUTOPILOT delivery;
- immediately before delayed send, because subscription/plan may change during delay;
- before connecting an additional Business Profile/channel account;
- before adding a member/seat;
- before starting paid transcription or another explicitly metered provider operation.

Entitlement loss is another final-send invalidation reason. A scheduled automated customer message must not bypass a subscription/feature change that occurred while it waited.

## What stops, and what does not (P6-03)

Three questions, deliberately not one, because they are enforced in different places and collapsing them
produces a product that either overcharges or locks people out of their own data.

| question | asked by | consults payment | example |
|---|---|---|---|
| may this be *used* now? | `featureAllowed` | yes | transcribing a recording, generating a draft, an automated send |
| does the plan *state* this? | `snapshot.features[f]` | no | reporting what a plan includes |
| does a chosen plan *withhold* this from configuration? | `featureWithheld` | no | connecting a channel |

Configuration is not paid work. A business whose payment has lapsed may still reconnect a channel, rename a
profile or reorganize what it already owns; what stops is generation, automation and transcription. And a
workspace that has chosen **no plan at all** withholds nothing, because connecting its first Business
Profile is the act that starts its trial — a gate that refused it would close the product's own front door.
`capacityVerdict` answers the capacity question on the same terms.

A permitting subscription state is not a permanent permission. `TRIALING` and `CANCELED_PENDING_END` each
carry their own end date, and when it passes paid work stops even though no row has been written — so a
check that read only the state would keep a cancelled workspace sending until a provider webhook happened
to arrive. `GRACE` is left to its state: its duration is product configuration and its mechanics are
provider retry schedules, so the transition out of it belongs to the billing adapter.

Because an entitlement can therefore change with the clock as well as with a write, the delivery
coordinator **re-resolves** it immediately before taking a send rather than binding a row version, and
orders that read against concurrent plan changes with an advisory key held exclusively by a trigger on
`workspace_subscriptions` and `entitlement_overrides`.

A commercial refusal **holds** a reply; it never cancels one. The spec above says a workspace resumes from
retained state once it pays, and a cancelled reply would have nothing to resume.

## Usage behavior

Webhook ingestion and conversation persistence continue when a workspace is past trial, past grace, over a capacity limit or out of an explicitly metered allowance. Never drop inbound customer messages because billing is unavailable.

For initial core AI generation there is no public monthly reply quota. If service access itself is inactive, new paid AI/automation work is held/skipped with a normalized billing/access reason while the conversation remains persisted and manually inspectable according to workspace access policy.

For voice transcription allowance exhaustion:
- text conversations and normal AI handling of text continue;
- incoming voice/media remains stored and visible in Inbox;
- automatic transcription does not run without available included/top-up allowance;
- the UI explains the allowance state separately from policy/safety failure;
- no automatic overage charge occurs unless a future product decision explicitly enables it.

## Accepted trial behavior

Initial trial policy is product configuration and has been accepted as:
- 14 days;
- no payment card required;
- starts after successful connection of the first Business Profile, not merely account creation;
- 1 Business Profile;
- up to 3 team seats;
- all core Knowledge/Style/DRAFT/AUTOPILOT/Review/Leads capabilities;
- 100 voice-transcription minutes.

At trial expiry without payment:
- no customer data is deleted;
- Inbox/history, Knowledge, Style, Leads and configuration remain stored/readable according to workspace-access policy;
- paid AI generation, automation and transcription stop until a paid entitlement becomes active;
- after payment the workspace resumes from retained state rather than forcing a new setup.

## Accepted failed-payment / grace behavior

For an otherwise valid renewing subscription whose renewal payment fails:
- enter `PAST_DUE`/`GRACE` according to normalized provider mapping;
- initial grace duration is **3 days**;
- inbound webhooks/messages continue to persist throughout grace;
- product shows a clear payment warning and asks the OWNER to update/complete payment;
- grace must never be implemented as UI-only authorization;
- after grace expires without successful payment, paid AI/AUTOPILOT/transcription actions stop, while retained workspace data remains available according to access policy.

Grace timing and exact provider retry mechanics stay configurable because providers differ; the product-level 3-day access policy is authoritative for the initial launch plan.

## Accepted upgrade behavior

- A plan upgrade becomes effective only after authoritative server-side confirmation of the required payment/checkout state.
- Browser `success`/return URLs are never sufficient to activate entitlements.
- Once confirmed, upgraded features/capacities take effect immediately.
- Provider-specific proration/payment mechanics are normalized behind billing infrastructure and must not leak into product feature checks.

## Accepted downgrade behavior

- A requested downgrade takes effect at the end of the already-paid period unless a future explicit commercial rule says otherwise.
- No automatic refund is issued solely for the remaining time in the current period.
- Customer data is never deleted because the future plan has lower capacity.
- If the future plan permits fewer Business Profiles/seats/resources than currently exist, the user is shown the excess and must choose which remain active at transition.
- Excess resources remain retained/inactive/read-only where practical rather than deleted.
- New creation above the future/effective capacity is blocked as appropriate.
- Automation runs only on resources that remain entitled/active after the transition.

## Accepted cancellation behavior

- Canceling a recurring subscription means cancel-at-period-end by default.
- The customer keeps the already-paid entitlement through the current period end.
- At period end, if no replacement/renewal payment exists, the workspace becomes inactive for paid AI/AUTOPILOT/transcription actions.
- History, Inbox, Knowledge, Style, Leads and other customer data are not deleted by cancellation itself.
- Account/data deletion is a separate explicit workflow governed by retention policy.
- Resume/undo cancellation may be supported while the paid period is still active and provider capability permits it.

### Telling the provider — best-effort, and in that order (accepted)

A cancellation is **committed locally first**, and that is what the customer is told. The request asking
the provider to stop renewing happens afterwards and may fail: a decision somebody made must not depend on
a third party being reachable, and a provider timeout that lost a cancellation would be much the worse of
the two failures.

Whatever happens to that request is written to the audit trail, including that it could not be made and
that the provider has no such request to make. That record is the difference between a cancellation which
takes effect by itself and one somebody has to act on before the next charge, and it is the only durable
consequence: a failed request to stop renewing changes nothing about what the workspace is entitled to
today, because only a verified event ends an entitlement.

There is deliberately **no retry loop** around it. The repair path for a product state behind the
provider's is `reconcileProviderState` (ADR-019), and until something calls it periodically the audit row
is for a person. A retry here would be an unsupervised loop impersonating reconciliation.

And a renewal that arrives anyway **cannot undo the cancellation** — see `BILLING_ROUTING.md`
§"What an event may do": recorded, never resurrected.

## Accepted refund / chargeback behavior

### Refund

- A provider-confirmed refund changes entitlement only after server-side verification/normalization.
- Refund handling must be scoped to the exact paid order/term it reverses.
- A refund of an old/superseded purchase must **not** revoke a newer valid subscription purchased later.
- Provider events may be duplicated/reordered; refund processing is idempotent.
- Retained customer data is not deleted because a payment was refunded.

### Chargeback / dispute

- A verified chargeback/dispute may place paid automated actions on hold/restricted state while the dispute is reviewed, according to normalized policy.
- Inbound customer messages continue to persist.
- Data is not deleted solely because a dispute exists.
- If the dispute resolves in the merchant's favor, eligible paid access may resume.
- If money is finally reversed, the reversed payment no longer supplies entitlement for that term, without damaging any newer independent paid term.

## Payment-provider switching

A workspace may pay one term through one provider and a later term through another provider. Product plans/subscriptions are not permanently bound to Stripe, Cryptomus, WayForPay, PayPal or any other provider.

Switching providers must not create overlapping untracked recurring billing. If a new payment replaces a live auto-renewing provider subscription, the old recurring obligation must be safely detached/cancelled only after the new paid state is durably established, with reconciliation/alerting on provider API failure.

## Roles

Billing and plan changes require OWNER (and later an explicitly delegated billing role if added). ADMIN/AGENT must not mutate subscription/provider state unless product policy explicitly grants it.

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

Provider SDK types, secrets, webhook signatures and customer/subscription IDs stay in billing adapter/infrastructure code and persistence fields designed for opaque provider references.

## Reconciliation and payment-safety invariants

- Browser redirect/return status never grants entitlement by itself.
- Webhook verification fails closed.
- Checkout order stores authoritative expected product/order data before external payment confirmation.
- Fulfillment is idempotent and transaction-safe under duplicate/concurrent webhook delivery.
- Missed webhook/provider divergence has a reconciliation path.
- Late settlements are never silently discarded when money may have moved; they are either safely fulfilled within policy or flagged for manual reconciliation.
- Refund/chargeback events are matched to the exact provider/order reference and cannot cross workspaces.
- Raw card/payment credentials are never stored in product DB/logs.

## Reference implementation for Claude

When implementing Phase 6 billing, Claude must read `docs/research/FASTYADS_BILLING_REFERENCE.md` and inspect `glebcode1986/fastyads` directly. Use FastyAds `prod` as the reference for working payment flows and `dev` for newer hardening/legal/admin improvements. Reuse proven mechanisms conceptually (and code where technically/licensing-wise appropriate) while adapting them to workspace-based provider-neutral architecture rather than copying the legacy user/token model blindly.

## Audit requirements

Audit:
- subscription state changes;
- plan/version changes;
- trials/grace transitions;
- manual entitlement overrides;
- voice allowance/top-up changes;
- checkout/portal initiation actor;
- billing webhook event ID and normalized transition (without sensitive payment data);
- upgrade/downgrade/cancel requests and effective dates;
- refund/chargeback transitions;
- provider-switch/reconciliation anomalies.
