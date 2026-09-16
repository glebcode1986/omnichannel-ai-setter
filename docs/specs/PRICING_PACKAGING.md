# Pricing & Packaging Specification — v0.3

## Principle

Commercial packaging is data/configuration, not scattered feature checks in UI code.

The product should support multiple plans and grandfathered plan versions without changing domain enums whenever pricing changes.

## Initial packaging shape

Use three customer-facing tiers as the initial product shape:

1. **Starter** — solo/small business, one primary operator.
2. **Growth** — multiple business profiles/team members, richer analytics/automation.
3. **Scale** — larger teams/agencies/multi-profile operations, larger limits and advanced controls.

These names are product defaults, not hard-coded billing identifiers. Actual public prices remain a product-owner decision and can change by plan version.

## Accepted commercial unit: Business Profile

Do not sell/count raw Meta assets separately in the public pricing UI.

A **Business Profile** is the customer-facing connected-business unit:

- up to **1 Instagram account**;
- up to **1 WhatsApp Business account/number**;
- both may be connected at the same time and still consume only **1 Business Profile**;
- if a second Instagram account or a second WhatsApp Business account/number is connected, that requires a second Business Profile slot.

Examples:
- Instagram A only = 1 Business Profile;
- Instagram A + WhatsApp A = 1 Business Profile;
- Instagram A + WhatsApp A + Instagram B = 2 Business Profiles;
- Instagram A + WhatsApp A + WhatsApp B = 2 Business Profiles;
- Instagram A + WhatsApp A + Instagram B + WhatsApp B = 2 Business Profiles.

This is a commercial grouping, not an assertion that Instagram and WhatsApp are technically one Meta API asset. Persistence still models channel accounts independently.

If Threads later gains an official messaging API suitable for this product, the product-owner intent is to include the corresponding Threads presence in the same Business Profile rather than charge an extra slot merely for the channel. That future behavior remains capability/API dependent.

## Accepted AI usage direction

**Do not expose or sell the initial plans by a monthly number of AI replies/generation cycles.**

The customer-facing product promise is not "1,000 AI replies" or a token bucket. Core AI reply generation is included in all paid tiers.

The platform must still meter logical AI generation cycles internally for:
- cost accounting;
- abuse/fair-use protection;
- capacity planning;
- anomaly detection;
- future packaging flexibility;
- reconciliation of provider usage/cost.

Internal provider retries, schema repair attempts and queue retries remain one logical generation operation and must not inflate internal business usage counts.

Initial public plans therefore treat normal AI generation as customer-facing **included/unmetered**, subject to documented fair-use/abuse controls rather than a visible per-message quota. A future plan version may introduce explicit metered AI usage only by a new product-owner decision; the architecture retains usage-ledger capability for that reason.

## What differentiates plans

Prefer capacity/operational scale over crippling the core product promise.

Accepted differentiators:
- Business Profile slots (each slot may contain one Instagram + one WhatsApp connection);
- seats/members;
- voice transcription allowance;
- analytics retention/depth;
- advanced team/automation controls;
- priority/support/SLA where offered later;
- exports/API/agency controls where added later.

Do **not** use public AI-reply counts as an initial differentiator.

Avoid making factual safety, human takeover, audit basics or core policy compliance premium-only. Safety and platform-correctness are product invariants.

## Core features across all paid plans

All paid tiers include:
- unified inbox;
- knowledge + style configuration;
- DRAFT mode;
- AUTOPILOT where channel/policy permits;
- Review Queue;
- deterministic review/safety gates;
- basic lead pipeline;
- normal AI reply generation without a public monthly reply counter.

Definitions for public/product UX:
- **DRAFT** = AI prepares a reply but does not send it until an authorized human reviews/edits/sends it.
- **Review Queue** = the operational queue collecting items that require human attention, including DRAFT replies, low confidence, missing facts, sensitive/unsupported cases, Instagram human-assisted sends, WhatsApp template review, transcription/media failures and ambiguous delivery outcomes.

## Accepted tier capacity direction

| Capability | Starter | Growth | Scale |
|---|---:|---:|---:|
| Business Profiles | 1 | 3 | 10 |
| Instagram + WhatsApp inside each Business Profile | included | included | included |
| Team seats | 1 | 5 | 15 |
| Core AI replies | included / no public quota | included / no public quota | included / no public quota |
| Knowledge Base | included | included | included |
| Style Training | included | included | included |
| DRAFT | included | included | included |
| AUTOPILOT | included | included | included |
| Review Queue | included | included | included |
| Leads | included | included | included |
| Voice transcription | **300 min/month** | **1,500 min/month** | **6,000 min/month** |
| Analytics retention | **30 days** | **6 months** | **24 months** |
| Analytics depth | core operational metrics | conversion/channel/manager/review/knowledge analytics | all Growth analytics + multi-profile rollups/export direction |
| Team roles/controls | single owner | OWNER / ADMIN / AGENT | OWNER / ADMIN / AGENT + advanced scope/audit direction |
| Priority support | — | — | included direction |

