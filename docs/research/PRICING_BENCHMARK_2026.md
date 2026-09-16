# SaaS Pricing Benchmark — 2026-09-16

> Research snapshot, not an accepted pricing decision. Re-check source pages before launch.

## Manychat

Source: https://manychat.com/pricing

Observed current public entry points:
- Essential: from $14/mo (annual display), 250 active contacts/month, 2 channels, 2 users;
- Pro: from $29/mo, 2,500 active contacts/month, up to 3 channels, AI-powered conversations, 3 users;
- Business: from $69/mo, 7,500 active contacts/month, unlimited eligible channels;
- Advanced: from $139/mo;
- public page advertises a 14-day trial on self-service paid tiers;
- additional active-contact charges vary by plan.

Manychat is broad social automation, not a direct one-to-one match for our setter product, but establishes a lower/mid market anchor.

## respond.io

Source: https://respond.io/pricing

Observed current public monthly prices:
- Starter: $79/mo;
- Growth: $159/mo;
- Advanced: $279/mo;
- Enterprise: custom;
- 7-day free trial, no credit card on public page;
- Starter includes 5 users and AI Assist/Prompt; Growth adds AI Agents/workflows; Advanced adds multi-workspace/security/integration features;
- AI credits are included and additional credits are offered as paid overage on current pricing.

respond.io is a closer omnichannel/inbox/AI-agent operational benchmark and establishes a higher-value B2B anchor.

## WATI / Astra

Sources:
- https://www.wati.io/pricing/
- https://www.wati.io/products/astra/pricing/

WATI packages WhatsApp/omnichannel automation with message charges separate from subscription and meters automation/API/AI-related usage. Astra's AI-agent product currently shows a Pro tier around $99/mo with 5,000 monthly credits, team members and knowledge limits.

## WhatsApp pass-through cost reminder

Meta/WhatsApp template-message pricing varies by recipient market/category and can change. Do not bake Meta message prices into our permanent plan definitions. Store/track provider messaging cost separately; decide later whether to pass through at cost, add margin, include an allowance, or require customer-funded WABA credits.

A current third-party rate table reflecting Meta pricing changes is available in Manychat's WhatsApp pricing guide:
https://help.manychat.com/hc/en-us/articles/14281380243740-WhatsApp-pricing-guide

## Packaging implication for our product

Our product is narrower than broad marketing-automation suites but deeper in the AI setter workflow:
- owner-style AI replies;
- factual knowledge grounding;
- lead qualification/stages;
- durable human-like delay;
- deterministic review/safety;
- Instagram + WhatsApp unified inbox;
- human takeover;
- voice transcription path;
- after-window template/human-assisted controls.

A credible initial position should therefore sit above low-end creator automation while remaining below or competitive with heavier team/enterprise omnichannel platforms for comparable team sizes.

## Candidate pricing hypothesis — NOT ACCEPTED

Candidate for product-owner discussion:

| Tier | Monthly hypothesis | Intended customer |
|---|---:|---|
| Starter | €49 | solo/small business, one business operation |
| Growth | €99 | growing business/team, meaningful AI volume |
| Scale | €249 | multi-account/team/agency-like operations |

Annual billing could later carry a ~15–20% effective discount, but exact discount is not accepted.

Do not put these numbers into production plan catalog/provider prices until explicitly approved by the product owner.

## Quota recommendation direction — NOT ACCEPTED

Do not set generation quotas from competitor 'credit' numbers because credit definitions differ. First benchmark our actual average logical-generation cost using the chosen model/routing strategy and representative setter prompts/retrieval context. Then set included `AI_GENERATION_CYCLES` to preserve a healthy gross margin even under a conservative high-context/high-output percentile.

Internal cost telemetry should measure p50/p90/p99 cost per logical generation, including bounded retry/repair overhead, before final quota values are accepted.
