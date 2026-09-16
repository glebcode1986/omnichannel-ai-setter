# Upstream Extraction Map — v1

**Date:** 2026-09-16

Decision vocabulary:

- `COPY_ADAPT` — MIT-licensed source is a strong candidate for selective code adaptation; preserve required notice and record exact copied files/changes in `THIRD_PARTY.md`.
- `REIMPLEMENT` — preserve behavior/idea but write to our contracts/data model from scratch.
- `REFERENCE_ONLY` — study tests/API handling/UX, but do not import production code directly.
- `REJECT` — intentionally do not carry this approach into the product.

## OpenSetter

Upstream: `xbirimensah/opensetter`  
Anchor: `aa7d97c38b6d6698df1202d87c00fef5c983cfcb`  
License: MIT

| Upstream path | Behavior / reason to inspect | Decision | Target | Notes |
|---|---|---|---|---|
| `lib/queue/client.ts` | BullMQ connection/queue setup and job conventions | COPY_ADAPT | `packages/queue` | Keep only generic queue plumbing; rename payloads to channel-neutral contracts. |
| `lib/queue/ai-setter-worker.ts` | AI reply lifecycle, history/style loading, safety gates, stale/supersede checks, human-takeover pause, retries | REIMPLEMENT | `packages/application`, `packages/queue`, `apps/worker` | Excellent behavior reference but tightly coupled to Prisma Instagram models and a 24h constant. Channel window logic belongs behind adapter policy. |
| `lib/ai-setter/send.ts` | Atomic `SENDING` claim, conflict handling, interrupted-send recovery, ambiguous outcome quarantine | COPY_ADAPT | `packages/application`, `packages/db` | High-value reliability pattern. Replace direct Meta call and Instagram fields with `ChannelAdapter.send()` + normalized `SendResult`. Preserve MIT notice for substantially adapted code. |
| `lib/polling/dm-reconciler.ts` | Reconciliation after missed/incomplete DM processing | REIMPLEMENT | `packages/application`, `apps/worker` | Useful recovery semantics; make channel-neutral and reconciliation-event driven. |
| `lib/ai-setter/generate.ts` | Structured reply generation orchestration | COPY_ADAPT | `packages/application` (orchestration, output schema), `packages/ai` (provider call) | Remove Instagram/domain coupling, adopt our output schema/reason codes. |
| `lib/ai-setter/llm.ts` | Provider invocation/error handling | COPY_ADAPT | `packages/ai` | Implement the application-owned `ReplyModel` port; support multiple providers without leaking provider types. |
| `lib/ai-setter/prompt.ts` | Setter prompt composition | REIMPLEMENT | `packages/ai` | Product behavior/prompt-injection boundary differs; use as scenario reference only. |
| `lib/ai-setter/safety.ts` | Deterministic auto-send safety checks | COPY_ADAPT | `packages/domain` / `packages/application` | Keep pure deterministic gates where possible; extend with our mandatory-review/policy checks. |
| `lib/ai-setter/types.ts` | Draft types | REIMPLEMENT | `packages/domain` (semantic types), `packages/application` (model-output schema) | Our channel-neutral and structured-output contracts are canonical. |
| `lib/ai-setter/knowledge.ts` | Retrieval strategy | REIMPLEMENT | `packages/application` (ports), `packages/db` (retrievers), `packages/ai` (embeddings) | Storage/indexing must match our schema; separate factual knowledge from style memory. |
| `lib/ai-setter/knowledge-local.ts` | Local retrieval fallback | REFERENCE_ONLY | `packages/ai` | Possible dev/test utility later, not primary architecture. |
| `lib/meta/client.ts` | Instagram Graph/Send API payload/error behavior | REFERENCE_ONLY | `packages/channel-instagram` | Revalidate every API detail against current Meta docs before implementation. |
| `lib/meta/oauth.ts` | Instagram auth/token flow | REFERENCE_ONLY | `packages/channel-instagram`, `apps/web` | Our preferred auth path is current Instagram Login; copy only after confirming upstream uses compatible flow. |
| `lib/meta/webhook.ts` | Instagram webhook parsing/verification patterns | COPY_ADAPT selectively | `packages/channel-instagram` | Adapter-only; normalized events must hide provider payload shape from core. |
| `lib/workspace-access.ts` | Workspace authorization patterns | REIMPLEMENT | `packages/application`, `apps/web` | Our OWNER/ADMIN/AGENT model and repository-scoping contract are canonical. |
| `lib/workspace.ts` | Workspace resolution | REIMPLEMENT | `packages/application`, `apps/web` | Same reason; use tests/scenarios as reference. |
| `lib/auth.ts` | Auth.js + Prisma baseline | COPY_ADAPT selectively | `apps/web`, `packages/db` | Compatible stack, but providers/session claims must match our workspace model. |
| `prisma/schema.prisma` | Existing Auth/Workspace/DM/AI models and indexes | REFERENCE_ONLY | `packages/db` | Do not copy whole schema; our ContactIdentity/channel-neutral model is different. |
| `prisma/migrations/20260524151500_agency_workspaces/migration.sql` | Workspace schema ideas | REFERENCE_ONLY | `packages/db` | Useful constraints/index ideas. |
| `prisma/migrations/20260730120000_add_ai_setter/migration.sql` | AI setter persistence fields/states | REFERENCE_ONLY | `packages/db` | Mine status/audit ideas, not Instagram-specific table design. |
| `prisma/migrations/20260801170000_add_sending_status/migration.sql` | Sending/claim state | REFERENCE_ONLY | `packages/db` | Reinforces explicit send state machine. |
| `__tests__/ai-setter-send.test.ts` | Atomic-send/ambiguous-send regression scenarios | COPY_ADAPT | tests for application/db | Test semantics are especially valuable after refactor. |
| `__tests__/ai-setter-worker.test.ts` | worker gates, stale conversation, takeover scenarios | COPY_ADAPT | application/worker tests | Convert fixtures to normalized channel data. |
| `__tests__/webhook.test.ts` | webhook idempotency/normalization scenarios | COPY_ADAPT selectively | Instagram adapter/ingestion tests | Provider-specific fixtures remain in Instagram package. |
| `__tests__/agency-workspaces.test.ts` | tenant isolation scenarios | COPY_ADAPT selectively | db/application tests | Adapt to our membership roles. |
| `__tests__/rate-limiter.test.ts` | limiter edge cases | REFERENCE_ONLY | queue/application tests | Rate/quota policy will be redesigned per channel/account. |
| `lib/queue/dm-worker.ts` | campaign/DM worker implementation | REFERENCE_ONLY | `apps/worker` | Too Instagram/campaign specific for core. |
| `worker/dm-worker.ts` | standalone worker bootstrap | COPY_ADAPT selectively | `apps/worker` | Useful process/shutdown pattern. |
| follower/campaign cold-DM-specific code | outbound campaign initiation | REJECT for MVP | none | MVP is inbound conversational setter; no unsolicited follower blasting/scraping. |

