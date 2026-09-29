# Current Handoff

**Date:** 2026-09-16  
**Phase:** Phase 1 implementation in progress; Phase 2 Instagram/shared-AI fully specified; Phase 4 WhatsApp fully architected; Phase 5 SaaS UX fully specified/task-contracted  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Completed architecture/documentation

- Durable project memory, agent rules and task-contract workflow.
- OpenSetter + wacrm upstream extraction/reuse strategy with MIT notices.
- Frozen stack: Next.js/TypeScript, pnpm, Prisma/PostgreSQL, BullMQ/Redis, Auth.js, Zod, Vitest.
- Channel-neutral core, webhook ingestion boundary, durable debounce/delay, deterministic policy, final pre-send revalidation, atomic delivery claim, ambiguity quarantine and human takeover design.
- Complete Phase 1 issues/contracts #2–#7.
- Complete Phase 2 Instagram/shared-AI specs/ADRs/issues/contracts #8–#17.
- Instagram owner choice accepted: `STANDARD_ONLY | HUMAN_ASSISTED_EXTENDED` (ADR-014).
- Complete Phase 4 WhatsApp architecture/backlog/contracts #18–#25; ADR-015 Embedded Signup and ADR-016 three-mode outside-window policy accepted.
- Stable human-supervisor launch page: `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`.
- Complete Phase 5 SaaS UX specs/issues/contracts #27–#36.

## Product UX direction

Primary daily surface is the **Unified Inbox**, not Analytics. Navigation: Inbox, Review, Leads, Knowledge, Style, Analytics, Settings.

Desktop Inbox is three-pane: conversation list / active thread / contact+lead+AI context. Mobile is stacked with details as drawer/sheet.

`Review` is first-class for DRAFT, low-confidence, missing fact, unsupported/sensitive cases, Instagram human-assisted sends, WhatsApp template review, transcription/media failures and ambiguous-send resolution.

Knowledge and Style are intentionally separate:
- Knowledge = factual authority, versioned/provenanced;
- Style = phrasing/tone, verified human examples only, never factual authority.

Phase 5 can begin incrementally after the relevant backend contracts stabilize; it does not need to wait for all WhatsApp work. One product shell conditionally renders channel capabilities.

## WhatsApp after-window product decision — Accepted

1. `SERVICE_WINDOW_ONLY`
2. `TEMPLATE_REVIEW`
3. `TEMPLATE_AUTOPILOT` with explicit allowlist

No stored choice means `SERVICE_WINDOW_ONLY`. Empty autopilot allowlist means no unattended template send. Current consent/template/account-health/STOP rules always override automation.

## Execution state right now

