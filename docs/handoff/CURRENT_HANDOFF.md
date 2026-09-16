# Current Handoff

**Date:** 2026-09-16  
**Phase:** Phase 1 ready to implement; Phase 2 Instagram/shared-AI fully specified; Phase 4 WhatsApp fully architected/task-contracted  
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
- Complete Phase 4 backlog #18–#25 and task contracts prepared for transport, onboarding, templates/window, media/voice, read/typing presence, coexistence/takeover, E2E slice and independent review.

## Open product decision — do not let an agent decide

**ADR-016 remains Proposed.** WhatsApp outside-window behavior has two designed options:

1. `SERVICE_WINDOW_ONLY`: after the free-form customer-service window closes, conversational automation waits for the customer to message again.
2. `TEMPLATE_ASSISTED`: the system may select/propose a currently eligible approved template outside the window. Product owner still must decide whether these sends initially require human approval or may auto-send under explicit policy, and which use cases/categories are eligible.

Do not silently enable unattended outside-window template sends until ADR-016 is explicitly accepted by the product owner.

## Execution order — current coding entry point

### Phase 1
1. #2 — `docs/tasks/P1-01_CLAUDE_TASK_CONTRACT.md`
2. #3 — `P1-02_CLAUDE_TASK_CONTRACT.md`
3. #4 — `P1-03_CLAUDE_TASK_CONTRACT.md`
4. #5 — `P1-04_CLAUDE_TASK_CONTRACT.md`
5. #6 — `P1-05_CLAUDE_TASK_CONTRACT.md`
6. #7 — `R1_CODEX_ASTRA_REVIEW_CONTRACT.md`

Claude still starts with #2. Phase 2/4 are prepared, not permission to skip Phase 1 dependencies.

### Phase 2 — after Phase 1 exit
#8–#16 Claude contracts under `docs/tasks/P2-*`; #17 R2 review.

### Phase 4 — WhatsApp, after required shared core is stable
- #18 P4-01 WhatsApp transport — `P4-01_CLAUDE_TASK_CONTRACT.md`
- #19 P4-02 Embedded Signup — `P4-02_CLAUDE_TASK_CONTRACT.md`
- #20 P4-03 templates/outside-window policy — `P4-03_CLAUDE_TASK_CONTRACT.md` (auto-send portion blocked on ADR-016)
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

Read `PROJECT_CONTEXT.md`, this file, `docs/tasks/README.md`, relevant ADR/spec/research file and the exact issue/task contract. Do not reconstruct architecture from chat history.

## Immediate next action

Run `docs/tasks/P1-01_CLAUDE_TASK_CONTRACT.md` in Claude Code for Issue #2. Claude creates `feat/p1-01-project-skeleton`, implements only #2, runs required checks and opens a PR without merging. Then ChatGPT reviews architecture and Codex/Astra performs the #7 independent review.