### OpenSetter extraction principles

The highest-value code to adapt is the **reliability machinery**, not the Instagram-shaped domain: atomic send claim; safe retry distinction; ambiguous-send quarantine; stale reply suppression; deterministic safety gates; worker bootstrap/tests. The channel-neutral domain and service-window logic are reimplemented around our ports.

## wacrm

Upstream: `ArnasDon/wacrm`  
Anchor: `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d`  
License: MIT

| Upstream path | Behavior / reason to inspect | Decision | Target | Notes |
|---|---|---|---|---|
| `src/lib/whatsapp/webhook-signature.ts` | HMAC-SHA256 verification of raw body, fail-closed config, constant-time comparison | COPY_ADAPT | `packages/channel-whatsapp` | Strong self-contained security utility. Preserve MIT notice if substantially adapted. |
| `src/lib/whatsapp/meta-api.ts` | Cloud API HTTP calls, media/templates/interactive payloads, provider error mapping | COPY_ADAPT selectively | `packages/channel-whatsapp` | Split low-level client/payload builders from application persistence. Validate Graph API version/current fields against Meta docs. |
| `src/lib/whatsapp/send-message.ts` | unified text/template/media/interactive send orchestration | REIMPLEMENT | `packages/channel-whatsapp`, `packages/application` | Valuable behavior, but currently combines Supabase persistence/contact resolution/flow pause with transport. Our adapter returns `SendResult`; application owns persistence/handoff. |
| `src/lib/whatsapp/resolve-conversation.ts` | inbound contact/conversation resolution | REIMPLEMENT | `packages/application`, `packages/db` | Supabase/data-model specific; map into Contact/ContactIdentity/Conversation. |
| `src/lib/whatsapp/template-send-builder.ts` | template payload construction | COPY_ADAPT | `packages/channel-whatsapp` | Pure/provider-specific logic is appropriate inside adapter. |
| `src/lib/whatsapp/template-validators.ts` | template validation/Meta constraints | COPY_ADAPT | `packages/channel-whatsapp` | Re-check current Meta limits before release. |
| `src/lib/whatsapp/template-status-normalize.ts` | provider status normalization | COPY_ADAPT | `packages/channel-whatsapp` | Maps naturally into normalized status types. |
| `src/lib/whatsapp/template-webhook.ts` | template-status webhook handling | REIMPLEMENT | `packages/channel-whatsapp` | Normalize to core events; do not persist directly from adapter. |
| `src/lib/whatsapp/interactive.ts` | interactive button/list validation/building | COPY_ADAPT later | `packages/channel-whatsapp` | Phase 4, capability-gated. |
| `src/lib/whatsapp/phone-utils.ts` | phone normalization/variants/provider error helpers | COPY_ADAPT | `packages/channel-whatsapp` | Pure utility + tests; keep policy-sensitive behavior isolated. |
| `src/lib/whatsapp/wa-identity.ts` | phone vs business-scoped user ID targeting | COPY_ADAPT concepts | `packages/channel-whatsapp`, `packages/domain` identity mapping | Keep WhatsApp addressing details out of generic Contact entity. |
| `src/lib/whatsapp/mirror-inbound-media.ts` | fetching/mirroring inbound media | REFERENCE_ONLY now | channel-whatsapp/storage | Phase 4 media work; storage design not frozen yet. |
| `src/app/api/whatsapp/webhook/route.ts` | production webhook sequencing/error cases | REFERENCE_ONLY | `apps/web`, channel-whatsapp | Our route must be channel-neutral/thin; mine fixtures and edge cases only. |
| `src/app/api/whatsapp/webhook/route.test.ts` | extensive webhook cases | COPY_ADAPT scenarios | WhatsApp adapter/ingestion tests | Adapt fixtures around normalized-event contract. |
| `src/app/api/whatsapp/send/route.ts` | direct API send endpoint | REFERENCE_ONLY | none | Our application delivery use case owns sends; avoid duplicate path. |
| `src/app/api/whatsapp/send/route.test.ts` | validation/error UX cases | COPY_ADAPT scenarios | channel-whatsapp/application tests | Keep relevant edge cases. |
| `src/lib/ai/auto-reply.ts` | AI reply flow | REFERENCE_ONLY | `packages/ai`, application | OpenSetter is primary AI-setter upstream; avoid importing two competing orchestrators. |
| `src/lib/ai/handoff.ts` | handoff heuristics | REFERENCE_ONLY | application/domain tests | Compare behavior when Phase 3 human handoff is implemented. |
| `src/lib/ai/knowledge.ts` | knowledge retrieval | REFERENCE_ONLY | `packages/ai` | Our factual/style split is canonical. |
| `src/lib/ai/providers/openai.ts` / `anthropic.ts` | provider wrappers | REFERENCE_ONLY | `packages/ai` | Useful API/error patterns; provider layer will be independently shaped. |
| `supabase/migrations/029_ai_reply.sql`, `030_ai_knowledge.sql` | AI persistence schema ideas | REFERENCE_ONLY | `packages/db` | Do not import Supabase/RLS schema into Prisma architecture. |
| Supabase auth/RLS plumbing | tenant/auth architecture | REJECT as core choice | none | We chose Auth.js + Prisma workspace scoping for MVP. |

### wacrm extraction principles

Use wacrm primarily as the WhatsApp **transport and protocol correctness reference**. Copy/adapt small pure/provider-specific modules and tests where valuable. Reimplement anything that mixes Supabase persistence, app authorization, CRM behavior or AI orchestration with transport.

## Implementation sequencing

1. Phase 1 scaffold/domain/db/queue/webhook ingestion uses OpenSetter only for stack/reliability patterns; no Meta adapter code required yet.
2. Phase 2 Instagram adapter selectively adapts current OpenSetter webhook/client patterns after current Meta API re-verification.
3. Phase 2/3 AI/delivery code ports reliability concepts from OpenSetter into channel-neutral use cases.
4. Phase 4 WhatsApp adapter selectively adapts wacrm pure Cloud API/signature/template/identity utilities while keeping all persistence/orchestration behind our own ports.
5. Every actual copied/adapted source file must be added to `THIRD_PARTY.md` with source path, anchor SHA and modification summary before merge.
