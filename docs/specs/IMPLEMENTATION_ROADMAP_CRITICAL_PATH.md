# Implementation Roadmap / Critical Path

**Status:** Canonical sequencing contract for implementation toward Commercial Beta.

## Purpose

Turn the accepted product architecture and `MVP_RELEASE_SCOPE.md` into a practical build order. The project should preserve broad future extension points while implementing the smallest safe path to a real customer.

Core rule: **design broadly, implement narrowly, integrate vertically as early as possible.**

This roadmap does not require every conceptual entity in `DATA_MODEL.md` to be fully implemented before launch. It defines which foundations are blockers, which streams may run in parallel, and the exact milestones at which internal users, design partners and paying customers may be introduced.

## Current development position

The repository scaffold/tooling is PR #26 / P1-01. Phase 1 then establishes channel-neutral domain contracts, persistence/auth, durable queues and channel-neutral webhook ingestion before the real provider vertical slices.

Product architecture documents on `docs/phase6-commercial-billing` are the forward contract. If an older issue/task contract conflicts with a newer accepted specification, update the task contract before implementing the conflicting portion; do not silently implement the stale model.

## Critical path overview

```text
Foundation/tooling
    |
    v
Domain + channel contracts
    |----------------------|
    v                      v
DB/auth/tenant scope   Durable queue primitives
    |                      |
    +----------+-----------+
               v
      Channel-neutral ingestion
               |
               v
      Shared AI/application core
   retrieval -> policy -> delivery -> handoff
               |
       +-------+--------+
       v                v
 Instagram vertical   Product shell / Inbox
       |                |
       +-------+--------+
               v
       Internal Alpha
               |
       Design Partner Alpha
               |
     WhatsApp vertical slice
               |
   Review + Leads + Goals + Memory
               |
   Billing + entitlements + roles
               |
 Reliability/Admin/Security hardening
               |
        Commercial Beta gate
               |
               v
        First normal paid users

Post-MVP: booking, public API/webhooks, CRM/data integrations,
advanced identity merge, expanded analytics and operations tooling.
```

## Wave 0 — Repository foundation

### Deliverables
- runnable web and worker applications;
- strict TypeScript/workspace boundaries;
- test/lint/build baseline;
- environment validation and structured observability;
- architecture boundary checker;
- `pnpm verify` as the local release command and, as soon as permissions allow, a CI gate on the exact PR/release SHA.

### Exit gate
A clean checkout installs, verifies and starts both runtimes without customer/provider credentials.

### Product value
None yet. This is foundational and must not expand indefinitely.

## Wave 1 — Channel-neutral durable core

### 1A — Domain + channel contracts
Implement only the domain primitives required by the near-term runtime and MVP contracts, including Business Profile scoping, channel-neutral identity/conversation/message state, AI draft/action anchors, lead-stage primitives, automation/handoff state and the common `ChannelAdapter` boundary.

Do **not** implement all future booking/integration/admin entities merely because they exist conceptually in `DATA_MODEL.md`.

### 1B — Persistence/auth/tenant isolation
After the core contracts are stable enough, implement:
- Workspace, Business Profile, membership/BP scope;
- ChannelAccount;
- Contact + channel identity/contact-point foundation;
- Conversation/Message;
- durable provider event identity;
- AI draft/delivery state needed by the first vertical slice;
- tenant-scoped repositories/services and server-side authorization foundations.

Prefer schema choices that can add later MVP entities without destructive redesign, but avoid speculative provider tables.

### 1C — Queue/durable work primitives
In parallel with 1B after contract stability:
- debounce job;
- AI trigger job;
- delayed delivery job;
- reconciliation placeholder;
- deterministic job IDs and durable application-owned intent/state.

Redis/BullMQ is execution infrastructure, never the only durable source of pending intent.

### 1D — Channel-neutral webhook ingestion
After 1B + 1C:

`verify -> normalize -> idempotent persist -> conversation update -> enqueue -> fast ACK`

Test first with a fake adapter. No LLM or real Meta credentials required for the Phase 1 exit.

### Phase 1 exit gate
A duplicate fake-channel event can traverse the complete ingestion path without duplicating the logical message/action; workspace/BP isolation is tested; durable work can be scheduled safely.

## Wave 2 — Shared AI runtime + Instagram vertical slice

The fastest route to product reality is one complete provider path, not simultaneous partial Instagram and WhatsApp implementations.

