# Task Contract — P1 Business Profile Sync

**Executor:** Claude Code  
**Issue:** #53 `[P1-SYNC] Align open Phase 1 stack with Business Profile / Data Model v0.4`  
**Applies to:** PRs #49 -> #50 -> #51 -> #52, rooted at PR #26  
**Merge authority:** human/project owner; Claude must not merge its own PRs.

## Purpose

The existing open Phase 1 stack was implemented before the accepted Business Profile model was fully propagated. Correct the existing stack in dependency order. Do not start Phase 2 until this sync is complete.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/specs/DATA_MODEL.md` v0.4
6. `docs/specs/MVP_RELEASE_SCOPE.md`
7. `docs/specs/IMPLEMENTATION_ROADMAP_CRITICAL_PATH.md`
8. `docs/specs/TEAM_ROLES_UX.md`
9. `docs/specs/PRODUCT_ACCOUNT_LIFECYCLE.md`
10. `docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md`
11. GitHub Issue #53
12. the current PR body/diff for the branch being corrected

## Non-negotiable model

- Workspace = tenant/billing boundary.
- Business Profile = operational/customer-data boundary inside a Workspace.
- One BP initially owns at most one active Instagram account and one active WhatsApp account.
- Contact is canonical inside one BP by default.
- No automatic cross-BP customer graph.
- BP-owned records should preserve Workspace + BP consistency and, where useful, direct `workspace_id` + `business_profile_id` composite integrity.
- Role answers **what** a member can do; BP scope answers **where**.
- Conversation state/version anchors support stale draft/review/follow-up protection.

## Correction order

### A. PR #49 / P1-02 domain + channel contracts

Update the existing branch `feat/p1-02-domain-channel-contracts`.

Required:
- add `BusinessProfileId` and a minimal `BusinessProfile` contract;
- add BP status/readiness primitives needed by current MVP contracts without implementing future lifecycle machinery;
- add `businessProfileId` to `ChannelAccount`, `Contact`, `Conversation`, and other Phase-1 BP-owned contracts where ownership is material;
- rename the canonical identity concept to `ChannelIdentity`; a temporary deprecated type alias may exist only to reduce stack churn, but new code/tests/docs must use `ChannelIdentity` and semantics must be BP-scoped;
- `Conversation` includes `stateVersion` or equivalent monotonic optimistic-concurrency anchor;
- normalized channel events/commands carry enough stable identity for application code to validate resolved Workspace/BP/account scope without provider leakage;
- do not add Prisma, Meta, AI provider, queue, or UI code.

Tests:
- two BPs under one Workspace may contain independent contacts with the same external/provider user ID;
- BP identifiers are required/validated on relevant contracts;
- exhaustive union/schema tests remain green;
- ambiguous send remains quarantine/no blind retry.

Publish on PR #49 when complete:
`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-02`

### B. PR #50 / P1-03 persistence + auth

First merge the corrected PR #49 branch into `feat/p1-03-prisma-auth-workspaces`; do not rebase/force-push published history. Then correct only P1-03-owned persistence/auth work.

Required:
- add `business_profiles`;
- add member-to-BP access/scope representation suitable for OWNER/ADMIN/AGENT;
- BP-owned tables include/resolve `business_profile_id`, with direct `workspace_id` retained where it improves tenant integrity;
- composite FKs/uniques prevent cross-Workspace and cross-BP mixing;
- ChannelAccount belongs to a BP;
- Contact belongs to a BP;
- ChannelIdentity uniqueness is scoped to the relevant BP/channel-account semantics;
- Conversation/Message/AiDraft/delivery records preserve BP scope needed by downstream policy/execution;
- update indexes for BP-aware inbox/external identity lookups;
- preserve credential redaction, source-event dedupe, one-logical-send constraints and audit-preserving deletes.

Tests:
- Workspace A with BP1/BP2: BP1-scoped repository access cannot read/write BP2 when member scope disallows it;
- same external ID may exist safely in separate BPs;
- raw Prisma cross-BP composite-FK attempts fail;
- role/BP-scope revocation is immediately authoritative;
- migration applies to an empty DB and drift check is clean.

Publish on PR #50:
`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-03`

### C. PR #51 / P1-04 queue

Merge corrected #50 into `feat/p1-04-bullmq-delay-primitives`, then update queue-owned code only.

Required:
- policy-critical job payloads include `businessProfileId` where execution scope depends on it;
- deterministic job IDs include sufficient BP scope to avoid collisions;
- payload schemas reject missing/malformed BP scope;
- no duplicate tenant authority or business strategy in queue package;
- ambiguous outcomes remain reconciliation-only, never resend.

Tests:
- identical conversation/message/operation IDs in different BPs cannot collide at the queue identity layer;
- existing debounce/delay/retry/reconciliation tests remain green with real Redis.

Publish on PR #51:
`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-04`

### D. PR #52 / P1-05 ingestion

Merge corrected #51 into `feat/p1-05-webhook-ingestion`, then update ingestion-owned code only.

Required:
- resolve ChannelAccount -> Workspace + Business Profile before customer-data mutation;
- validate normalized events against the resolved Workspace/BP/account/channel;
- create/update Contact + ChannelIdentity + Conversation only inside resolved BP;
- transaction/outbox rows and debounce jobs preserve BP scope;
- foreign/cross-BP events fail safely;
- own echo vs human activity behavior remains unchanged except for BP scope;
- no LLM or artificial wait in webhook lifecycle.

Tests:
- one Workspace with two BPs receives independent inbound conversations;
- an event forged with another BP/account context is rejected and creates no customer data/outbox work;
- duplicate/concurrent duplicate behavior remains idempotent;
- outbox recovery preserves BP scope end to end.

Publish on PR #52:
`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-05`

## Verification on every corrected branch

Run the branch-appropriate complete verification, not only affected unit tests. Where DB/Redis suites exist, require them rather than silently skipping them. At minimum preserve:
- frozen install reproducibility;
- typecheck;
- ESLint + architecture boundaries;
- all unit/integration/adversarial tests;
- build;
- Prisma validate/generate/migrate/drift on DB branch and descendants;
- real Redis queue tests on queue branch and descendants.

Record exact commands and exact full HEAD SHA in the PR comment.

## Stacking rules

- Preserve current parent order: #26 -> #49 -> #50 -> #51 -> #52.
- No child merges before its parent.
- Propagate corrected parents with normal merge commits; do not force-push/rebase published branches merely to make the graph pretty.
- A parent change invalidates a child's previous verification. Re-run full child verification after propagation.
- Keep each PR diff narrow against its parent branch.

## Temporary Astra protocol

Astra review is temporarily asynchronous because reviewer quota is constrained. Claude must self-verify rigorously, publish `CLAUDE_READY_FOR_ASTRA` for each exact HEAD, and continue dependency-safe work without waiting for an Astra verdict. This does **not** authorize merging unreviewed PRs to `main`.

## Exit gate

P1 Business Profile sync is complete only when #49/#50/#51/#52 all have corrected exact HEADs, required tests are green, and #52 demonstrates Workspace + Business Profile scoped fake-channel ingestion end to end. Only then may Claude start the next task in `CLAUDE_EXECUTION_QUEUE.md`.