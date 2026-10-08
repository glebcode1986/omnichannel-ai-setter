# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Material state — 2026-09-29

**This section is the live instruction. Everything under "Historical launch plan" below is kept for the
record and is not a current task.**

Phase 1 and Phase 2 are implemented as one stacked chain of unmerged PRs, each branch based on its parent
and each awaiting independent review in dependency order:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`

Nothing is merged to `main`.

### Current work — P5-04 / Issue #30, the seven R5 blockers on PR #79

**Reviewed head:** `0b62c9e870b260642cb07d386198870c1f1e659f`, CHANGES_REQUESTED on 2026-10-08. The
persisted exact-head run was green and did not cover any of the seven cases.

All seven are repaired on `feat/p5-04-ai-settings-simulation`:

1. **role authorization** — `savePolicy` requires OWNER or ADMIN (`ONBOARDING_UX.md`: workspace roles
   constrain policy changes), the screen shows the settings read-only to anybody else, and the action
   reports the refusal as `FORBIDDEN` rather than crashing;
2. **concurrent writes** — `automation_policies.version`, compared under `SELECT … FOR UPDATE` inside the
   save's own transaction, with a typed `CONFLICT` carrying the stored values, and a barrier-based
   regression that fails when the lock is removed;
3. **the confirmation** — the acknowledgement carries the exact impact codes the server computed and
   showed, the summary is rendered next to the refused proposal rather than next to stored values, and
   the proposal travels with the version it was composed against;
4. **custom timing** — four range inputs on the form, sent only for `CUSTOM`, in seconds on screen and
   milliseconds in the store;
5. **the audit UI** — both sides of every field that moved, and a keyset cursor so the twenty-first
   change is reachable;
6. **the simulation** — channel, window, connection, the human-support exception, what would be sent and
   which approved template are all explicit inputs; the chosen channel's own after-window policy is used,
   and the screen states which inputs produced the answer. Every one of them is proved to move the
   deterministic outcome, including the **template allowlist**: it reaches the engine as
   `templateRoute.automatable`, computed where a catalogue would be rather than inside the engine
   (ADR-016), so empty versus non-empty decides `SKIP` against `SCHEDULE` and the three WhatsApp modes are
   distinguishable. WhatsApp's closed service window is `TEMPLATE_ONLY`, which is what the gate keys on —
   modelling it as an expired free-form window was why the modes had been indistinguishable;
7. **coordination state** — this section and `CURRENT_HANDOFF.md` now say the same thing, which is the
   defect finding 7 actually was.

**The stale-proposal flow converges.** A refusal hands the owner's values back rebased onto the version
stored now, with the impact summary recomputed against it and a seal minted for that exact pair — so after
another admin's save the original operator reviews a refreshed proposal and completes it, instead of
re-posting a stale version into the same refusal. A seal stops verifying as soon as the stored version
moves, including when the change leaves the impact list identical; the store's conditional write remains
the separate answer to "is this still the state you saw".

**One predicate decides whether the acknowledgement is offered**, and the sentence that names the control
asks the same one — `acknowledgementOffered`. Weighing a subset of its five facts somewhere else is how the
page came to say "tick the box" with no box.

**Open, reported on #79, not fixed here:** `policyImpactsOf` models no impact for widening the WhatsApp
template allowlist once `TEMPLATE_AUTOPILOT` is already stored, so the edit that makes unattended
after-window template sends possible is saved with no effect summary and `impacts: []` in its audit row.

**The acknowledgement is a sealed one.** The refusal mints an HMAC over the exact proposal, its version
and the impacts shown; the save accepts an acknowledgement only with a seal it minted. Comparing public
impact codes is not proof, because the codes are in the URL, the page and the catalogue.

**Review gate, in one place:** #78 PASSED at `8692d8f35d16256beb819488da9ae5a263a1a3e1`; #79
CHANGES_REQUESTED at `0b62c9e…` (seven blockers) and again at `d67da89…` (four closed, three kept), all
repaired, awaiting independent re-review; #80 and everything below held and **not ready for review** until
#79 passes, because they contain #79.

**The #79 repairs are not propagated.** They exist only on `feat/p5-04-ai-settings-simulation`; the repair
directive forbids merging them into #80 or later until #79 passes, so every branch below still carries the
pre-repair #79 and will need this merged down once the PASS lands.

### Sixth blocker repair — P5-06 / Issue #32, the six findings on PR #78

**Reviewed head:** `5c28dcd73c8f86dea4625326bc53747a0af320ce`.
**Repaired at:** `a3d27e39d479a5c00ea5ebea2e6af9216e869e17`, exact-head GitHub Actions run
[37608987350](https://github.com/glebcode1986/omnichannel-ai-setter/actions/runs/37608987350) succeeded.
This note is the canonical handoff the same directive asked for, so the branch head is one commit later
than the repair SHA; PR #78 carries the current one.

**PR #78 has an independent PASS at `8692d8f35d16256beb819488da9ae5a263a1a3e1`, and the hold is lifted.**
That PASS was the condition every one of these notes was waiting on. The P5-06 repairs are now merged
down the chain by ordinary merge, every branch from #79 to #103 carries them, and each was pushed with
its own CI run. No rebase, no force-push, no merge to `main`.

Propagating found one thing nothing else would have: `style_example_decisions` is append-only from #32,
and a customer's erasure has to empty it, so every deletion request ended `PARTIAL_FAILURE` the moment
the two branches met. Fixed at `feat/p3-04-privacy-deletion` — a `DELETE` is permitted only while a
transaction has declared itself a customer erasure with `SET LOCAL`, and `UPDATE` stays refused either
way. See that branch's own commit for why the guarantee is about rewriting rather than about erasure.

The six findings and what each repair actually was:

1. **Archive and restore were unreachable through the UI.** `loadStyleScreen` loaded only `ACTIVE` and
   `SUGGESTED` rows, so an archived example or a rejected suggestion vanished from both lists while
   `StyleExampleList` carried a restore branch nothing could ever reach. The screen now loads and renders
   the withdrawn rows, which is what makes the acceptance path exist at all.
2. **The suggestion flow had no production producer.** `suggestStyleExample` was called only by its own
   tests, and it hard-coded `HUMAN_TYPED` with no `sourceDraftId`, so a `HUMAN_EDITED_DRAFT` suggestion
   was unconstructible. `resolve-review.ts` now suggests the edited draft through a
   `StyleLearningStore.suggestEditedDraft` port, so an unticked edit becomes a `SUGGESTED` example with
   its real provenance and its source draft.
3. **A workspace-scoped example could not be created from the screen.** The add-example form posted no
   `scope`, and `scopeFrom` defaults a missing value to `BUSINESS_PROFILE`, so the store's `WORKSPACE`
   support was unreachable. The form carries the control, and the cross-profile write goes through the
   same admin-or-owner check `createBusinessProfile` applies.
4. **The Style test was a retrieval browser, not the contracted test.** `KNOWLEDGE_STYLE_UX` asks for a
   neutral prompt with a *candidate output* plus the instructions and examples that influenced it;
   `runStyleTrial` returned a retrieval mode and hits. `style-test.ts` now resolves the effective voice
   through the worker's own `createStyleProfileStore` path and produces a candidate, with
   `knowledge: []` by contract so a style test cannot borrow factual retrieval.
5. **Voice-profile saves were unsafe under the R5 multi-tab contract.** `findFirst` then an
   unconditional `create`/`update` let two first saves both see no row, and let a stale tab overwrite a
   newer operator's profile. The write is conditional on an expected `updatedAt`, returns a typed
   `CONFLICT`, and has deterministic concurrent-create and stale-update regressions.
6. **The decision history was not persisted.** Reject, archive and restore only replaced `status`, and
   restore overwrote `approvedByUserId`, destroying the identity of the prior approver. `decide()` writes
   append-only `style_example_decisions` rows (migration `20261004160000_style_example_decisions`) and
   never re-stamps the first approver, so the lifecycle is reconstructable.

**Exact-head verification reported for the repair SHA**, in addition to the successful Actions run:
clean-environment `pnpm verify` with no database and no Redis; the PostgreSQL and Redis infrastructure
suites; the webhook-to-queue E2E suite; the evaluation harness with no quality regression; and
`db:check-drift` reporting `No difference detected.`

### Previous work, now passed — P5-06 / Issue #32, the retired-list reachability blocker on PR #78

**Reviewed head:** `66a317fa0330e29b6bed9238286158fde48f9c01`. Astra accepted the database-enforced
immutability and the per-example lifecycle pagination in full, and returned one blocking reachability
defect — the one the previous evidence comment had named and left alone as pre-existing.

The retired list showed archived examples and declined suggestions as one list and read them as two pages
concatenated. `ARCHIVED` consumed the `retired` cursor; `REJECTED` was always its own first twenty-five;
the merged page inherited continuation only from the archived half. One cursor cannot continue two
queries, so the twenty-sixth declined suggestion was unreachable by any rendered link, and its lifecycle
with it — a history opens only for an example on the page.

Fixed with one query over both statuses rather than a second cursor: `StyleExampleFilter.status` takes one
status or several, and the merge is deleted. Reachability is now a property of the query —
`(createdAt desc, id desc)` over both statuses is total and stable, so the cursor visits every row exactly
once whichever status it has. The list is ordered newest-first across both statuses instead of archived
then rejected; every existing screen test passed unchanged.

**Earlier heads in this repair chain:** `d9d1108` was the docs-only handoff; `66a317f` carried the
immutability and lifecycle repair, both now accepted. Five of the six earlier blocker areas are accepted and
this repair changes the behaviour of none of them. Four are untouched; the fifth — the retired-example UI —
shares the component, the assembler and the route that carry the history, so those three files gain props
and a derivation additively, with the restore control and the badges byte-identical.

One finding remained: the decision history was neither database-enforced append-only nor fully
retrievable. Both halves were the same shape — a guarantee that held because of what this package's source
currently does, rather than because the system makes it hold.

**Immutability belongs to the table now.** The history was "append-only by use": nothing in the store
edits one of these rows, and the foreign key protects the *example* rather than its history. The case that
matters is the one where this package is not what is running — a support script, a later migration, a
hand-typed `UPDATE` during an incident. A row trigger refuses `UPDATE` and `DELETE`, and a statement-level
one refuses `TRUNCATE`, because a row trigger never fires for a truncate and the guarantee would otherwise
have ended at the one statement that destroys everything rather than editing one thing. Both are
`ENABLE ALWAYS`: a plain `CREATE TRIGGER` is origin-only, so `SET session_replication_role = 'replica'` —
an ordinary statement on this connection — would have switched both off in one line, with no DDL and
nothing recorded. DDL on the table by its owner remains open and no trigger can close it, so the claim is
"unrewritable by anything short of DDL" rather than "unrewritable".

**The lifecycle is reachable end to end.** The window is still twenty decisions, but the twenty *most
recent* instead of the twenty oldest — the defect exactly inverted, because the cut used to fall at the
newest end and hide the events that explained an example's current state. The window says how many earlier
events it left behind and carries a `(decidedAt, id)` cursor, and `readStyleExampleLifecycle` returns the
page before any cursor with the cursor for the one before that. The window reports **both** of its edges:
a page read backwards hides the newer half, and the first version of this repair therefore reproduced the
blocked defect one click later — a history ending in `RESTORED` under a badge reading "Archived". Both
halves of the cursor travel: `decided_at` is not unique, and a cursor on an instant alone silently repeats
or skips rows.

**The hold is lifted**: PR #78 has an independent PASS at `8692d8f35d16256beb819488da9ae5a263a1a3e1`,
and the repairs are merged down the chain. No rebase, no force-push, no merge to `main`.

### Fifth blocker repair — P5-05 / Issue #31, the archive a stale Publish could undo

**Reviewed head:** `e4e640a8fafc4fbca92ca64e5588551539410f6e`.
**Repaired at:** `7805abda1bafcbfc83d93e03dc31f4f640985858` — the code fix and its regressions.
This note is the documentation follow-up the same review asked for, so the branch head is one commit
later than the SHA above; PR #77 carries the current one.

Astra re-reviewed `e4e640a`, confirmed the four findings of the previous cycle repaired, and returned one
more in the same R5 stale-UI class.

**A stale Publish silently resurrected an archived source.** Archiving deliberately leaves the version
alone, so the expected version a tab rendered still matched after another operator archived the source —
and the conditional write named only the version and the indexing state, so the click wrote `ACTIVE` over
the archive and reported success. A source somebody had deliberately removed from retrieval was answering
customers again, with nothing on screen to say why.

The write is now bound to the act the screen offered. `restoreKnowledge` takes
`act: "PUBLISH" | "RESTORE"`, refuses a status that act does not expect, and names `status` in its
conditional write so an archive landing in the gap misses instead of being published over. The answer is a
typed `STALE_STATE`, which the screen shows as the same "reload and look" sentence a conflict gets while
the store keeps the two apart for the audit. It stays optional for a caller with no screen behind it,
which then gets the version and health checks alone.

### Fourth blocker repair — P5-05 / Issue #31, reachability and atomicity

**Reviewed head:** `fcd4983fbfec2364d94b66068a2f6704ae63b614`.
**Repaired at:** `e4e640a8fafc4fbca92ca64e5588551539410f6e`.

Astra reviewed `fcd4983` and returned four blocking findings, all in the space between pieces that were
individually correct.
### Fourth blocker repair — P5-05 / Issue #31, reachability and atomicity

Astra re-reviewed `fcd4983` and returned four blocking findings. All four were in the space between
pieces that were individually correct.

1. An edited ACTIVE source had no UI path to publish its staged version: the page rendered the
   "saved v2, answered with v1" warning above a control row whose only button was Archive.
   `knowledgeLifecycleOf` now states the rule — a version that is not the published one is publishable
   whatever the status.
2. `editKnowledgeAction` omitted an unusable `expectedVersion`, and the store checks staleness only when
   it is present, so a form without the field edited whatever was current and reported `VERSIONED`. The
   guard moved to `knowledge-submission.ts` and refuses before the store is reached.
3. Publish was not bound to the version the operator saw. It travels page → control → action → store now,
   and a mismatch is a `CONFLICT`.
4. Publishing and recording an indexing failure could race into a raw `23514` constraint error. Each write
   names every column its decision came from, and the health write re-decides once.

This file was not updated in that cycle, which Astra was right to call out: the canonical launch state was
still describing the three-blocker repair below.
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
