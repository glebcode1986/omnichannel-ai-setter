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

**P1-01 / Issue #2 is implemented** on `feat/p1-01-project-skeleton`; PR [#26](https://github.com/glebcode1986/omnichannel-ai-setter/pull/26) is open for review (not merged). The repository now has the pnpm 12 workspace (`apps/web`, `apps/worker`, all `packages/*` plus `packages/env`), Node 24 / TypeScript 6.0 strict / ESLint 10 / Vitest 5 tooling, `pnpm verify` as the pre-PR gate and `pnpm lint:boundaries` enforcing the dependency matrix in `docs/specs/REPOSITORY_LAYOUT.md`.

Architecture review of PR #26 (changes requested, then applied; awaiting re-review): `application` is pure and depends only on `domain`/`channel-core`; it owns the provider-neutral AI ports (`ReplyModel`, `EmbeddingProvider`) and the model-output boundary schema, `packages/ai` implements them (`ai -> application` allowed), `domain` holds pure semantic types — ADR-010, `AI_ORCHESTRATION.md`, `RETRIEVAL.md`, P2-03/P2-04 contracts and `REPOSITORY_LAYOUT.md` updated. Accepted: `db`/`queue -> application`; forbidden: `db -> ai`, `application -> observability`; browser automation dev/test only. Also: TypeScript pinned to 6.0 (typescript-eslint does not support 7); Next.js `agentRules: false`. Follow-ups outside #2: add a `pnpm verify` GitHub Actions gate early (reviewer request; implementing token lacks `workflow` scope) and choose a formatter.

The next Claude task is prepared:
- **P1-02 / Issue #3 — domain model and channel contracts**
- contract: `docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md`
- branch: `feat/p1-02-domain-channel-contracts`
- hard start condition: Issue #2 reviewed/accepted/merged into `main`.

Do not start actual Phase 2 implementation until Phase 1 exit criteria are met unless architecture is explicitly amended.

## Execution order

### Phase 1 — current coding path
#2 -> #3 -> #4/#5 -> #6 with #7 independent review.
Use `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`.

### Phase 2 — Instagram/shared AI
#8–#16 Claude; #17 independent review. Contracts under `docs/tasks/P2-*`.

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
8. P2-02 (#9): Instagram Login onboarding and token lifecycle — connect/callback/disconnect routes, encrypted credential storage, single-use OAuth state and refresh handling. The adapter is still not registered in `apps/web`; that wiring belongs to the vertical slice (#16), which can now resolve real credentials.

## Immediate next actions

1. P1-01/#2 PR #26 is open; do not auto-merge.
2. Review #2 against its contract and run R1/Codex-Astra review.
3. After #2 merge, launch P1-02/#3 from fresh `main`.
4. Continue architecture/product design in parallel without letting future prepared phases bypass dependency gates.
