# Task Contract — P1-03 Claude

**Executor:** Claude Code  
**Issue:** #4 `[P1-03] Implement Prisma/Auth.js with Workspace + Business Profile isolation`  
**Branch:** `feat/p1-03-prisma-auth-workspaces`  
**Depends on:** corrected/accepted-enough #2 and #3  
**Merge authority:** human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-005-prisma-bullmq-core-stack.md`
6. `docs/adr/ADR-009-authjs-workspaces.md`
7. `docs/specs/DATA_MODEL.md` v0.4
8. `docs/specs/TEAM_ROLES_UX.md`
9. `docs/specs/REPOSITORY_LAYOUT.md`
10. `docs/tasks/P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md` when correcting the existing stack
11. GitHub Issue #4

## Objective

Implement PostgreSQL/Prisma persistence and Auth.js tenancy with Workspace as tenant/billing boundary and Business Profile as the operational/customer-data boundary. ORM concepts must not leak into pure domain/channel packages.

## Owned scope

- `packages/db`
- minimal Auth.js persistence/session wiring in `apps/web`
- migration/seed/test helpers required for this issue

## Required persistence model

Implement the current Phase-1/MVP subset of Data Model v0.4:

- Auth.js user/account/session/verification entities required by the selected adapter
- Workspace
- WorkspaceMember with roles `OWNER | ADMIN | AGENT`
- BusinessProfile
- MemberBusinessProfileAccess or an equivalent explicit BP-scope representation
- ChannelAccount scoped to Business Profile
- Contact scoped to Business Profile
- ChannelIdentity scoped to Contact/BP/channel account
- Conversation scoped to Workspace + BP with state/version support
- Message scoped consistently to Workspace + BP + conversation/account
- AiDraft
- DeliveryJobRecord
- KnowledgeDocument / KnowledgeChunk at minimal Phase-1 scope
- StyleExample
- AutomationPolicy
- source-event/idempotency table(s)
- encrypted credential/reference abstraction placeholder

Do not implement every future conceptual model just because it appears in `DATA_MODEL.md`.

## Tenancy and authorization requirements

- every BP-owned aggregate is Workspace + Business Profile scoped;
- prefer direct `workspace_id` + `business_profile_id` on BP-owned tables where it materially strengthens composite FK integrity and common queries;
- a user may belong to multiple Workspaces;
- role answers what a member may do; BP scope answers where;
- active Workspace and BP authorization are explicit; never guess a default tenant/BP for protected data access;
- representative cross-Workspace **and cross-BP** reads/writes are rejected through repository/application access paths;
- unauthorized BP records are non-discoverable;
- member/BP-scope revocation is authoritative immediately;
- UI hiding is never an authorization control.

## Constraints/indexes

At minimum:

- source-event uniqueness per authoritative channel account;
- stable/unique platform message identity where the provider guarantees it;
- external/channel identity lookup scoped so separate BPs do not collide;
- BP-aware inbox/recency indexes;
- scheduled-delivery indexes;
- state/constraints preventing one logical operation/draft from becoming multiple completed sends;
- composite FKs preventing cross-Workspace and cross-BP reference mixing;
- audit-preserving FK/delete behavior rather than destructive cascades for conversation/history data.

Initial packaging invariant: at most one active Instagram and one active WhatsApp channel account per Business Profile unless a future accepted product change says otherwise.

## Credentials and secrets

Do not create plaintext long-lived credential fields. Use encrypted value/reference abstraction suitable for later Meta onboarding. Test/seed data must be fake.

## Explicitly forbidden

Do not implement:

- Redis/BullMQ behavior (#5)
- webhook application orchestration (#6)
- real Instagram/WhatsApp APIs
- AI retrieval/policy/delivery logic
- full future memory/booking/billing models beyond small compatibility fields genuinely required by this task

Do not import Prisma into `packages/domain`, `packages/channel-core`, or pure `packages/application` contracts.

## Required verification

- Prisma schema validate/generate succeeds;
- migration applies to an empty PostgreSQL DB;
- drift check is clean;
- test helpers create at least two Workspaces and multiple BPs;
- repository tests prove cross-Workspace and cross-BP reads/writes cannot succeed;
- raw Prisma bypass tests demonstrate composite FK protection;
- BP role/scope authorization and revocation are covered;
- required indexes/uniques/check constraints are exercised where practical;
- root verification passes with DB tests required rather than silently skipped.

## Acceptance checklist

- [ ] BusinessProfile persistence exists
- [ ] WorkspaceMember + BP scope exists
- [ ] ChannelAccount/Contact/ChannelIdentity/Conversation are BP-aware
- [ ] direct Workspace + BP integrity is enforced where specified
- [ ] same external identity can exist independently in separate BPs when provider/account semantics allow it
- [ ] cross-BP repository and raw-DB attacks are tested
- [ ] Auth.js persistence is minimally safe
- [ ] no plaintext production credential design
- [ ] no queue/Meta/AI feature creep
- [ ] deviations from Data Model v0.4 are documented before merge

## Existing open stack

PR #50 was originally implemented against an earlier Workspace-only operational shape. Issue #53 and `P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md` govern the in-place correction. Propagate corrected PR #49 with a normal merge, then update/verify PR #50. Do not replace the branch or force-push published history merely to simplify the stack.

## PR requirements

Keep/open a focused PR referencing Issue #4. Include migration summary, exact verification commands, Workspace/BP isolation evidence, indexes/constraints and any genuine model deviation. Publish:

`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-03`

Do not merge the PR yourself.