# Current Handoff

**Date:** 2026-09-16  
**Phase:** Phase 1 implementation in progress; Phase 2 Instagram/shared-AI fully specified; Phase 4 WhatsApp fully architected/task-contracted  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Completed architecture/documentation

- Durable project memory, agent rules and task-contract workflow.
- OpenSetter + wacrm upstream extraction/reuse strategy with MIT notices.
- Frozen stack: Next.js/TypeScript, pnpm, Prisma/PostgreSQL, BullMQ/Redis, Auth.js, Zod, Vitest.
- Channel-neutral core, webhook ingestion boundary, durable debounce/delay, deterministic policy, final pre-send revalidation, atomic delivery claim, ambiguity quarantine and human takeover design.
- Complete Phase 1 issues/contracts #2–#7.
- Complete Phase 2 Instagram/shared-AI specs/ADRs/issues/contracts #8–#17.
- Instagram owner choice accepted: `STANDARD_ONLY | HUMAN_ASSISTED_EXTENDED` (ADR-014).
- Current official WhatsApp Cloud API/Embedded Signup verification recorded in `docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`.
- WhatsApp adapter spec, Embedded Signup spec and Phase 4 implementation plan committed.
- ADR-015 accepted: official Embedded Signup for SaaS WhatsApp onboarding.
- Complete Phase 4 backlog #18–#25 and task contracts prepared.
- ADR-016 accepted: all three WhatsApp after-window modes ship — `SERVICE_WINDOW_ONLY`, `TEMPLATE_REVIEW`, `TEMPLATE_AUTOPILOT`.
- Stable human-supervisor launch page created: `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`.

## WhatsApp after-window product decision — Accepted

1. `SERVICE_WINDOW_ONLY`: after the free-form customer-service window closes, no outside-window customer send until the customer reopens the service window.
2. `TEMPLATE_REVIEW`: system may select/prepare a currently eligible approved template, but an authorized human approves the send.
3. `TEMPLATE_AUTOPILOT`: deterministic policy may auto-send only current approved templates/use-cases explicitly allowlisted for unattended automation.

No stored choice means `SERVICE_WINDOW_ONLY` until configured. Empty autopilot allowlist means no unattended template send. Current consent/template/account-health/STOP rules always override automation. See ADR-016 and Issue #20.

## Execution state right now

Claude is reported by the product owner to be working on **P1-01 / Issue #2**. At the time of this handoff update, no open PR for that work was visible in the repository.

The next Claude task is already prepared:

- **P1-02 / Issue #3 — domain model and channel contracts**
- contract: `docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md`
- branch: `feat/p1-02-domain-channel-contracts`
- hard start condition: Issue #2 must first be reviewed/accepted/merged into `main`.

Do not start actual Phase 2 Instagram+AI implementation until Phase 1 exit criteria are met unless the architecture plan is explicitly amended.

## Execution order

### Phase 1
1. #2 — `docs/tasks/P1-01_CLAUDE_TASK_CONTRACT.md` — currently running.
2. #3 — `P1-02_CLAUDE_TASK_CONTRACT.md` — ready after #2 merge.
3. #4 — `P1-03_CLAUDE_TASK_CONTRACT.md`.
4. #5 — `P1-04_CLAUDE_TASK_CONTRACT.md`.
5. #6 — `P1-05_CLAUDE_TASK_CONTRACT.md`.
6. #7 — `R1_CODEX_ASTRA_REVIEW_CONTRACT.md`.

Use `docs/tasks/CLAUDE_EXECUTION_QUEUE.md` as the stable supervisor page.

### Phase 2 — after Phase 1 exit
#8–#16 Claude contracts under `docs/tasks/P2-*`; #17 R2 review.

### Phase 4 — WhatsApp, after required shared core is stable
- #18 P4-01 WhatsApp transport — `P4-01_CLAUDE_TASK_CONTRACT.md`
- #19 P4-02 Embedded Signup — `P4-02_CLAUDE_TASK_CONTRACT.md`
- #20 P4-03 templates/outside-window policy — `P4-03_CLAUDE_TASK_CONTRACT.md`; all three ADR-016 modes are authorized for implementation
- #21 P4-04 media/voice — `P4-04_CLAUDE_TASK_CONTRACT.md`
- #22 P4-05 read/typing presence — `P4-05_CLAUDE_TASK_CONTRACT.md`
- #23 P4-06 coexistence/native-human takeover — `P4-06_CLAUDE_TASK_CONTRACT.md`
- #24 P4-07 WhatsApp E2E slice — `P4-07_CLAUDE_TASK_CONTRACT.md`
- #25 R4 independent review — `R4_CODEX_ASTRA_REVIEW_CONTRACT.md`

## Platform reminders

- Production WhatsApp transport is official Cloud API only; no Baileys/QR/session automation.
- WhatsApp free-form window and template eligibility are provider facts consumed by deterministic policy, not prompt instructions.
- Read/typing is best-effort presence near send; durable delay remains BullMQ-backed.
- Voice note transcript is untrusted user content with provenance; transcription failure never permits guessed content.
- Coexistence is capability-gated and must be re-verified against current Meta onboarding/events during implementation.
- Instagram Human Agent and WhatsApp platform rules must be re-verified at implementation/App Review time.

## Coding rule for every new session

Read `PROJECT_CONTEXT.md`, this file, `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`, `docs/tasks/README.md`, relevant ADR/spec/research file and the exact issue/task contract. Do not reconstruct architecture from chat history.

## Immediate next actions

1. Let Claude finish P1-01/#2 and open a PR; do not merge automatically.
2. Review #2 against its task contract and run the R1/Codex-Astra review track.
3. After #2 is accepted/merged, launch P1-02/#3 from `docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md` on fresh `main`.
