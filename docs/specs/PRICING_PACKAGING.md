# Pricing & Packaging Specification — v0.2

## Principle

Commercial packaging is data/configuration, not scattered feature checks in UI code.

The product should support multiple plans and grandfathered plan versions without changing domain enums whenever pricing changes.

## Initial packaging shape

Use three customer-facing tiers as the initial product shape:

1. **Starter** — solo/small business, one primary operator.
2. **Growth** — multiple connected business profiles/team members, richer analytics/automation.
3. **Scale** — larger teams/agencies/multi-profile operations, larger limits and advanced controls.

These names are product defaults, not hard-coded billing identifiers. Actual public prices remain a product-owner decision and can change by plan version.

## Accepted connection-counting rule

Customer-facing capacity is counted in **connected business profiles** (commercial connection slots), not by individual channel asset.

One connected business profile may include:
- up to one Instagram professional account; and
- up to one WhatsApp Business number/account for the same business operation.

If the customer adds a second Instagram account **or** a second WhatsApp Business number/account, that consumes a second connected-business-profile slot. A profile may use only one of the two channels and still consumes one slot.

This is a commercial packaging abstraction, not a claim that Instagram and WhatsApp are technically one Meta API asset. The backend keeps their real provider identities separate.

Threads does not count separately while it is unsupported as an MVP DM channel. If a supported official Threads messaging capability is added later, product packaging may attach the corresponding Threads identity to the same business profile without consuming another slot, subject to a future platform/architecture review.

## What should differentiate plans

Prefer capacity/operational scale over crippling the core product promise.

Good differentiators:
- connected business profiles (each may contain up to one Instagram + one WhatsApp connection);
- seats/members;
- voice transcription allowance;
- analytics retention/depth;
- advanced automation controls;
- priority/support/SLA where offered later;
- exports/API/agency controls where added later.

**Accepted packaging decision:** do not expose or sell monthly AI reply/generation-cycle quotas in the initial customer-facing plan table. AI generation remains internally metered for cost attribution, anomaly/abuse detection, capacity planning and future commercial flexibility, but the initial paid plans are customer-facing `UNMETERED` for ordinary AI reply generation unless a later explicit product decision changes this.

Avoid making factual safety, human takeover, audit basics or core policy compliance premium-only. Safety and platform-correctness are product invariants.

## Core feature recommendation

All paid tiers should be capable of the main value proposition:
- unified inbox;
- knowledge + style configuration;
- DRAFT mode;
- AUTOPILOT where channel/policy permits;
- Review Queue and deterministic review/safety gates;
- basic lead pipeline.

Plans then scale operational capacity and advanced operations rather than selling an intentionally unsafe/incomplete low tier.

### DRAFT mode

`DRAFT` means the AI prepares a proposed reply but **does not send it automatically**. An authorized human can review, edit, approve and send it. DRAFT is a conversation/account automation mode, useful during onboarding, sensitive workflows or whenever the owner wants human approval for every AI-written reply.

### Review Queue

`Review Queue` is the centralized workspace that collects conversations/items requiring human action. It is broader than DRAFT mode. It may contain:
- replies created because the account/conversation is in DRAFT mode;
- low-confidence or missing-fact AI drafts;
- sensitive/unsupported cases;
- Instagram human-assisted extended-window sends;
- WhatsApp `TEMPLATE_REVIEW` sends;
- media/transcription failures;
- ambiguous delivery outcomes needing resolution.

Therefore DRAFT is a **mode**, while Review Queue is the **inbox of things that need a person**. AUTOPILOT conversations may also enter Review Queue when deterministic policy refuses unattended delivery.

## Plan definition model

A versioned plan definition includes:
- stable internal `planKey`;
- immutable `planVersion`;
- display name/marketing metadata;
- billing interval options;
- provider price references by currency/interval;
- feature entitlements;
- hard capacity limits;
- internal usage-metering policy;
- overage policy for metered add-ons where applicable;
- trial policy reference;
- availability (`PUBLIC`, `PRIVATE`, `LEGACY`).

Never infer entitlements from display-name strings or provider price IDs in application code.

## Add-ons / overrides

Architecture should support later:
- extra connected-business-profile packs;
- extra seats;
- voice/transcription packs;
- future metered AI usage packs only if the product owner explicitly introduces customer-facing AI quotas later;
- temporary/manual sales overrides.

Overrides must be explicit, scoped, time-bounded where appropriate and audited.

## Trial product direction

Support trialing as a first-class subscription state. Trial length/card requirement are configuration.

Recommended UX behavior:
- trial activation is visible with days/usage remaining where usage applies;
- trial does not silently convert feature semantics;
- before expiry show clear upgrade/expiry consequences;
- expired trial does not delete inbox/history;
- automation stops according to effective entitlement while stored conversations remain available according to workspace-access policy.

A specific trial length (for example 7/14 days) is **not accepted yet** and requires product-owner decision.

## Usage UX

For customer-visible metered add-ons such as voice/transcription, show:
- included amount;
- consumed/remaining amount;
- reset date;
- warning state before exhaustion;
- exact behavior at exhaustion (pause vs overage) based on plan policy.

Do **not** show an AI-replies-per-month quota in the initial pricing/settings UX. Internal AI generation/token/cost telemetry remains available to operators for economics and abuse protection.

Never show provider-token counts as if they were customer billable units unless a later plan explicitly bills by them.

## Overage options

Architecture supports, per metered feature/add-on:
- `HARD_STOP` — no new metered work after quota;
- `TOP_UP_REQUIRED` — purchase/add quota before continuing;
- `AUTO_OVERAGE` — continue and bill approved overage units;
- `UNMETERED` — no customer quota, still track internal cost.

Initial ordinary AI reply generation uses `UNMETERED` customer-facing semantics. Do not silently enable auto-overage. It requires explicit plan/customer authorization.

## Downgrade handling

If a new plan has lower capacity:
- existing data/accounts are not deleted;
- user is shown which resources exceed new limits;
- creation of new excess resources is blocked;
- account/member/channel deactivation is explicit and reversible where practical;
- automation may only run on currently entitled active resources.

## Public pricing vs billing implementation

Public pricing page values come from product configuration/plan catalog, not duplicated constants.

Checkout uses immutable provider price references tied to a plan version. Updating public price creates a new plan version/provider price mapping rather than mutating historical invoice meaning.

## Open product-owner decisions

Before launch choose:
- actual monthly/annual prices and supported currencies;
- connected-business-profile limits per tier;
- seat limits per tier;
- voice/transcription allowances per tier;
- trial length and card requirement;
- which plans allow advanced voice/agency/API features if any commercial gating is desired;
- hard-stop vs paid overage behavior for metered add-ons;
- annual discount policy;
- tax/invoice/payment-provider jurisdiction strategy.