**PR [#69](https://github.com/glebcode1986/omnichannel-ai-setter/pull/69) / P2-07 (Issue #14) is the
earliest unresolved review gate**, on branch `feat/p2-07-human-handoff`. Everything before it in the chain
has an independent PASS at its published head, including **#68 / P2-06, accepted at
`fb35665209b90c82bc10f3068450111e75f83299` and already propagated downstream**. **#70, #71 and #72 stay
unchanged until #69 is accepted**, and nothing is merged to `main`.

Phase 1 and Phase 2 are one stacked chain of unmerged PRs, each branch based on its parent:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`

The Phase 1 tasks named in the launch plan are all implemented and sit in that chain; the per-PR detail is
under "Phase 1 implementation stack" below. What the architecture review of PR #26 settled is still binding
and is recorded there.

## Execution order

The dependency order each phase was planned in. Phases 1 and 2 are implemented; see "Execution state right
now" for the live gate, and `docs/tasks/CLAUDE_EXECUTION_QUEUE.md` for what to work on.

### Phase 1 — implemented
#2 -> #3 -> #4/#5 -> #6 with #7 independent review, as PRs #26, #49, #50, #51, #52.

### Phase 2 — implemented
#8–#16 Claude; #17 independent review, as PRs #63–#71. Contracts under `docs/tasks/P2-*`.

### Phase 4 — WhatsApp
#18–#24 Claude; #25 independent review. Contracts under `docs/tasks/P4-*`.

### Phase 5 — SaaS UX
- #27 P5-01 app shell + resumable onboarding — `P5-01_CLAUDE_TASK_CONTRACT.md`
- #28 P5-02 unified Inbox — `P5-02_CLAUDE_TASK_CONTRACT.md`
- #29 P5-03 conversation operations + Review Queue — `P5-03_CLAUDE_TASK_CONTRACT.md`
- #30 P5-04 AI Settings + no-send simulation — `P5-04_CLAUDE_TASK_CONTRACT.md`
- #31 P5-05 Knowledge Library — `P5-05_CLAUDE_TASK_CONTRACT.md`
- #32 P5-06 Style Training — `P5-06_CLAUDE_TASK_CONTRACT.md`
- #33 P5-07 Leads pipeline — `P5-07_CLAUDE_TASK_CONTRACT.md`
- #34 P5-08 Analytics + Audit — `P5-08_CLAUDE_TASK_CONTRACT.md`
- #35 P5-09 UX E2E/accessibility/responsive — `P5-09_CLAUDE_TASK_CONTRACT.md`
- #36 R5 independent review — `R5_CODEX_ASTRA_REVIEW_CONTRACT.md`

See `docs/specs/PRODUCT_UX.md`, `ONBOARDING_UX.md`, `AI_CONFIGURATION_UX.md`, `KNOWLEDGE_STYLE_UX.md`, `LEADS_ANALYTICS_UX.md`, and `PHASE5_IMPLEMENTATION_PLAN.md`.

## Coding rule for every new session

Read `PROJECT_CONTEXT.md`, this file, `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`, `docs/tasks/README.md`, relevant ADR/spec/research file and exact issue/task contract. Do not reconstruct architecture from chat history.

## Phase 1 implementation stack (temporary review-lag mode, Issue #7)

Implemented as stacked PRs awaiting independent review, in dependency order:

1. #26 (#2): workspace scaffold.
2. #49 (#3): domain + channel contracts.
3. #50 (#4): Prisma/Auth.js/workspace isolation.
4. #51 (#5): BullMQ delay primitives.
5. #52 (#6): channel-neutral webhook ingestion with a transactional outbox, scoped to the Business Profile resolved from the channel account (see `docs/specs/ARCHITECTURE.md` implementation notes).

6. #62 (#37): the GitHub Actions `pnpm verify` gate, staged at `docs/ci/verify.yml` because the implementation credential cannot write `.github/workflows/`.

Nothing is merged yet.

**Phase 2 start condition (MASTER Issue #61).** The owner's Stage B directive starts Phase 2 once the Issue #53 Business Profile sync is complete, which it now is (#49 `34a71d0`, #50 `1e214bf`, #51 `53a254f`, #52 `405bfd0`). Phase 2 work is therefore stacked on top of #52 and stays unmerged, under the same review-lag mode: Phase 1 acceptance is still required before anything merges.

7. P2-01 (#8): `packages/channel-instagram` — the Instagram transport adapter and its fixture suite. It is not registered in `apps/web` yet: per-account credentials arrive with P2-02, so webhook routes still answer 404.
9. P2-03 (#10): the provider-neutral AI draft engine — `ReplyModel` port and Zod boundary in `packages/application`, an Anthropic implementation in `packages/ai`, idempotent draft persistence, and the worker's `generateAiDraft` handler wired. Retrieval (#11) and the policy engine (#12) are not: drafts are produced and stored, never sent.
10. P2-04 (#11): factual and style retrieval — application-owned `KnowledgeRetriever`/`StyleRetriever`/`EmbeddingProvider` ports with deterministic RRF fusion, PostgreSQL lexical + pgvector semantic retrieval in `packages/db`, a Voyage embedding provider in `packages/ai`, and retrieval wired into the worker's draft handler. Nothing writes knowledge or style yet: ingestion and the knowledge/style UX are Phase 5, so in a fresh deployment both corpora are empty and every fact-dependent answer becomes `MISSING_FACT`.

8. P2-02 (#9): Instagram Login onboarding and token lifecycle — connect/callback/disconnect routes, encrypted credential storage, single-use OAuth state and refresh handling. The adapter is still not registered in `apps/web`; that wiring belongs to the vertical slice (#16), which can now resolve real credentials.

11. P2-05 (#12), PR #67: the deterministic policy engine. Human Agent eligibility is current-only — an `ELIGIBLE` fact whose `expiresAt` has passed (including exactly at `now`) never opens the after-window path.
12. P2-06 (#13), PR #68: the delivery coordinator and final pre-send revalidation.
13. P2-07 (#14), PR #69: human handoff and the review state machine.
14. P2-08 (#15), PR #70: the AI evaluation harness and golden conversations.
15. P2-09 (#16), PR #71: the Instagram vertical slice.
16. P3-03 (#56), PR #72: reliability controls, health, kill switch and reconciliation. ADR-017 is **Rejected**: an unmatched echo stays native human activity, and an unresolved ambiguous send is quarantined and put in front of a person rather than retried blind.

**A reviewed reply carries the authority the person granted (#14 / PR #69).** Approving or editing a draft
persists *who* approved it, *when*, and *which send* they authorized on the delivery row, and the
coordinator reads it from there with everything else it judges. The worker can no longer construct an
authority, which is how a human's approval was silently downgraded to automation — the reply then met the
gates that exist to ask for a human, and the Human Agent transport path was unreachable. Scheduling the
send and taking the conversation are now one write, so there is no moment in which an approved delivery
exists with nobody owning the conversation. The policy engine judges "may this be sent on this authority":
an approval answers the gates that ask for a human and none of those about what is possible or permitted,
and a takeover by anyone else still fails closed. See `docs/specs/HUMAN_HANDOFF.md`.

**Delivery send authority is bound to the claim (#13 / PR #68).** The final pre-send revalidation is no
longer separated from the claim by an unguarded gap: the claim's own statement re-asserts every fact the
revalidation rested on — reply cycle, conversation state and version, draft, account health and the
automation-policy rows the mode and limits came from. A claim whose facts have moved is refused as
state-changed, re-read and re-judged, and the change is normally what then cancels or holds the delivery.
Nothing is sent and no attempt is counted. See `docs/specs/DELIVERY_COORDINATOR.md`.

## Immediate next actions

1. **PR #69 / P2-07 is the gate.** Address independent-review findings on `feat/p2-07-human-handoff`, verify
   at the exact head, and publish readiness evidence. Do not merge it.
2. **Do not touch #70, #71 or #72** until #69 has an independent PASS. After it, propagate only the accepted
   correction with ordinary merges, verifying each branch before pushing.
3. No rebases, no force-pushes, no merges to `main`, and do not start Stage D.
4. Continue architecture/product design in parallel without letting future prepared phases bypass dependency
   gates.

Historical note: the original launch sequence (review #2, then launch #3 from a merged `main`) was
superseded by the owner's stacked review-lag mode. Those tasks are implemented and are in the chain above.
