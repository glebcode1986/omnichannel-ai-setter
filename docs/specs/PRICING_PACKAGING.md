# Pricing & Packaging Specification — v0.6

## Principle

Commercial packaging is data/configuration, not scattered feature checks in UI code.

The product should support multiple plans and grandfathered plan versions without changing domain enums whenever pricing changes.

## Initial packaging shape

Use three customer-facing self-serve tiers as the initial product shape:

1. **Starter** — solo/small business, one primary operator.
2. **Growth** — multiple business profiles/team members, richer analytics/automation.
3. **Scale** — larger teams/agencies/multi-profile operations, larger limits and advanced controls.

These names are product defaults, not hard-coded billing identifiers.

For organizations needing more than the self-serve Scale limits, expose **Custom / Contact us** rather than inventing a fourth fixed public tier. Custom may extend Business Profiles, seats, support/SLA, retention, exports/API or agency controls by explicit agreement.

## Accepted public pricing

Initial launch pricing is accepted as:

| Plan | Monthly | Annual |
|---|---:|---:|
| Starter | **€49/month** | **€490/year** |
| Growth | **€99/month** | **€990/year** |
| Scale | **€249/month** | **€2,490/year** |

EUR is the initial primary public price book currency. Additional currencies may be introduced later as separate versioned price books; application/domain logic must not assume EUR forever.

Annual pricing follows the accepted rule **pay for 10 months, receive 12 months of service** (approximately 16.7% effective discount). Public UX may market this as **"2 months free with annual billing"**.

Growth should be visually positioned as the primary/most-popular self-serve plan, subject to final marketing design.

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

## Accepted tier capacities

| Capability | Starter | Growth | Scale |
|---|---:|---:|---:|
| Public price | **€49/mo** | **€99/mo** | **€249/mo** |
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

Above 10 Business Profiles or 15 seats, the pricing UX should route to **Custom / Contact us** rather than silently stacking an arbitrary unlimited number of add-ons.

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
- the user may process the item manually or purchase an explicit transcription top-up;
- **no automatic overage charge** is enabled by default.

## Accepted analytics direction

Starter analytics retain the prior **30 days** and cover the core operational view, such as conversation volume, leads, AI-vs-human handling and response-time indicators.

Growth retains **6 months** and additionally supports deeper business analysis such as lead-stage conversion, channel comparison, manager/team analysis, Review Queue reasons and missing-knowledge patterns.

Scale retains **24 months** and adds cross-Business-Profile rollups/comparison plus export direction and deeper audit/operational analysis.

Exact metric names and export formats remain implementation-level product design, but the retention/depth tiers above are accepted commercial behavior.

## Accepted trial policy

Initial self-serve trial behavior:

- **14 days**;
- **no payment card required** to start;
- trial starts when the workspace successfully connects its **first Business Profile**, not merely when the user creates an account;
- trial should expose the real product value rather than a crippled demo;
- trial allowance: **1 Business Profile**, up to **3 team seats**, all core AI/Knowledge/Style/DRAFT/AUTOPILOT/Review/Leads features, and **100 voice-transcription minutes**;
- the product clearly shows trial days and relevant allowance remaining.

At trial expiry without a paid subscription:
- customer data is not deleted;
- Inbox/history, Knowledge, Style and Leads remain stored/readable according to the workspace-access policy;
- paid AI generation/automation/transcription actions stop until entitlement becomes active again;
- the user can still enter the product, inspect retained data and select a paid plan;
- after payment/activation the workspace resumes from the retained state rather than forcing a new setup.

The user does **not** need to choose Starter/Growth/Scale before experiencing the trial. Preferred funnel is: create account -> connect first Business Profile -> trial -> choose a paid plan before/at expiry.

## Accepted annual billing policy

All public paid tiers support monthly and annual billing.

Annual pricing is **€490 / €990 / €2,490** for Starter/Growth/Scale respectively and uses immutable plan/version/provider price references just like monthly subscriptions; future price changes never rewrite historical subscription meaning.

## Accepted add-on policy

Initial self-serve add-ons are accepted as follows:

| Add-on | Price | Billing behavior |
|---|---:|---|
| +1 Business Profile | **€25/month** | recurring; increases Business Profile capacity by 1 |
| +1 team seat | **€7/month** | recurring; increases member/seat capacity by 1 |
| +500 voice-transcription minutes | **€8** | one-time top-up |
| +2,000 voice-transcription minutes | **€25** | one-time top-up |
| +5,000 voice-transcription minutes | **€49** | one-time top-up |

Rules:
- add-ons increase capacity/allowance but **do not upgrade the feature class of the base plan**;
- e.g. Starter + an extra Business Profile still has Starter analytics/retention/team-control entitlements;
- recurring Business Profile/seat add-ons added mid-cycle are prorated for the remaining paid period where the billing provider supports reliable proration;
- removing a recurring add-on takes effect at the end of the already-paid period unless a provider/customer-specific refund policy explicitly says otherwise;
- voice top-ups are never purchased automatically and do not create surprise overage invoices;
- unused voice top-up minutes may carry through the end of the **next** billing period, after which they expire unless a future product decision changes the rule;
- top-up usage is consumed only after the plan's included monthly voice allowance for the current billing period is exhausted;
- the product should proactively recommend a plan upgrade when the selected base plan + recurring add-ons costs as much as or more than a higher plan while providing fewer features; the user is never force-upgraded;
- self-serve add-ons must not become an accidental substitute for negotiated Custom when a workspace materially exceeds Scale size.

Pricing UX should show the effective monthly total before checkout/update and clearly distinguish recurring add-ons from one-time top-ups.

## Accepted subscription lifecycle summary

Commercial lifecycle behavior is defined in `BILLING_ENTITLEMENTS.md` and includes:
- upgrade effective immediately after authoritative payment confirmation;
- downgrade effective at end of paid period;
- cancel-at-period-end by default;
- 3-day failed-renewal grace period;
- no customer-data deletion on downgrade/cancel/failed payment/refund/chargeback;
- refund/chargeback scoped to the exact paid term and unable to revoke a newer valid subscription;
- payment provider may change between terms without changing the plan model.

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
- add-on/top-up policy references;
- trial policy reference;
- availability (`PUBLIC`, `PRIVATE`, `LEGACY`).

Never infer entitlements from display-name strings or provider price IDs in application code.

## Usage / fair-use UX

Because the initial product direction does not expose a monthly AI-reply quota, do not show provider-token counts or internal AI-generation counters as a billable allowance.

For voice transcription show:
- included allowance;
- purchased top-up balance;
- consumed/remaining amount;
- reset/expiry date;
- warning state before exhaustion;
- top-up/manual-processing behavior at exhaustion.

Internal AI/cost metering remains visible to product operations/finance tooling, not presented as a customer billable unit unless a future plan version explicitly adopts that model.

## Overage options

Architecture may support explicit future metered resources with:
- `HARD_STOP`;
- `TOP_UP_REQUIRED`;
- `AUTO_OVERAGE`;
- `UNMETERED`.

Initial core AI generation is `UNMETERED` customer-facing. Initial voice transcription uses included allowance + explicit one-time top-ups; automatic paid overage is not enabled.

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

## Remaining launch decisions

Before production launch choose/configure:
- which payment providers are enabled first;
- which legal seller entity/jurisdiction is used for each billing route;
- tax/invoice/Merchant-of-Record behavior per billing route;
- exact Custom commercial policy and sales process if/when first needed.