Working price hypothesis remains **€49 / €99 / €249 per month**, but prices are not accepted production catalog values yet.

## Accepted voice-transcription behavior

Voice transcription is the initial explicitly customer-metered usage resource.

Included monthly allowances:
- Starter: **300 minutes**;
- Growth: **1,500 minutes**;
- Scale: **6,000 minutes**.

When the included transcription allowance is exhausted:
- text conversations and normal AI behavior continue;
- the incoming voice message remains stored/visible in Inbox;
- automatic transcription is not performed unless additional allowance is available;
- the UI explains that the transcription allowance is exhausted;
- the user may process the item manually or purchase an explicit transcription top-up when that add-on is implemented;
- **no automatic overage charge** is enabled by default.

## Accepted analytics direction

Starter analytics retain the prior **30 days** and cover the core operational view, such as conversation volume, leads, AI-vs-human handling and response-time indicators.

Growth retains **6 months** and additionally supports deeper business analysis such as lead-stage conversion, channel comparison, manager/team analysis, Review Queue reasons and missing-knowledge patterns.

Scale retains **24 months** and adds cross-Business-Profile rollups/comparison plus export direction and deeper audit/operational analysis.

Exact metric names and export formats remain implementation-level product design, but the retention/depth tiers above are accepted commercial behavior.

## Plan definition model

A versioned plan definition includes:
- stable internal `planKey`;
- immutable `planVersion`;
- display name/marketing metadata;
- billing interval options;
- provider price references by currency/interval;
- feature entitlements;
- hard capacity limits;
- internal usage/fair-use policy references;
- voice/transcription quota grants;
- top-up policy where applicable;
- trial policy reference;
- availability (`PUBLIC`, `PRIVATE`, `LEGACY`).

Never infer entitlements from display-name strings or provider price IDs in application code.

## Add-ons / overrides

Architecture should support later:
- extra Business Profile packs;
- extra seats;
- voice/transcription top-up packs;
- future explicitly metered usage packs if product strategy changes;
- temporary/manual sales overrides.

Overrides must be explicit, scoped, time-bounded where appropriate and audited.

## Trial product direction

Support trialing as a first-class subscription state. Trial length/card requirement are configuration.

Recommended UX behavior:
- trial activation is visible with days/allowances remaining;
- trial does not silently convert feature semantics;
- before expiry show clear upgrade/expiry consequences;
- expired trial does not delete inbox/history;
- automation stops according to effective entitlement while stored conversations remain available according to workspace-access policy.

A specific trial length/card rule is **not accepted yet** and requires product-owner decision.

## Usage / fair-use UX

Because the initial product direction does not expose a monthly AI-reply quota, do not show provider-token counts or internal AI-generation counters as a billable allowance.

For voice transcription show:
- included allowance;
- consumed/remaining amount;
- reset date;
- warning state before exhaustion;
- top-up/manual-processing behavior at exhaustion.

Internal AI/cost metering remains visible to product operations/finance tooling, not presented as a customer billable unit unless a future plan version explicitly adopts that model.

## Overage options

Architecture may support explicit future metered resources with:
- `HARD_STOP`;
- `TOP_UP_REQUIRED`;
- `AUTO_OVERAGE`;
- `UNMETERED`.

Initial core AI generation is `UNMETERED` customer-facing. Initial voice transcription uses included allowance + manual/top-up path; automatic paid overage is not enabled by default.

## Downgrade handling

If a new plan has lower capacity:
- existing data/accounts are not deleted;
- user is shown which resources exceed new limits;
- creation of new excess resources is blocked;
- account/member/channel deactivation is explicit and reversible where practical;
- automation may only run on currently entitled active resources.

For Business Profile limits, individual underlying channel connections remain persisted; the user chooses which Business Profiles stay active when a downgrade leaves the workspace over capacity.

## Public pricing vs billing implementation

Public pricing page values come from product configuration/plan catalog, not duplicated constants.

Checkout uses immutable provider price references tied to a plan version. Updating public price creates a new plan version/provider price mapping rather than mutating historical invoice meaning.

## Open product-owner decisions

Before launch choose:
- actual monthly/annual prices and supported currencies;
- trial length and card requirement;
- annual discount policy;
- exact extra Business Profile / extra seat / transcription top-up pricing;
- tax/invoice/payment-provider jurisdiction strategy.
