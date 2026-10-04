# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Material state — 2026-09-29

**This section is the live instruction. Everything under "Historical launch plan" below is kept for the
record and is not a current task.**

Phase 1 and Phase 2 are implemented as one stacked chain of unmerged PRs, each branch based on its parent
and each awaiting independent review in dependency order:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`

Nothing is merged to `main`.

### Fourth blocker repair — P5-05 / Issue #31, reachability and atomicity

Astra re-reviewed `fcd4983` and returned four blocking findings. All four were in the space between
pieces that were individually correct.

1. An edited ACTIVE source had no UI path to publish its staged version: the page rendered the
   "saved v2, answered with v1" warning above a control row whose only button was Archive.
   `knowledgeLifecycleOf` now states the rule — a version that is not the published one is publishable
   whatever the status.
2. `editKnowledgeAction` omitted an unusable `expectedVersion`, and the store checks staleness only when
   it is present, so a form without the field edited whatever was current and reported `VERSIONED`. The
   guard moved to `knowledge-submission.ts`, refuses before the store is reached, and is tested against
   requests no browser builds.
3. Publish was not bound to the version the operator saw. It travels page → control → action → store
   now, and a mismatch is a `CONFLICT`.
4. Publishing and recording an indexing failure could race into a raw `23514` constraint error. Each
   write names every column its decision came from, and the health write re-decides once against the
   state that replaced it.

### Second blocker repair — P5-05 / Issue #31, the concurrency interleavings

Astra re-reviewed `c12dd43` and returned three blocking findings. Two were introduced by the previous
repair: separating Save from Publish created interleavings the repair did not close.

1. Publish wrote conditionally and discarded the count, so a save in the gap meant nothing was published
   and the operator was told otherwise. It returns a typed `CONFLICT` now.
2. Save carried no expected version, so a stale tab overwrote a colleague's work and two simultaneous
   submits raced for the same next version. `expectedVersion` travels page → form → action → store.
3. A failure to index an unpublished version archived the document, stopping the healthy published
   version. The CHECK is now about the published version, and so is the store.

Also closed: the knowledge outcome family was absent from `OutcomeNotice`, so no knowledge write had ever
shown the operator a message. A typed conflict nobody sees is not a fix.

### Blocker repair — P5-05 / Issue #31, after `CHANGES_REQUESTED`

Astra reviewed PR #77 at `7eb5251` and returned three blocking findings, all correct. AntiGravity is
temporarily unavailable due to reviewer limits, so Astra is the active reviewer for this cycle.

1. **Save was a publish.** Retrieval joined the latest saved version, so editing a live source exposed the
   new wording immediately, against the editor's own promise. `published_version` is now a column of its
   own, moved only by an explicit publish, and retrieval joins it.
2. **Indexing results were not version-bound.** A delayed result for v1 certified or failed v2. Results
   now carry their version and apply conditionally; anything else is `STALE`.
3. **The library truncated at 25.** The cursor the store returns is now carried through the route's query
   parameters, with the next link built from the incoming query so filters cannot drift.

### Follow-up repair — P5-06 / Issue #32, Style Training's missing pagination

The third instance of the defect Astra raised on #77, found by the same sweep over every paged store list
and fixed at the owner's request. Both example lists paged at 25 in the store and neither paged on screen.

Two lists on one page is what distinguishes it: each gets its own cursor parameter, and the next link
carries the other list's cursor through, so paging the suggestions cannot move the verified library.

Note on ordering: this branch does **not** yet contain the newer heads of #76 (`68cb3ac`, the Review
queue's pagination) or #77 (`b8d0eea`, the P5-05 blockers). Propagation waits for #77's verdict, because
merging into #77 would change the exact head being reviewed; when it lands, the whole chain gets one pass.

### Blocker repair — P5-03 / Issue #29, after `CHANGES_REQUESTED`

Astra reviewed PR #76 at `dc68334` and found that a human-composed pending delivery could neither be
displayed nor cancelled: the Inbox's pending-send query and the cancellation lookup both reached the
conversation through `draft: { conversationId }`, and an ADR-018 Option B delivery has no draft. Correct,
and the worse half is that the row still went out after the operator had been told it was not queued.

Fixed by giving both queries one shared predicate, `deliveryOfConversation` in
`packages/db/src/delivery-origin.ts`, so there is a single place that knows what "belongs to this
conversation" means for either origin. A third instance surfaced during the repair — the reconciliation
sweep's orphaned-row select — where the consequence was an ambiguous send that could never be raised for
investigation, and that is disclosed on the PR rather than folded in silently.

### Repair in progress — P5-10 / Issue #58, after `CHANGES_REQUESTED`

Astra reviewed PR #74 at `d422f755efa4ab294b2ec933117dbbe34ce28f3c` and returned two blocking findings,
both correct.

**Russian readers saw English role names.** `"Ваша роль: {role}"` was localized and
`workspace.role.toLowerCase()` was interpolated into it. Fixed with `role.*` keys in both locales,
translated before interpolation, and a test driven off the domain's `WORKSPACE_ROLES` so a role added
later cannot fall through.

**The enforcement guard was bypassable by ordinary JSX formatting** — multiline text, a string literal
rendered as a child, a single-quoted accessible name. It now uses the TypeScript compiler's parser, so the
whole class is gone along with the `|`/`=>` heuristics the regex needed. Each bypass has an adversarial
test, and the suite was checked against a file containing all three.

**A lesson worth carrying.** I wrote that guard and defended its narrowness as deliberate. Narrow in
*what it judges* was the right call; narrow because *a regex could not see* the code was not, and only an
outside reader found the difference.

Separately, the two long-disclosed worker flakes are fixed in their own commit on this branch — at the
root, in the clients we construct, with `process-guards.ts` left alone because it argues correctly against
exempting rejections by error code.

That fix then failed CI while passing locally, which was the more useful finding: local verification
exports `TEST_REDIS_URL` and `TEST_DATABASE_URL`, CI's `verify` job exports neither, so the worker's
no-infrastructure tests — the ones these flakes live in — had never been run the way CI runs them. The
allowlists in `main.test.ts` and `bundle.test.ts` now admit `queue.client_error` with its reason, and a
clean-environment `pnpm verify` is part of verifying a head.

### Original gate — P5-10 / Issue #58 (Stage D)

**Branch `feat/p5-10-localization`**, based on `feat/p5-01-app-shell-onboarding`. EN and RU as first-class
production locales, per-user and independent of the language customers are answered in.

**Issue #58 named two specs that did not exist**: `docs/specs/LOCALIZATION.md` and
`docs/specs/MVP_RELEASE_SCOPE.md`. It is also the only P5 issue with no task contract under `docs/tasks/`.
The issue's own Required behavior / Tests / Acceptance criteria were detailed enough to implement from, so
this task writes `LOCALIZATION.md` as part of its output — the acceptance criterion says later Phase 5 work
must *fail review* when it introduces unlocalized strings, and that needs a written rule to point at.
`MVP_RELEASE_SCOPE.md` is still missing and is not this task's to invent.

### Previous — P5-01 / Issue #27 (Stage D)

**Branch `feat/p5-01-app-shell-onboarding`**, based on the accepted #72 head
`9955ecf6c114145d54bb7dd46abbc902267bd00c`. It carries the authenticated workspace shell and the resumable
setup surface: the first product UI in the repository.

**It is branched from the chain, not from `main`, and that is a deliberate deviation from the task
contract.** P5-01 says "open focused PR to `main`", which assumed Phase 1 would be merged by the time it
ran. `main` holds documentation only — no `packages/`, no auth, no database — so a branch from it would
carry an app shell with nothing to authorize against. The task's own start condition ("Phase 1
Auth.js/workspace membership and app scaffold are accepted") is satisfied by review acceptance, which is
how every PR in this chain has worked. Retargeting the PR is one command if the owner prefers otherwise.

Stage D's order in MASTER #61 is followed as written. One note for whoever picks up #58: P5-01 keeps every
user-facing string in `apps/web/src/ui/labels.ts` precisely so the localization foundation replaces one
module rather than reopening every component.

### Accepted and propagated

- **PR #72 / P3-03 (Issue #56)** was independently accepted at
  `9955ecf6c114145d54bb7dd46abbc902267bd00c`. The kill switch is read with the state the delivery claim
  binds and re-asserted inside the claim, and activation is ordered against in-flight claims by a trigger
  on `automation_suspensions` rather than by a lock in a store method — so the direct SQL an operator runs
  during an incident participates too. See `docs/specs/RELIABILITY_INCIDENTS.md`.

### Accepted and propagated

- **PR #71 / P2-09 (Issue #16)** was independently accepted at
  `38df858508ec61e2c6821e47a0a5225c86768223`. The production web composition registers an Instagram adapter
  per route-resolved channel account and reads that account's own credential through its relation; the live
  `INSTAGRAM_HUMAN_AGENT_APPROVAL` reaches draft disposition, the final channel-state resolver and the
  sender from one composition, so an approved human-support reply is reachable through the shared gate; one
  registry binds adapters in both directions; and the verification gate now runs every project that owns an
  integration suite, with a meta-test that fails when one is added outside it.

  Merging it down raised one question the chain had not answered: whether a human approval gets a reply
  past an operator's kill switch. It does not. The gates an approval answers are the ones asking for a
  person to look; a kill switch is a statement that nothing may leave, and an approval recorded before the
  operator said it cannot answer it. `AUTOMATION_SUSPENDED` is now asserted in `evaluate.test.ts`, where it
  was asserted nowhere before.
- **PR #70 / P2-08 (Issue #15)** was independently accepted at
  `c15a9a6f558d9270263ad7573669f76ca3af8ac0`. The evaluation harness now asserts the model's own intent and
  suggested lead stage rather than merely supplying them, so a classification regression can no longer hide
  behind an identical reply — see `docs/specs/AI_EVALUATION.md`.
- **PR #69 / P2-07 (Issue #14)** was independently accepted at
  `4c9f496d805316ded56311e41bdd4c3c39ff5a43`. The authority a reviewed reply is sent under is persisted with
  the delivery and read from there; the approver is the authenticated member rather than one the command
  named; each decision commits in one transaction; and an existing send is reused only for a provably
  identical decision. See `docs/specs/HUMAN_HANDOFF.md`.
- **PR #68 / P2-06 (Issue #13)** was independently accepted at `fb35665209b90c82bc10f3068450111e75f83299`.
  The send claim re-asserts the state its revalidation was made against, inside a transaction that shares
  row locks with the writers of those facts — see `docs/specs/DELIVERY_COORDINATOR.md`.
- Everything earlier in the chain up to and including **#67 / P2-05** has an independent PASS at its
  published head.

### Blocked

Nothing is merged to `main`, and no work beyond P5-01 is started. Do not rebase, force-push or merge to
`main`.

## Phase 4 gate — WhatsApp

Phase 4 contracts are prepared under `docs/tasks/P4-*`. ADR-016 is Accepted with:
- `SERVICE_WINDOW_ONLY`
- `TEMPLATE_REVIEW`
- `TEMPLATE_AUTOPILOT`

Do not start WhatsApp features before the shared core/AI/delivery/handoff dependencies each task requires are stable.

## Phase 5 gate — SaaS UX

Phase 5 contracts are prepared under `docs/tasks/P5-*`, Issues #27–#35, with #36 independent review.

Phase 5 may start **incrementally** when a feature's backend dependency is stable. It does not need to wait for every WhatsApp feature. Examples:
- P5-01 app shell/onboarding after Phase 1 auth/workspace is stable;
- P5-02 Inbox after conversation/message query APIs are stable;
- P5-03/P5-04 after policy/delivery/handoff/AI APIs are stable;
- Knowledge/Style/Leads/Analytics after their respective backend APIs exist.

Do not use a future prepared UX task as permission to bypass its explicit start condition.

## Supervisor rule

After every Claude PR:
1. stop before merge;
2. run ChatGPT architecture review against the issue + contract;
3. run the applicable Codex/Astra independent review contract;
4. fix blocking findings on the same feature branch;
5. merge only after acceptance;
6. update this queue/current handoff if project state materially changes.

---

# Historical launch plan

> Kept for the record. **None of the sections below is a current task.** They describe the original Phase 1
> launch sequence, which has been carried out: every task named here is implemented and sits in the stacked
> chain above. Read the "Material state" section for what to work on.

## First task — HISTORICAL

### P1-01 — Issue #2: Scaffold pnpm workspace and baseline tooling

Contract: [`P1-01_CLAUDE_TASK_CONTRACT.md`](./P1-01_CLAUDE_TASK_CONTRACT.md)

Branch: `feat/p1-01-project-skeleton` — implemented, PR #26, awaiting independent review in chain order.

## Second task — HISTORICAL

### P1-02 — Issue #3: Domain model and channel contracts

Contract: [`P1-02_CLAUDE_TASK_CONTRACT.md`](./P1-02_CLAUDE_TASK_CONTRACT.md)

Branch: `feat/p1-02-domain-channel-contracts` — implemented, PR #49.

## Queue after P1-02 — HISTORICAL

1. P1-03 / #4 — Prisma + Auth.js + workspace isolation (`P1-03_CLAUDE_TASK_CONTRACT.md`) — PR #50.
2. P1-04 / #5 — BullMQ durable queue/delay primitives (`P1-04_CLAUDE_TASK_CONTRACT.md`) — PR #51.
3. P1-05 / #6 — channel-neutral webhook ingestion (`P1-05_CLAUDE_TASK_CONTRACT.md`) — PR #52.
4. R1 / #7 — independent Codex/Astra review throughout Phase 1 — ongoing, per PR.

## Phase 2 gate — Instagram + shared AI — HISTORICAL

Phase 2 was started under the owner's Stage B directive (MASTER Issue #61) once the Issue #53 Business
Profile sync completed, and is implemented as PRs #63–#71 in the chain above. Contracts: `docs/tasks/P2-*`.

## Stage C — CURRENT STATE: Gate C PASS

Stage C's only task, #56 / P3-03 (reliability controls, health, kill switches, reconciliation), was
accepted as PR #72 at `9955ecf`. The whole #26→#72 chain has an independent PASS. Gate C's conditions
hold: the dashboard may be closed while the server continues safely, dependency failures degrade
narrowly, and outbound can be stopped without losing inbound.

## Stage D — CURRENT STATE: in progress, seven branches

Stacked in MASTER #61's order, each branch cut from the previous task's head because `main` carries
documentation only. Every PR below is CI-green with an evidence comment and a
`CLAUDE_READY_FOR_ASTRA` marker.

| Task | Issue | Branch | PR |
| --- | --- | --- | --- |
| P5-01 app shell + resumable onboarding | #27 | `feat/p5-01-app-shell-onboarding` | #73 |
| P5-10 EN/RU localization | #58 | `feat/p5-10-localization` | #74 |
| P5-02 unified Inbox | #28 | `feat/p5-02-unified-inbox` | #75 |
| P5-03 conversation operations + Review Queue | #29 | `feat/p5-03-review-conversation-ops` | #76 |
| P5-05 Knowledge Library | #31 | `feat/p5-05-knowledge-library` | #77 |
| P5-06 Style Training | #32 | `feat/p5-06-style-training` | #78 |
| P5-04 AI settings + no-send simulation | #30 | `feat/p5-04-ai-settings-simulation` | #79 |
| P5-07 Leads pipeline | #33 | `feat/p5-07-leads-pipeline` | store only, no PR yet |

**P5-03 is complete.** ADR-018 was accepted as Option B on 2026-09-30, and the composer is built: a
human-composed reply has an honest non-AI origin on the delivery record, goes through the one delivery
coordinator with every gate re-asserted, and creates no `AiDraft` row.

### Open questions for the owner

1. **P5-07: may a Workspace add a lead stage?** `LEADS_ANALYTICS_UX.md` says it may. `LeadStage` is an
   enum the draft engine returns in its structured output, so adding one is a change to what the model may
   produce rather than a display preference. Rename, reorder and hide are built.
2. **`docs/specs/MVP_RELEASE_SCOPE.md` does not exist** but Issue #58 referenced it. `LOCALIZATION.md` was
   written as part of that task; this one was deliberately not invented.
3. **The playground and the retrieval tester run in `apps/web`**, which now reads the worker's embedding
   and reply-model settings (both optional). Moving them into the worker is a reasonable alternative if
   you would rather the web app held no model configuration.
