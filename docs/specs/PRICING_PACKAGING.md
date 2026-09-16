# Pricing & Packaging Specification — v0.1

## Principle

Commercial packaging is data/configuration, not scattered feature checks in UI code.

The product should support multiple plans and grandfathered plan versions without changing domain enums whenever pricing changes.

## Initial packaging shape

Use three customer-facing tiers as the initial product shape:

1. **Starter** — solo/small business, one primary operator, low-to-moderate AI volume.
2. **Growth** — multiple channel accounts/team members, higher AI volume, richer analytics/automation.
3. **Scale** — larger teams/agencies/multi-account operations, larger limits and advanced controls.

These names are product defaults, not hard-coded billing identifiers. Actual public prices/quotas remain a product-owner decision and can change by plan version.

## What should differentiate plans

Prefer capacity/operational scale over crippling the core product promise.

Good differentiators:
- connected Instagram/WhatsApp accounts;
- seats/members;
- included AI generation cycles per billing period;
- voice transcription allowance;
- analytics retention/depth;
- advanced automation controls;
- priority/support/SLA where offered later;
- exports/API/agency controls where added later.

Avoid making factual safety, human takeover, audit basics or core policy compliance premium-only. Safety and platform-correctness are product invariants.

## Core feature recommendation

All paid tiers should be capable of the main value proposition:
- unified inbox;
- knowledge + style configuration;
- DRAFT mode;
- AUTOPILOT where channel/policy permits;
- deterministic review/safety gates;
- basic lead pipeline.

Plans then scale limits and advanced operations rather than selling an intentionally unsafe/incomplete low tier.

## Plan definition model

A versioned plan definition includes:
- stable internal `planKey`;
- immutable `planVersion`;
- display name/marketing metadata;
- billing interval options;
- provider price references by currency/interval;
- feature entitlements;
- hard capacity limits;
- usage quota grants;
- overage policy;
- trial policy reference;
- availability (`PUBLIC`, `PRIVATE`, `LEGACY`).

Never infer entitlements from display-name strings or provider price IDs in application code.

## Add-ons / overrides

Architecture should support later:
- extra channel-account packs;
- extra seats;
- AI usage packs/overage;
- voice/transcription packs;
- temporary/manual sales overrides.

Overrides must be explicit, scoped, time-bounded where appropriate and audited.

## Trial product direction

Support trialing as a first-class subscription state. Trial length/card requirement are configuration.

Recommended UX behavior:
- trial activation is visible with days/usage remaining;
- trial does not silently convert feature semantics;
- before expiry show clear upgrade/expiry consequences;
- expired trial does not delete inbox/history;
- automation stops according to effective entitlement while stored conversations remain available according to workspace-access policy.

A specific trial length (for example 7/14 days) is **not accepted yet** and requires product-owner decision.

## Quota UX

Show:
- included quota;
- consumed/remaining amount;
- reset date;
- warning state before exhaustion;
- exact behavior at exhaustion (pause vs overage) based on plan policy.

Never show provider-token counts as if they were customer billable units unless the plan explicitly bills by tokens.

## Overage options

Architecture supports, per plan:
- `HARD_STOP` — no new metered AI work after quota;
- `TOP_UP_REQUIRED` — purchase/add quota before continuing;
- `AUTO_OVERAGE` — continue and bill approved overage units;
- `UNMETERED` — no customer quota, still track internal cost.

Do not silently enable auto-overage. It requires explicit plan/customer authorization.

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
- quota values per tier;
- trial length and card requirement;
- whether Starter includes multiple channels or one connected account;
- which plans allow `TEMPLATE_AUTOPILOT` / advanced voice features if any commercial gating is desired;
- hard-stop vs paid overage behavior;
- annual discount policy;
- tax/invoice/payment-provider jurisdiction strategy.