### Parallel lane A — Instagram transport/onboarding
- official Instagram transport adapter;
- webhook fixtures/signature path;
- current official account onboarding/token lifecycle;
- normalized inbound, outbound echo/status and window/capability handling.

### Parallel lane B — shared AI/application core
Build in this order:
1. provider-neutral AI generation port and validated structured output;
2. Knowledge retrieval with provenance;
3. Style retrieval/profile application;
4. deterministic policy engine;
5. delivery coordinator with final revalidation;
6. human takeover/resume state machine;
7. golden/evaluation conversations.

### Vertical-slice gate
A real or sandbox Instagram customer message can:

`inbound -> durable conversation -> debounce -> retrieval -> AI draft -> DRAFT/Review/AUTOPILOT policy -> durable delay -> final revalidation -> official send -> status/echo reconciliation`

with duplicate-event, newer-message, human-takeover and ambiguous-send tests.

## Wave 3 — Minimum product shell + Internal Alpha

Product UI work begins **before** all backend phases are complete.

### Can start early
Once auth/workspace/BP contracts exist:
- authenticated app shell;
- Business Profile switcher/scope;
- resumable onboarding skeleton;
- localization foundation EN/RU.

Once conversation APIs exist:
- Unified Inbox list/thread;
- effective AI mode;
- composer;
- pending delayed-send state;
- takeover/resume controls;
- minimal contact context.

Once Review/draft APIs exist:
- Review Queue;
- Send / Edit & Send / Dismiss / Take over / Resume AI;
- stale-action messaging.

### Internal Alpha definition
The team can connect a test Instagram account, configure minimal Knowledge/Style, run real conversations through DRAFT, manually take over/resume, and observe delivery state without direct database intervention.

AUTOPILOT may be used only on internal/test accounts until its race/reconciliation tests pass.

## Wave 4 — Design Partner Alpha

A small design partner may enter **before the full commercial MVP**, provided the scope is explicit and support is high-touch.

### Minimum Design Partner Alpha
- Instagram vertical slice stable;
- Inbox usable;
- DRAFT stable;
- Review + takeover stable;
- Knowledge/Style basic flows;
- tenant/BP isolation tests pass;
- kill switch available for automated outbound;
- operational logs/correlation IDs sufficient for support.

### Optional limited AUTOPILOT
Only after:
- browser-closed server-side execution test passes;
- stale-draft protection passes;
- human-vs-AI race tests pass;
- duplicate/ambiguous-send tests pass;
- emergency outbound stop is verified.

A design partner may be free or manually contracted during this stage. This is not yet the normal self-serve paid launch.

## Wave 5 — WhatsApp + complete customer operations core

After shared AI/delivery/handoff contracts are proven by Instagram, implement WhatsApp as the second adapter rather than duplicating core logic.

### WhatsApp critical path
- Cloud API transport + verified webhook;
- Embedded Signup/provider asset lifecycle;
- service-window/template policy;
- status reconciliation;
- voice/media processing needed by MVP;
- native/coexistence takeover only where current provider capability is verified.

### Product operations built in parallel
- first-class Review reason taxonomy;
- Contact vs Lead separation;
- qualification fields + basic pipeline;
- primary goal / next action;
- conservative scheduled follow-up + human task;
- basic verified customer facts/preferences with provenance;
- common media receive/display + voice transcription allowance behavior;
- search within authorized BP scope.

### Exit gate
Instagram and WhatsApp both reach the same application/AI/policy/delivery/handoff core and appear in one Inbox. There is no duplicated channel-specific AI business logic.

## Wave 6 — Commercialization + team permissions

These streams may begin earlier once the DB/application boundaries are stable, but must be complete before normal paid launch.

### Billing/entitlements
- versioned Starter/Growth/Scale catalog;
- 14-day trial start on first successful working BP/channel connection;
- normalized subscription lifecycle;
- BP/seat capacity enforcement;
- voice transcription allowance/top-ups;
- one production billing provider;
- verified/idempotent provider callbacks;
- entitlement revalidation before delayed paid automation.

### Team
- OWNER / ADMIN / AGENT;
- BP scope as a separate authorization dimension;
- immediate access revocation;
- member history/audit preservation.

### Required rule
Billing problems may block paid automation but must not cause customer inbound messages to disappear.

## Wave 7 — Reliability, privacy, Admin Operations and launch hardening

Implement the minimum commercial safety/operations set:

### Reliability
- dependency health;
- queue backlog/oldest-job monitoring;
- channel/AI/provider degraded states;
- reconciliation queues;
- recovery revalidation rather than blind backlog replay.

### Admin Operations
- Workspace lookup;
- subscription/entitlement inspection;
- channel diagnostics;
- ambiguous-operation reconciliation;
- scoped/time-limited support access;
- global/Workspace/BP/channel outbound kill switches;
- internal platform audit.

### Privacy/security
- encrypted secret references;
- no secrets in prompts/logs/audit;
- basic export/deletion workflow including derived data under platform control;
- audited sensitive support access;
- rate limiting/signature validation/session protections appropriate to exposed surfaces.

## Commercial Beta release gate

A candidate release is identified by an exact immutable commit SHA. The release is blocked unless all safety-critical gates for included features pass.

Required evidence includes:
- root verification/CI pass on exact SHA;
- Instagram and WhatsApp end-to-end tests;
- duplicate/reordered webhook tests;
- no-blind-retry ambiguity tests;
- human-vs-AI race/takeover tests;
- stale draft/review/follow-up tests;
- AUTOPILOT with dashboard/browser closed;
- Workspace/BP isolation and role/scope authorization tests;
- billing lifecycle/entitlement tests;
- voice exhaustion does not stop text AI;
- partial dependency failure/recovery tests;
- kill-switch tests;
- migration/rollback plan;
- known limitations recorded.

Rollout order:

`internal -> design partners -> limited AUTOPILOT -> Commercial Beta -> broader availability`

## First normal paid customer milestone

The product is commercially credible when a customer can, without engineering intervention:

1. register/create a Workspace and Business Profile;
2. connect Instagram and/or WhatsApp through supported onboarding;
3. add trusted Knowledge and configure Style;
4. test behavior;
5. use one Unified Inbox;
6. run DRAFT or explicitly enable AUTOPILOT;
7. take over/resume any conversation;
8. handle exceptional cases in Review;
9. qualify Leads and maintain a simple next step/follow-up;
10. see subscription/usage/health state;
11. continue receiving customer inbound during non-destructive billing/dependency degradation;
12. rely on the system while the dashboard is closed.

## Parallelization rules

Safe parallel streams after Phase 1 contracts are stable:
- Instagram adapter/onboarding and shared AI generation;
- UI shell and backend AI/channel work;
- DB-independent UX fixtures and real backend APIs later;
- billing domain/entitlement model and channel runtime work;
- WhatsApp transport/onboarding and Review/Leads UI once shared contracts exist;
- reliability/Admin UI after operational state endpoints exist.

Do **not** parallelize work that causes two agents to redefine the same core contract at once.

## Things that must not block Commercial Beta

Unless a real design partner proves them essential:
- autonomous booking/calendar connectors;
- public developer API/webhooks;
- CRM integrations;
- advanced contact merge UI;
- acquisition/prospecting bot;
- Telegram/Threads;
- AI-generated outbound images/voice;
- broad analytics polish;
- advanced custom retention controls.

Their extension boundaries remain documented, but their implementations follow the core product.

## V1.1 immediately after commercial stability

Priority order:
1. booking/calendar vertical slice if customer demand confirms it;
2. public `/api/v1` + signed webhooks + prospecting handoff;
3. one practical CRM/data integration;
4. manual duplicate merge/split UX;
5. richer Admin Operations and support snapshots;
6. goal/source-aware analytics.

## Claude execution rule

Claude should work from one bounded task contract at a time. A task may create an interface/extension point for later work but must not implement unrelated future phases.

At the end of each implementation iteration Claude must:
- run the required verification for its task;
- push the exact HEAD;
- publish `CLAUDE_READY_FOR_ASTRA head=<full_sha> task=<task-id>` with a concise verification summary;
- continue to the next dependency-safe task under the current temporary review protocol rather than waiting for Astra, unless a human/project instruction explicitly changes that protocol.

Independent Astra review may follow asynchronously. Any later `CHANGES_REQUESTED` finding must be fixed before the affected code enters a production release, and the new HEAD must be reviewed rather than treating an older verdict as transferable.

## Roadmap invariant

The goal is not to finish every architecture document before shipping. The goal is to reach a safe vertical customer outcome as quickly as possible while preserving the invariants that are expensive or dangerous to retrofit later: tenant isolation, Business Profile scope, idempotency, stale-state protection, human precedence, deterministic policy, durable intent and reconciliation.
