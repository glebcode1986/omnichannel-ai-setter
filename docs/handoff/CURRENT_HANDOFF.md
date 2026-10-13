# Current Handoff

**Date:** 2026-09-16  
**Phase:** Stage D (Phase 5 SaaS UX) in progress; Phase 2 Instagram/shared-AI fully specified; Phase 4 WhatsApp fully architected; Phase 5 SaaS UX fully specified/task-contracted  
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

**The chain now runs to #82**, each branch stacked on its predecessor and each CI-green with evidence
posted. PRs #73–#81 are completed by Claude and awaiting review; **#82 / P3-02 is the current task**.
**Next after it is P5-08 / Issue #34**, per the owner's directive on PR #81 — and not before; that work
exists on a local branch and is deliberately unpublished. Everything in Phase 1 and Phase 2 has an independent PASS at its published
head, including **#72 / P3-03 at `9955ecf6c114145d54bb7dd46abbc902267bd00c`**, **#71 / P2-09 at
`38df858508ec61e2c6821e47a0a5225c86768223`**, **#70 / P2-08 at
`c15a9a6f558d9270263ad7573669f76ca3af8ac0`**, **#69 / P2-07 at
`4c9f496d805316ded56311e41bdd4c3c39ff5a43`** and **#68 / P2-06 at
`fb35665209b90c82bc10f3068450111e75f83299`**; all are propagated downstream. Nothing is merged to `main`.

Everything is unmerged PRs stacked by base — but **not one chain. Two live segments**, which was measured
on 2026-10-13 and had been assumed otherwise until then:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`
` -> #73 -> #74 -> #75 -> #76 -> #77 -> #78 -> #79 -> #80 -> #81 -> #82`

`#83 -> #84 -> #85 -> #86 -> #87 -> #88 -> ... -> #103 -> #104 -> #105`

```
$ git merge-base --is-ancestor origin/feat/p3-02-goals-followups origin/feat/p5-08-analytics-audit
  → no
$ git merge-base  …p3-02-goals-followups  …p5-08-analytics-audit
  c098c18   (an older state of #82)
```

**#83 forks from `c098c18`, an older state of #82**, so the second segment contains neither the accepted
#79/#80/#81 parents nor the P3-02 repair. Two consequences, both of which have already cost real work:

- A repo-wide repair must be applied **in both segments**, or one of them keeps the defect until the
  propagation arrives — which can be weeks. The nine fixture-clock repairs below were done that way for
  exactly this reason.
- The second segment's branch order is **not PR-number order**: #85 is `fix/instagram-token-lifecycle` and
  #86 is `fix/dead-suspension-resolver`, two fix branches sitting between the Stage D work and Phase 4.

Measure the graph before acting on it. PR numbers and PR bases both lie about it.

**The chain was repaired on 2026-09-30.** PR #76 gained its second commit — the human composer — *after*
#77 had been cut from it, so #77 through #81 were all missing the human-composed send path. It was merged
down through each in order, verified and pushed. A correct PR base does **not** mean a branch contains its
parent: check every link with `git merge-base --is-ancestor <parent> <child>` before building on one.

| PR | Task | Issue |
| --- | --- | --- |
| #73 | P5-01 app shell + resumable onboarding | #27 |
| #74 | P5-10 localization foundation | #58 |
| #75 | P5-02 unified Inbox | #28 |
| #76 | P5-03 review operations + human composer | #29 |
| #77 | P5-05 Knowledge Library | #31 |
| #78 | P5-06 Style Training | #32 |
| #79 | P5-04 AI settings + no-send simulation | #30 |
| #80 | P5-07 Leads pipeline | #33 |
| #81 | P3-01 customer identity, search and memory | #54 |
| #82 | P3-02 goals, follow-ups and human tasks | #55 |

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

8. P2-02 (#9): Instagram Login onboarding and token lifecycle — connect/callback/disconnect routes, encrypted credential storage, single-use OAuth state and refresh handling. The adapter is registered in `apps/web` by the vertical slice (#16), which resolves each account's own credential.

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

**Two languages, never coupled (#58 / P5-10).** The dashboard locale is a per-user preference on
`users.ui_locale`; the language a customer is answered in comes from the Business Profile's style profile
and the conversation. An agency operator may read Russian while replying in German for a business
configured in English, and all three are correct at once. The separation is structural — different rows,
different owners, no query that reads one to decide the other — and an integration test states it rather
than trusting it. Missing keys throw in development and fall back to English in production, because a
person mid-task must not be shown a raw key. See `docs/specs/LOCALIZATION.md`.

**Onboarding readiness is evaluated, never stored (#27 / P5-01).** `BusinessProfile` already said why:
status is not operational readiness, and readiness is evaluated at execution time. So the setup checklist
is a pure function of the profile's own configuration, read now — which is also what makes onboarding
resumable without a state machine, because the completed steps *are* the channel account, the policy row
and the knowledge documents. The single stored fact is a deliberate skip, because "no style yet" and "we
decided not to write one" look identical in a style table and only one of them should let a workspace go
live. Activation re-judges the checklist inside the transaction that flips the status, so a page left open
for an hour cannot assert what was true when it rendered. See `docs/specs/ONBOARDING_UX.md`.

**A kill switch is only as strong as the boundary it is enforced at (#56 / PR #72).** Binding the switch
to the delivery claim was not enough on its own: the ordering lived in a store method, so it bound callers
who went through that method and nobody else — while this spec's own incident guidance says the table is
written to by hand. A `BEFORE INSERT OR UPDATE OR DELETE` trigger now takes the scope's advisory key, so
every activation route participates, including direct SQL. The cost is the key being spelled in both SQL
and TypeScript, and a mismatch has no symptom — the claim would simply stop waiting — so a test holds the
two derivations against each other and pins the property that matters: a switch that covers a send derives
a key that send's claim already holds. See `docs/specs/RELIABILITY_INCIDENTS.md`.

**A kill switch is not a request for someone to look (#56 / PR #72).** Merging the accepted #71 head down
raised the question directly: the policy engine now skips the gates that mean "a person should look at
this" once a person has, and an operator's suspension sits among them in the same function. It stays
unconditional. What an approval answers is a request for human attention; a kill switch is an operator
saying nothing may leave, and a click recorded before they said it does not answer that. Making it
authority-aware would build the one path around the switch. `AUTOMATION_SUSPENDED` is asserted in
`packages/application/src/policy/evaluate.test.ts`, which is new: the reason code existed and no test in
the repository named it.

**A skipped suite and a passing suite look the same (#16 / PR #71).** `pnpm verify` runs the whole test
run without a database or Redis, so DB-backed suites skip there by design and the infrastructure scripts
are what execute them. A new integration suite in a project no infrastructure script named therefore
reported "skipped" inside a green CI run, and the defect it reproduced was never exercised in the review
gate. `pnpm test:e2e` now runs `@omnichannel/web` as well as `@omnichannel/worker`, and
`scripts/verification/gate.test.ts` fails whenever a project owns an integration suite that no
infrastructure script runs.

**A channel is only real where it is composed (#16 / PR #71).** Every part of the inbound half passed its
own tests while `apps/web` registered no adapter at all, so no webhook reached signature verification,
normalization, persistence, the outbox or debounce; and the final policy gate answered the Human Agent
question with a hard-coded `UNKNOWN`, so the outbound half could never choose the tagged transport no
matter what a person had authorized. Both are now wired through the normal composition roots — the web
app binds an adapter per resolved channel account and reads that account's own credential through its
relation, and the worker hands one live `INSTAGRAM_HUMAN_AGENT_APPROVAL` to the draft disposition, the
final channel-state resolver and the sender alike. Missing configuration binds no adapter, which refuses
the webhook before anything is stored. See `docs/specs/INSTAGRAM_ADAPTER.md` and ADR-014.

**Delivery send authority is bound to the claim (#13 / PR #68).** The final pre-send revalidation is no
longer separated from the claim by an unguarded gap: the claim's own statement re-asserts every fact the
revalidation rested on — reply cycle, conversation state and version, draft, account health and the
automation-policy rows the mode and limits came from. A claim whose facts have moved is refused as
state-changed, re-read and re-judged, and the change is normally what then cancels or holds the delivery.
Nothing is sent and no attempt is counted. See `docs/specs/DELIVERY_COORDINATOR.md`.

**The unified Inbox reads by cursor and admits what it does not know (#28 / PR pending).** One operational
inbox over Instagram and WhatsApp, three panes on a desktop and one screen at a time on a phone. The view
— search, filters, the open conversation, the page position — lives entirely in the URL, so a reload, the
back button and a pasted link agree about it and the list works before JavaScript arrives. There are no
read receipts: what an inbox calls unread is "the customer spoke last and nobody answered", so the filter
says "Awaiting reply" and means it. Paging is `(lastMessageAt, id)` cursors over a bounded page rather
than offsets, because an inbox reorders itself constantly and page two of an offset query repeats and
skips rows. Two bugs came out of that work: the page returned a cursor whenever it *filled*, so data
ending on a page boundary offered a "load older" link that loaded nothing — and in a refilled page the
same mistake dropped every conversation behind the fill point outright. Mode badges show the mode in
force, not the conversation's empty override, and the precedence now has one implementation
(`packages/db/src/automation-mode.ts`) shared with the draft pipeline. The Inbox reads and does not act:
approving and editing arrive with P5-03, and the panel says so rather than showing disabled buttons. See
the implementation notes in `docs/specs/PRODUCT_UX.md`.

**Gate C is PASS.** Stage C's only task, #56 / P3-03, was accepted as PR #72 at `9955ecf`, and the whole
#26→#72 chain has an independent PASS. Reliability controls, health reporting, kill switches and
reconciliation are in place: the dashboard may be closed while the server continues safely, dependency
failures degrade narrowly, and outbound can be stopped without losing inbound.

**A human-composed reply has an honest origin (ADR-018 Option B, accepted 2026-09-30).** The composer was
the one part of P5-03 that could not be built without a decision, because a delivery required an
`ai_drafts` row and a person's words are not a generation. Option B was accepted: `delivery_jobs.draft_id`
is nullable and the row carries `human_text` with its author, under CHECKs admitting **exactly one**
origin — never none, never both, never anonymous human wording, never an author on a model's draft, never
empty text, and never automation's authority on words a person typed. `ai_drafts` is untouched and stays
model-only, so no human reply reaches `readReliabilitySnapshot`, `countUnusableGenerations` or the evals.

The delivery coordinator is still the only path to a customer. A human-composed delivery is claimed by the
same atomic claim, re-asserts the same conversation facts in the same conditional update, and is refused
by the same policy, window, account-health, kill-switch and takeover gates. Its wording is part of the
guard, so an edit between the judgement and the claim refuses rather than sending something nobody judged.
Idempotency is the same decision digest the review path uses.

## Immediate next actions

### Where the review gate actually stands

One list, because two documents disagreeing about this is itself a defect Astra has blocked a release
over — a note saying "awaiting re-review" next to a note saying "passed" leaves a reader no way to tell
which is current.

| PR | Branch | Status |
| --- | --- | --- |
| #78 | `feat/p5-06-style-training` | **PASSED** at `8692d8f35d16256beb819488da9ae5a263a1a3e1`. Head untouched since. |
| #79 | `feat/p5-04-ai-settings-simulation` | **PASSED** at `a1b46cb7789091f7782f039fdbf148631a77e3ea`, after CHANGES_REQUESTED three times — at `0b62c9e8…` (R5, seven blockers), at `d67da89e…` (four closed, three kept) and at `c4ebadb0…` (two contract blockers: allowlist widening, and the missing default policy) — plus two directed follow-ups in between: the stale-proposal dead end at `e3210e88…` and the test-only determinism repair of the concurrency barrier. Head untouched since the PASS. |
| #80 | `feat/p5-07-leads-pipeline` | **PASSED** at `bd1c039998fb41fe339af97ae2dc5e515810aa6c` — by **Antigravity (Gemini 3.8 Flash)**, under the owner's temporary reviewer route, not by Astra. Head untouched since. |
| #81 | `feat/p3-01-customer-identity-memory` | **PASSED** at `d9a34ffef120b7f0b171eb12f130d3848c9928cf` — by **Antigravity (Gemini 3.8 Flash)**, with a formal approving review. Head untouched since. |
| #82 | `feat/p3-02-goals-followups` | **The current gate**, and **CHANGES_REQUESTED, now repaired.** Two P1 blockers: the follow-up feature had no runtime caller at all, and a task could be assigned to somebody with no access to the Business Profile. Both closed, together with a third gap the end-to-end test found — the automated-response budget being applied to a send that answers nothing. The accepted #81 parent `d9a34ffef120b7f0b171eb12f130d3848c9928cf` is merged in by ordinary merge commit, and this is still the only branch below #81 it has been propagated into. Awaiting independent review at the repaired head. |
| #83 and below | `feat/p5-08-…` through `feat/p7-02-…` | **Frozen**, not ready for review. They are the chain's *second live segment*, forked from `c098c18` and still carrying the pre-repair #79. Each propagation directive permits one step only, so nothing below #82 may receive this parent until #82 itself passes. On 2026-10-13 every head here moved twice, for two repairs that had nothing to do with their own features: #90's red CI, and the nine fixture clocks. Both are recorded below; neither advanced any feature. |
| #104, #105 | `feat/p6-04-…`, `feat/p6-07-…` | Off the propagation chain, based on #103. #104 is the Stripe adapter (#41); #105 starts P6-07 (#44). Both await review and neither is affected by the freeze. |

**The independent reviewer is Astra again, temporarily, from 2026-10-13.** The owner routed reviews to
Antigravity (Gemini 3.8 Flash) on 2026-10-12 and has now put Astra back as primary for the next eligible
exact head while he diagnoses the local Antigravity watcher's workspace-write and concurrent-run
behaviour. Both verdicts already given stand — #80 and #81 were accepted by Antigravity at
`bd1c039998fb…` and `d9a34ffef120…`, and neither is to be re-reviewed merely to change the reviewer's
name. **Never launch both reviewer systems for the same PR and SHA.**

What has not changed: the review contracts, every previously accepted verdict, and the fact that **Claude
is the only authorized author** — no author-role substitution by any model without the owner's fresh
approval. The readiness marker this side publishes keeps its spelling,
`CLAUDE_READY_FOR_ASTRA head=<sha> task=<task>`, which the owner accepted for backward compatibility and
which routes to whoever is currently reviewing. A verdict marker — `ASTRA_REVIEW` or
`ANTIGRAVITY_REVIEW` — is the reviewer's and is never emitted from this side.

**One provenance note worth keeping.** The owner's own workstation has a separate clone and produced a
local-only merge commit for #82 (`2abb64117c2274adfbe6fc85ae7d552e23faf4b9`) during local reviewer
activity. It is not in this repository, it is not a GitHub head, and a `Co-Authored-By: Claude` line does
not make a commit this process's work. The #82 propagation recorded below was performed here, from the
remote heads, and its SHA is the one on the branch.

The #79 repairs are summarised under "P5-04" below. They now live on `feat/p5-04-ai-settings-simulation`
and on `feat/p5-07-leads-pipeline`, and **nowhere else**: the directive on #80 propagates the accepted
parent one branch at a time, so #81 and below still carry the pre-repair #79 and will each need this
merged down in turn. Do not read the #78 propagation described in the next paragraph as covering these —
that one is #78's and it is finished. No rebase, no force-push, no merge to `main`, and Stage D is not
started.

**The propagation into #80 found no semantic collision, which is worth recording because the dry run had
predicted where one would be.** Exactly four files were touched by both branches: `catalogue.ts`,
`schema.prisma` and `packages/db/src/index.ts` auto-merged (both sides only added — keys, models, exports
— and every added line from both sides is present in the result, checked line by line), and
`apps/web/src/ui/outcome-notice.tsx` conflicted because both appended to one `OUTCOMES` array. Resolved by
keeping both: P5-07's `MOVED`/`STALE_STAGE`/`UNCHANGED_STAGE` and P5-04's `FORBIDDEN`/`TOO_LONG`/the three
`TIMING_*`/the two `TAKEOVER_*`. The `REFUSALS` set below it auto-merged and already held both. Every
P5-04 settings, policy and simulation file is byte-identical to the accepted head.

The directive asked specifically that no part of the policy proposal state be dropped, naming
`presenceMode` and `presenceTypingLeadMs`. **Those two fields do not exist at #80**: they arrive with
P4-05 (commit `6ac04a3`, `feat/p4-05-whatsapp-presence`), which is below #80 in the chain, so the
collision the directive is guarding against becomes material when this parent reaches the P4-05 branches
and not before. What #80 does carry is the complete proposal state the confirm/refuse flow uses, and it is
built in exactly one place (`proposalFrom`) and converted to the store's edit in exactly one place
(`editFrom`); both are unchanged from the accepted head.

**PR #78 has an independent PASS at `8692d8f35d16256beb819488da9ae5a263a1a3e1`, and the hold is lifted.**
That PASS was the condition every one of these notes was waiting on. The P5-06 repairs are now merged
down the chain by ordinary merge, every branch from #79 to #103 carries them, and each was pushed with
its own CI run. No rebase, no force-push, no merge to `main`.

Propagating found one thing nothing else would have: `style_example_decisions` is append-only from #32,
and a customer's erasure has to empty it, so every deletion request ended `PARTIAL_FAILURE` the moment
the two branches met. Fixed at `feat/p3-04-privacy-deletion` — a `DELETE` is permitted only while a
transaction has declared itself a customer erasure with `SET LOCAL`, and `UPDATE` stays refused either
way. See that branch's own commit for why the guarantee is about rewriting rather than about erasure.

1. **Two repairs on 2026-10-13 that belonged to no feature, and the structural fact behind them.**

   **PR #90's head had been red since 2026-10-08 and nobody noticed**, because its own descendants were
   green. A fixture revoked a credential at a frozen `2026-10-05` on a row PostgreSQL stamps `created_at`
   on, and `channel_credentials_lifetime_check` requires `revoked_at >= created_at`, so it failed on the
   day the real clock passed the fixture's. The repair already existed on #91 and below — applied
   downstream and never brought back to the branch that owns the test. Fixed at #90 and merged down all 15
   descendants, every link content-neutral (`git diff <old> <new>` empty).

   **Then nine more of the same class, found by looking for it rather than waiting.** All wrote
   `channel_credentials.expires_at` as a frozen instant plus sixty days; the earliest would have turned CI
   red on **2026-11-09**, the rest through 2026-12-04. Proved by simulation in both directions: shifting a
   fixture's instant so its fuse sat in the past produced 15 failures naming the constraint, and with the
   expiry anchored to the real clock the same shift passes.

   Six of the ten sites went to the branch that owns them (#85, #88, #89, #90, #91, #93). **Four could
   not**: they belong to #64 and #71, which hold an exact-head PASS, and repairing there would move an
   accepted head. They went to the earliest *live* branch carrying them instead — #82 and #83, byte-
   identically so the eventual propagation merges one change rather than a conflict. That is a recorded
   decision, not an oversight: a PASSed branch is terminal, nothing is pushed to it again, so its CI never
   re-runs and its fuse never lights. Mechanically it is the same shape as the mistake that hid #90, and
   the only difference is that those ancestors are frozen. Say so in writing or it becomes the bug again.

   **The lasting lesson is the fixture clock itself.** A constant with a date in it is a timer. Where a
   CHECK compares a column against a `created_at` the database stamps, the test must anchor that column to
   the real clock or pin both ends; `packages/db/src/token-lifecycle.integration.test.ts` had the rationale
   written out before any of this and four neighbouring files still had the bug.

   **Operational note worth keeping.** For about 45 minutes that day every workflow run in the repository
   failed in ~3 seconds with **zero steps** — runs created and killed, one push creating no run at all.
   Nothing in the repository executed, so no code could be responsible; it was the private repo's Actions
   allowance, and it cleared when the repository was made public. When a run fails, read `steps`: a real
   job has 9 (`pnpm verify`) and 15 (`infrastructure suites`), a refused one has none. While it lasted,
   sixteen heads were verified locally instead — typecheck, lint, the full suite with real PostgreSQL and
   Redis, drift — and every one matched the CI result that came later.

1. **P3-02 / Issue #55 — two P1 blockers on PR #82, both repaired, plus a third gap found while proving
   the first.**

   **P1-1: the feature had no executable path.** `dueFollowUps`, `claimFollowUp` and `recordFollowUpSent`
   were correct, tested and **called by nothing**. A planned follow-up sat in the table for ever, and the
   store's own tests could not tell us, because they call the store. This is the defect class the
   repository keeps producing — exported, tested, never reached — and the second time it has been the
   blocker on a PR (cf. Issue #9's token refresh).

   The path, now end to end: `apps/worker/src/followup-sweeper.ts` is a `startRecoveryLoop` that finds due
   work and hands each `READY` claim to **the same AI-draft job an inbound message enqueues**. It decides
   nothing — every gate is re-asked inside `claimFollowUp` under the conversation lock, because a second
   copy of a rule is the copy nobody checks. Carrying it: a third `FOLLOW_UP` variant on the draft trigger
   (`AiDraftTrigger` gained the enum value in its own migration, since PostgreSQL forbids using a value
   added in the same transaction), `followUpGenerationKey` exported from `application` so the worker and
   the store derive one key one way, the attempt in the queue `jobId` so a re-enqueued attempt is one job
   and a second allowed attempt is two, `DueFollowUp` carrying the tenant scope the cross-tenant scan
   knows and `FollowUpView` does not, and `recordFollowUpSent` called from the handler **only** on a
   disposition that actually scheduled an operation — an attempt whose draft was held is settled by the
   next claim, so what an unsent attempt means is decided in one place.

   **P1-2: a task could be assigned to somebody who cannot see the Business Profile.** `createTask` and
   `assignTask` checked Workspace membership and never the profile grant, so a scoped member could be
   handed work on a profile they cannot open. Fixed with `canActOnBusinessProfile` in `tenancy.ts`, used by
   both paths through one `assigneeRefusal` helper. Reported and deliberately **not** fixed:
   `lead-store.editLead` has the same asymmetry, and it is #80's reviewed feature.

   The review asked for both halves — "including when users or grants change", and "ensure scoped task
   reads cannot reveal foreign identity" — and refusing the assignment only closes the door. A grant can be
   revoked after a legitimate assignment, and a row can predate the gate, so `listTasks` now resolves an
   assignee's identity through `usersWhoCanActOnBusinessProfile` as it stands *now*, on every read, in one
   query for the whole page. The name is withheld and the id kept, so an operator can see that a task is
   parked on somebody who cannot do it and take it back without learning a stranger's name. The same rule
   covers whoever closed the task: one rule for every identity a scoped read carries, which is the half an
   obvious fix stops short of.

   **And the other half of `CHANNEL_INELIGIBLE`.** The directive's recheck list named "window/template" and
   the claim asked neither, though the reason code has always been documented as "window closed, template
   required, account unhealthy". The claim now asks an injected port whether any route could carry the
   message, inside its own transaction with the facts read under the lock. The port **cannot permit a
   send** — every send is still decided twice downstream — so a `false` only declines to spend an attempt
   and a model call on something nothing could deliver, and it answers `false` only where there is provably
   no route: outside the window on `STANDARD_ONLY`, or in a conversation the customer never started.
   Outside the window on `HUMAN_ASSISTED_EXTENDED` it answers `true`, because that route ends in a person's
   decision. WhatsApp is answered `true` and left to the engine: its adapter is Phase 4 and not on this
   branch, and guessing a provider rule from here would be a second implementation of it.

   **The crash window, which is why the claim answers `ALREADY_SENT`.** A worker that scheduled an
   attempt's delivery and died before recording it leaves a `PENDING` row whose lease lapses; the next
   claim would spend a fresh attempt and schedule a *second* operation for one silence, and nothing
   downstream can deduplicate two operations because their identities differ. So a claim first asks whether
   the previous attempt already produced a draft — by that attempt's generation key, not the first's — and
   settles the follow-up from what that draft actually did: an operation exists, so record it; a draft with
   no operation means the policy held it, so settle `REVIEW_PENDING` rather than retry a question that has
   an answer.

   **The third gap, found by the end-to-end test rather than by reading.** With everything above wired
   correctly, no follow-up could still be sent. Meta's automated-response budget —
   `INSTAGRAM_ADAPTER.md`'s "no later than about 25 seconds after the latest **triggering inbound**" — was
   applied to every automated send, and a follow-up's anchor is hours or days old *by design*. Every
   follow-up reached `DEADLINE_MISSED`, asked a person to review a message nobody was waiting for, and was
   then cancelled `REVIEW_PENDING` by the next claim. A send that answers no inbound message now declares
   itself `proactive` and carries no dispatch deadline, at both gates that read one; the 24-hour standard
   messaging window is untouched, still counted from the customer's own last message, and still refuses a
   proactive send made outside it. The flag is set only where it is true, so a send that forgets to declare
   itself keeps the deadline and is held rather than quietly losing a provider rule. Recorded in
   `GOALS_FOLLOWUPS.md` and `INSTAGRAM_ADAPTER.md`; it is a reading of the spec's own wording rather than a
   new rule, and it is called out for the reviewer as the one send-path behaviour this repair changes.

   **The regressions the directive asked for, and what each one owns.** `followup-sweeper.test.ts` (the
   pass: what is enqueued, what is not, an `ALREADY_SENT` claim producing no job, a failed enqueue leaving
   the claim claimed and logging the error's name only); `delivery-policy.test.ts` (the deadline is still
   derived for a reply and absent for a proactive send — the negative control that proves the budget was
   scoped, not deleted); `ai-draft-handler.test.ts` (a send is recorded under the disposition's own
   operation id, and nothing is recorded for a held draft, a skipped one, an operation-less "scheduled"
   one, or any trigger that is not a follow-up); `followup-channel.test.ts` (what the window
   question answers, and the controls that keep a `false` from silencing a chase something could carry);
   `followup-store.integration.test.ts` (the crash window, concurrent claims, the lease, the claim asking
   the channel before spending an attempt and with the facts it read under the lock, and cancellation
   driven through `appendInboundMessage` and `takeOver` rather than through the helper, because a
   cancellation helper with no caller is this same defect class); `human-task-store.integration.test.ts`
   (both paths that set an assignee, and the read withholding a foreign name through either column, after
   a revoked grant and for a row written past the store); and `followup-slice.integration.test.ts` on a
   real PostgreSQL and a real Redis (a due row becoming exactly one queued job, the lease keeping the next
   pass off it, one draft and one scheduled operation the follow-up names, a dead worker's operation
   recovered rather than a second one made, an ordinary reply to the same old message still held, nothing
   queued and no model asked once the window closed with no route left, and no job at all once the customer
   replied or a person took over). Eighteen mutations applied to the production code; seventeen killed by
   the suite that owns the behaviour, and the one survivor is an empty-`IN` short circuit that no guarantee
   rests on, documented as the optimisation it is.

1. **P5-04 / Issue #30 — thirteen blockers on PR #79 across three reviews and two directed repairs, all
   repaired.**

   **The stale-proposal dead end, directed at `e3210e88…`.** Two admins, one screen: A composes a change
   that widens something against version N, B saves, A submits. The CONFIRM gate refuses *before*
   `savePolicy`, so the CONFLICT path that re-stamps a proposal never ran — the refusal handed A's values
   back still at version N, the page saw a stale proposal, withheld the acknowledgement and the seal, and
   the form re-posted version N for ever. It failed closed, which is the right direction, and it never
   converged, which is the defect: the screen promised a recovery that could not complete, and two pieces
   of copy said so in as many words.

   The fix is one idea: **the review is always a triple — the owner's values, the version stored now, and
   the impacts those values have against that version.** The refusal mints that triple and the gate
   verifies it, so a refusal is a usable review rather than a repetition. Three things follow:

   - a refusal hands back the values rebased onto the current version, with the summary recomputed against
     it, so submitting again completes instead of looping;
   - a seal stops verifying the moment anybody else saves — **including a change that leaves the impact
     list identical**, which a seal over the version the *form* carried could not tell apart and left to
     the store's conditional write as the only guard;
   - the two gates stay distinct questions. "Did you see this summary" is the seal; "is this still the
     state you saw" is the store's versioned write. Neither stands in for the other, and the write is
     still refused when a form names a version that is not the stored one.

   The copy was wrong as well as the flow, and that is fixed with it: the "tick the box to save them"
   sentence no longer renders when there is no box, and the button says *re-check these values against the
   current settings* in the state where pressing it does that, rather than "Save anyway" for a save the
   gate would refuse.

   **A follow-up on that copy fix, because the first version of it was complete-looking rather than
   complete.** The checkbox is withheld for five reasons and the sentence that names it weighed only one of
   them, so a reader without permission to edit, a URL carrying impacts but no seal, and a profile with no
   stored policy were each still told to tick a control that was not on the page — the worst of them
   showing "You are seeing what is in use" and "Tick the box to save them" at the same time. The rule was
   written in a comment beside the sentence, in those words, and was simply not the rule the code applied.
   It is one predicate now, `acknowledgementOffered`, asked once for the control and for the sentence that
   names it, and tested for each missing piece.

   **Found in the same pass, reported rather than fixed at the time, and now closed as Astra's first
   R5-final blocker:** `policyImpactsOf` modelled **no impact at all** for widening the WhatsApp template
   allowlist once `TEMPLATE_AUTOPILOT` was already the stored policy — the allowlist sub-check sat inside
   an arm guarded by `before.whatsappAfterWindowPolicy !== "TEMPLATE_AUTOPILOT"`, so it was unreachable in
   exactly the state the screen itself produces and warns about. See blocker 8 below for the repair.

   **Reviewed head:** `0b62c9e870b260642cb07d386198870c1f1e659f`. The persisted exact-head run was green
   and covered none of the seven cases, which is the usual shape of these findings: every one of them is
   a gap *between* two correct pieces, and a gap has no failing test until somebody writes one.

   **1. Policy changes had no role authorization.** `ONBOARDING_UX.md` says workspace roles constrain
   policy changes, and connecting a channel already enforced that; changing the automation policy did not.
   `requireBusinessProfileContext` proves membership and profile visibility, which is not permission, so
   an AGENT holding a perfectly valid context could switch the workspace to AUTOPILOT and have it audited
   as a legitimate change. `savePolicy` now requires `WORKSPACE_ADMIN_ROLES` **before it reads the row** —
   deliberately before, because a store that checked the row first would answer `CONFLICT` for a wrong
   version and `SAVED` for the right one, which tells a member without permission what the stored version
   is. The screen renders the settings read-only for anybody else and the action reports `FORBIDDEN`.

   **2. Two tabs silently overwrote each other.** The save read the current row and then wrote by `id`
   alone, and neither the form nor `PolicyEdit` carried a version — so the second tab posted its whole
   form from a snapshot predating the first save, succeeded, reverted fields its author had never seen,
   and left two audit rows deriving `before` from the same stale state. There is now an
   `automation_policies.version` column, `PolicyEdit.expectedVersion` is **required** rather than optional
   (an optional guard is a guard the next caller forgets), and the comparison happens under a
   `SELECT … FOR UPDATE` taken at the top of the save's own transaction. The lock is the part worth
   keeping: without it both savers read the same version at READ COMMITTED, both find their expectation
   satisfied, and the second write still lands on the first one's result — a lost update that no amount of
   version *checking* catches, because the check itself was reading stale data. A `Promise.all` test does
   not prove this; removing the lock leaves it passing, because the two transactions simply run in turn.
   The regression is a barrier: one writer is held open across the other's read.

   **3. The high-impact confirmation could be acknowledged before the summary existed.** The checkbox was
   rendered on every load and the server only asked whether `confirm=on` had been posted, so "show the
   effect summary before save" was skippable by ticking it first — and when the save *was* refused, the
   redirect carried only impact codes, so the form was rebuilt from **stored** values and the summary
   ended up describing a change that was no longer on screen. The acknowledgement is now the summary's own
   checkbox, its value is the exact list of impact codes the server computed, and the server compares
   sets: acknowledging fewer, more, or a different set is refused again. The refused proposal travels in
   the URL and the form renders from it, so the summary and the values being confirmed are the same
   thing. The proposal carries the version it was composed against, so an acknowledgement cannot be
   carried across somebody else's change either.

   **4. "Custom" timing could be selected and not configured.** The selector offered `CUSTOM` and the
   form posted only `timingPreset`, so the store fell back to the previous ranges and selecting Custom
   saved nothing custom. Four range inputs are now on the form — seconds on screen, milliseconds in the
   store — posted only when the preset is `CUSTOM`, because a named preset carries its own ranges and
   sending both is a contradiction the store refuses. They are rendered whichever preset is selected: only
   rendering them for `CUSTOM` would mean a round trip before the inputs even appeared.

   **5. The audit UI omitted the values and hid everything past twenty entries.** The store returned
   `before` and `after` and the screen rendered actor, time and impact labels only; the read took the
   newest twenty with no continuation, so the twenty-first change was unreachable from the screen for
   ever. `listPolicyAudits` is now a keyset page over `(changedAt, id)` — both halves, because two saves
   can share a millisecond and a cursor on an instant alone repeats or skips rows, which on a change log
   reads as a change happening twice or not at all. The screen shows both sides of every field that
   *moved*, from a named field list rather than `Object.keys`, so a column added later cannot reach this
   screen with no label and no translation.

   **6. The simulation could not test what it claimed to.** Channel, account health, capabilities and the
   messaging window were constants: every run was Instagram, connected, inside an open free-form window.
   So the WhatsApp selector and template allowlist could never affect the result, neither Instagram
   after-window choice was ever exercised, and the screen still described the answer as the expected
   send/review path for the saved configuration. A playground that silently tests one path of several is
   more misleading than one that tests none, because its answer looks complete. All three are explicit
   inputs now, the chosen channel's own after-window policy is used (the union is per channel precisely so
   a WhatsApp conversation cannot be judged against an Instagram policy), and the result states which
   inputs produced it. `AFTER` is modelled as an expired window rather than `NOT_ELIGIBLE`, which would
   short-circuit the gates the run exists to exercise.

   **The re-review at `d67da89e…` closed findings 1, 2, 5 and 7 and kept three.** All three are now fixed,
   and the third one corrects a judgement of mine rather than only a defect.

   **The acknowledgement needed a server-issued proof, not a comparison.** Comparing the posted impact
   codes against the freshly computed ones is necessary and not sufficient: the codes are public — URL,
   page, translation catalogue — so a first crafted POST naming the right code satisfied the comparison
   with no summary ever rendered, and "the page only renders the checkbox after a refusal" is a statement
   about one caller of a public endpoint. The refusal now mints an HMAC seal over the encoded proposal, the
   version and the sorted impacts (`proposal-seal.ts`, `AUTH_SECRET`, compared with `timingSafeEqual`), and
   the save accepts an acknowledgement only with a seal it minted. Stateless rather than a persisted
   pending proposal: a table would need an owner, a lifetime, a cleanup policy and an answer for two tabs
   proposing at once, and what is being authenticated already travels with the request.

   **An invalid Custom submission was reported as a success, and a test of mine said that was correct.**
   The permanent case read "sends nothing when a custom range is only half typed" — so a repair-directive
   requirement was contradicted by a green suite, which is the trap of a test quoting a spec and asserting
   its opposite. It refuses now, with three outcomes, and the bounds are shared with the form's own
   `min`/`max`. The same hole sat three lines below the fieldset: `takeoverPauseHours` omitted a cleared
   box, the store kept the stored hours, and a crafted `100000` was eleven years of silence accepted as a
   deliberate choice.

   **The allowlist: I argued a limitation where the mechanism already existed.** My previous note said
   making the playground decide template routing would be a second implementation of a send rule. The
   premise was right and the conclusion was wrong, because `templateRoute` — two settled booleans computed
   where the catalogue is, never inside the engine — is this chain's own design for exactly this question.
   It is implemented here: `TemplateRoute` and the optional `PolicyInput.templateRoute`, an
   `evaluateTemplateGate` in which `TEMPLATE_REQUIRED` is a review item a person can resolve while
   `NO_ELIGIBLE_TEMPLATE` is a dead end, the reason code itself, and a simulation that computes
   `automatable` from the owner's **saved** allowlist. Empty versus non-empty now decides `SKIP` against
   `SCHEDULE`, and the three WhatsApp modes are distinguishable — asserted in the engine's own suite, where
   a policy rule belongs.

   **The bug that was the real cause.** I had mapped "after the window" to an expired free-form window for
   both channels. WhatsApp's closed service window is `TEMPLATE_ONLY`, which is the state the template gate
   keys on — so the gate never ran, and nothing done to the allowlist could have changed an answer.
   Instagram's closed window stays an expired free-form one, because its after-window policy is about what
   may still happen then.

   **Six more came from my own adversarial pass before sending the evidence**, and two were as serious as
   anything in the review: the playground's GET form replaced the whole query and so silently destroyed a
   pending proposal — while the history link three hundred lines away obeyed the opposite rule *and had a
   test saying why*, one rule with two implementations and the untested one losing state; and the audit
   diff sorted every list and compared the *rendered* line, so a criteria reorder or a criterion split in
   two wrote an audit row whose diff rendered empty — a history entry asserting a change and showing none.
   The comparison is on a JSON encoding now, and only the two lists the store itself treats as unordered
   are sorted. Also: the page held both versions and compared them nowhere; "show earlier changes" carried
   the playground's question and so billed a model request per page of history; and the length bound
   covered one of the three free-text fields that share the proposal parameter, which is a bound on
   nothing.

   That last pair needed a fifth input to be provable at all. `HUMAN_ASSISTED_EXTENDED` opens a human-only
   review path only while a human-support exception is live, and the exception was hard-coded unavailable
   — so both Instagram choices produced the same `WINDOW_CLOSED` and nothing selected on this screen could
   change a single answer. It is an explicit input now, and the only one whose default is the conservative
   value: an exception is something a business has to have been approved for, and assuming it would show
   an owner a review path their account may not offer.

   **The concurrency proof is deterministic, by directive.** The barrier in "does not lose a write that
   commits between the read and the update" synchronised with `setTimeout(250)`, which is a guess about how
   the host scheduled two connections rather than a fact about the database. Under the full parallel suite
   the guess was sometimes wrong and the case then reported a lost update that was really a race inside the
   test. Where that was observed matters, so it is recorded precisely: on the **propagation tree**, where
   this branch is merged into the chain tip and the `@omnichannel/db` suite is 1,078 cases, one of three
   identical runs failed. On this branch's own 460-case suite the race does not lose — six consecutive full
   runs pass, and so does the timed version under two suites in parallel. So the repetition here is not
   what makes the repair sound; the argument is structural, and the merged tree is what proves the
   assumption can be false in this repository at all. In the one regression that distinguishes a real row lock
   from a version check reading stale data, that is worse than having no case: a flake there teaches the
   next person to re-run rather than look.

   It now waits for the state it depends on: a backend observably blocked on the **holding transaction's
   own id**, read from `pg_locks`. Keyed to that transaction rather than to "some lock is ungranted
   somewhere", because the broad form is satisfied by an unrelated suite's contention and would reintroduce
   the race it replaces. Bounded, and it throws if the barrier never forms, so the case cannot pass for the
   wrong reason. Still load-bearing: deleting the `FOR UPDATE` from `savePolicy` fails it.

   **Two defects found, measured, and deliberately not fixed here.** Both are reported on the PR rather
   than repaired, because this repair is scoped to named blockers and widening it would make the diff
   unreviewable against them.

   - **Nothing in production created an `automation_policies` row.** Reported here, and now closed as
     Astra's second R5-final blocker — see blocker 9 below. The measurement in this note was close: the
     fixtures that collided with `automation_policies_profile_default_key` turned out to be **14 files**
     (5 in `packages/db`, 5 in `apps/worker`, 1 in `apps/web`, plus the three suites whose own cases were
     about the absent row), not the 20 + 8 estimated from the grep.
   - **The send path still asks "has this policy changed?" with `updated_at`.**
     `delivery-store.ts policyUnchanged` compares a `TIMESTAMP(3)`, which is the mechanism this branch's
     own migration rejects for that exact question — two writes inside one millisecond compare equal.
     `version` is now the precise answer, so this is one rule with two implementations and the weaker one
     is in the send path. Harmless today, because every write moves both. Not changed here: it is a
     reviewed send gate, and a send gate is not something to alter inside a repair about a settings
     screen.

   **7. The coordination documents contradicted each other.** See the table above; both files now say the
   same thing, and the queue names #79 as current work rather than #78.

   One thing worth carrying forward: the version rule now has **one** implementation. `expectedVersionOf`
   moved to `apps/web/src/server/form-fields.ts`, which Knowledge, Style and AI settings all read from. It
   is deliberately strict — `Number.parseInt` is happy to read `2` out of `"2; DROP"`, and a guard whose
   refusals depend on the shape of the attacker's string is not a guard.

   Every new guard was mutation-checked: removing the role check, the version comparison, the row lock,
   the acknowledgement comparison, the version refusal in the action and the `CUSTOM`-only timing
   condition each fails a named test.

   **8. Widening an already-enabled WhatsApp template allowlist was not a material change.** Astra's
   first R5-final blocker, and the finding this document had been carrying as reported-not-fixed. With
   `TEMPLATE_AUTOPILOT` already stored, adding a template emitted `impacts: []`: no effect summary, no
   sealed acknowledgement, and an audit row saying nothing material happened. ADR-016 makes an empty
   allowlist permit no unattended template send at all, so the first entry is the dormant-to-live step and
   every later one widens the same unattended authority.

   `TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED` is its own impact code, in both catalogues, compared as a
   **set**: empty→non-empty and any addition are material, removal and reorder are not, a repeated name is
   not a change, and a one-for-one swap *is* one — which is why a length comparison would have been
   wrong. It is an `else if` beside the enablement arm, so enabling the mode and filling the list in one
   edit is one decision with one warning rather than the same consequence stated twice. Nothing in the
   action changed: the gate already refuses any proposal with impacts that carries no server-minted seal,
   so emitting the code is what makes the existing confirmation apply, and the store already recomputes
   impacts for the audit row inside the same transaction as the write.

   **9. A production Business Profile had no automation settings, so this feature had no form.** Astra's
   second R5-final blocker, and the other finding carried here. `createBusinessProfile` created the
   profile and nothing else, `readPolicies` returned `[]`, the page set `stored` from that list, and `form`
   was `undefined` — a profile that is listed, accepts a channel account and cannot be configured, with
   automation stuck at OFF. The permanent policy suite passed because it created the row itself, in a
   helper named `ensureDefault`.

   The default is now written **in the same statement** as the profile, as a nested create, so the two
   rows arrive together or neither does; `ensureDefault` is gone, and the suite runs against the policy a
   real profile has. Not a second call afterwards, because two statements can be interrupted between them
   and what is left behind is exactly the half-made profile; and not lazily on first read, because reading
   settings is open to any member who may see the profile while writing them is OWNER/ADMIN only, so an
   initialization hidden in a read would have to break that boundary. The values come from the domain
   (`defaultAutomationSettings`), not from the column defaults, with a domain test asserting it agrees
   with `createAutomationPolicy` field by field. Migration `20261011090000_profile_default_policy`
   backfills profiles created before this, idempotently by `NOT EXISTS` rather than by an inferred
   `ON CONFLICT` target, because the index that would catch a duplicate is partial.

   The product-path regression starts where an owner starts:
   `apps/web/src/server/settings-screen.integration.test.ts` creates the Workspace and the profile through
   the production path, authorizes an owner, asks the screen's own predicate (`profileDefaultOf`, now
   extracted from `page.tsx` so the test drives the page's rule rather than a restatement of it) whether
   there is a form, asserts the conservative values, and completes the first save against the version the
   form rendered. All four cases fail if the nested create is removed. On the database side,
   `policy-store.integration.test.ts` proves the row is conservative, that a rolled-back creating
   transaction leaves **neither** row, that four concurrent creations get exactly one default each, and —
   asked of the whole database rather than of the rows the case knows about — that no Business Profile
   exists without one.

1. **P5-06 / Issue #32 — the retired-list reachability blocker on PR #78, repaired and PASSED.**

   **Reviewed head:** `66a317fa0330e29b6bed9238286158fde48f9c01`. Astra accepted the database-enforced
   immutability and the per-example lifecycle pagination in full, and returned one blocking reachability
   defect — the one the previous evidence comment had named and deliberately left alone as pre-existing.

   The retired list is archived examples *and* declined suggestions, which are one thing to the person
   looking at them. They were read as two pages and concatenated: `ARCHIVED` consumed the `retired`
   cursor while `REJECTED` was always its own first twenty-five, and the merged page inherited
   continuation only from the archived half. One cursor cannot continue two queries, so the twenty-sixth
   declined suggestion was unreachable by any rendered link — and its lifecycle went with it, because a
   history only opens for an example that is on the page.

   The fix is one query over both statuses rather than a second cursor. `StyleExampleFilter.status` now
   takes one status or several, and the screen asks for `["ARCHIVED", "REJECTED"]` with the `retired`
   cursor. That makes reachability a property of the query rather than an argument about it:
   `(createdAt desc, id desc)` over both statuses is total and stable, so following the cursor visits
   every row exactly once whichever status it has. The merge is deleted rather than repaired.

   One consequence worth knowing: the retired list is now ordered newest-first across both statuses
   instead of all archived followed by all rejected. Every one of the screen's existing tests passed
   unchanged, so nothing accepted was pinned to the old grouping.

   **Regressions:** twenty-eight declined suggestions and three withdrawn examples, walked using nothing
   but the link the screen renders, asserting every row is reached and reached once; the lifecycle of a
   row only a later page reaches is opened on the page that reached it; and the store-level contract —
   several statuses read as one keyset, paged two at a time, arriving once each. Mutation-checked:
   restoring the two concatenated pages fails both screen regressions.

   **Earlier heads in this repair chain:** `d9d1108d7bf974002b686afd32a4c3327d761558` was the docs-only
   handoff commit; `66a317fa0330e29b6bed9238286158fde48f9c01` added the immutability and lifecycle
   repair, both now accepted.

   Five of the six earlier blocker areas are accepted and this repair changes the behaviour of none of
   them: the retired-example UI, the production suggestion/provenance flow, workspace-scoped example
   creation, the Style Test's candidate and context disclosure, and conflict-safe voice-profile writes.
   Four of the five are not touched at all. The fifth is: the retired list's own component, assembler and
   route all carry the history, so `style-example-list.tsx`, `style-screen.ts` and the route gain props and
   a derivation — additively, with the restore branch, the badges and the approver line byte-identical, and
   every one of that file's existing tests passing on its original assertions. The accepted P5-05 parent
   behaviour and the tenant boundaries are untouched.

   The one remaining finding was that the decision history was neither database-enforced append-only nor
   fully retrievable. Both halves are now fixed, and both were the same shape — a guarantee that existed
   as a property of the current source rather than of the system.

   **Immutability is now the table's, not the package's.** `style_example_decisions` was described as
   "append-only by use": nothing in `style-store.ts` updates or deletes one of these rows, and the
   foreign key stops the *example* being deleted while they point at it. Neither is a statement about the
   rows themselves, and the case that matters is precisely the one where this package's source is not what
   is running — a support script, a later migration, a hand-typed `UPDATE` during an incident. Migration
   `20261008100000_style_decisions_append_only` refuses `UPDATE` and `DELETE` with a row trigger and
   `TRUNCATE` with a statement-level one; a row trigger never fires for a truncate, so without the second
   the guarantee would have ended at the one statement that destroys everything rather than editing one
   thing.

   **The lifecycle is complete and reachable.** `MAX_DECISIONS` is still twenty, but it is now the twenty
   *most recent* rather than the twenty oldest, still rendered oldest-first within the window. That is the
   whole defect inverted: the cut used to fall at the newest end, so the events it hid were the ones that
   explained an example's current state. The window reports how many earlier events it left behind and
   carries a `(decidedAt, id)` cursor; `readStyleExampleLifecycle` returns the page before any cursor, with
   the cursor for the one before that, so every decision is reachable by following links the screen
   renders — and every example is, which is the part this paragraph used to qualify. It recorded that the
   rejected half of the retired list had no cursor of its own and that a profile with more than
   twenty-five declined suggestions could not reach the twenty-sixth. That was true when it was written
   and is no longer: item 1 above reads the retired list as **one keyset over `ARCHIVED` and `REJECTED`**,
   so there is no twenty-five-row rejected limit and no second source for a row to fall behind. The
   sentence is corrected rather than deleted, because the sequence matters — naming the gap in an
   evidence comment is what led to it being fixed rather than inherited.

   Both halves of the cursor travel because `decided_at` is not unique — two decisions can share a
   millisecond, and a cursor on an instant alone silently repeats or skips rows.

   Two things an adversarial pass over the first attempt found, both now fixed and both worth remembering.
   **A page read backwards hides the newer half**, so the first version reproduced the blocked defect one
   click later: a history ending in `RESTORED` under a badge reading "Archived", with the number that would
   have said so computed and discarded. The window now reports both of its edges and the lifecycle's whole
   length. And **a plain `CREATE TRIGGER` is origin-only**: `SET session_replication_role = 'replica'` is
   an ordinary statement on this connection and an origin-only trigger is silent under it, so one `SET`
   would have switched the whole guarantee off with no DDL and nothing recorded. Both triggers are
   `ENABLE ALWAYS`, and a regression proves the refusal holds inside replica mode rather than only
   checking the flag. What remains open is DDL on the table by its owner, which no trigger can close; the
   claim is therefore "unrewritable by anything short of DDL", not "unrewritable".

   `StyleDecisionView` now carries the row's `id`, and the rendered history is keyed by it. It was keyed by
   decision-and-instant, which collides for exactly the pair the lifecycle can now contain: a history that
   cannot be *shown* completely is not retrievable completely, whatever the query returned.

   **Regressions added:** direct SQL `UPDATE`, `DELETE` and `TRUNCATE` against `style_example_decisions`
   are each proven rejected, with a control asserting the stored row is unchanged afterwards; a
   twenty-five-decision lifecycle is reassembled page by page through the cursors and compared with the
   whole expected sequence; a lifecycle whose decisions share one instant is paged two at a time and every
   row is seen exactly once; and the screen's own assembly is driven through the links it renders, with a
   forged `historyExample` proving a cursor carries no authority.

   Both repairs were mutation-checked: removing the trigger fails the immutability regression, and
   returning the window to the oldest twenty fails the long-lifecycle regression.

   **The hold on #79 and below is lifted.** PR #78 has an independent PASS at
   `8692d8f35d16256beb819488da9ae5a263a1a3e1`, which was the condition this note was waiting on, and the
   repairs are merged down the chain. No rebase, no force-push, no merge to `main`.

2. **The six original findings on PR #78, repaired at `a3d27e3` and still the basis of the above.**
   
      **Reviewed head:** `5c28dcd73c8f86dea4625326bc53747a0af320ce`.
   **Repaired at:** `a3d27e39d479a5c00ea5ebea2e6af9216e869e17`, exact-head GitHub Actions run
   [37608987350](https://github.com/glebcode1986/omnichannel-ai-setter/actions/runs/37608987350) succeeded.
   This note is the canonical handoff the same directive asked for, so the branch head is one commit later
   than the repair SHA; PR #78 carries the current one.
   
   **That gate is now passed.** The earlier propagation of this repair happened *before* an independent
   PASS, which is why it was held; the PASS at `8692d8f35d16256beb819488da9ae5a263a1a3e1` released it, and
   the chain has been merged down and pushed since. No rebase, no force-push, no merge to `main`, no
   rollback.
   
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
      `style_example_decisions` rows (migration `20261004160000_style_example_decisions`) and never
      re-stamps the first approver, so the lifecycle is reconstructable. That first repair called the
      table append-only when nothing but this package's own source made it so, and bounded the history at
      twenty rows from the wrong end; both are what item 1 above fixes.
   
   **Exact-head verification reported for the repair SHA**, in addition to the successful Actions run:
   clean-environment `pnpm verify` with no database and no Redis; the PostgreSQL and Redis infrastructure
   suites; the webhook-to-queue E2E suite; the evaluation harness with no quality regression; and
   `db:check-drift` reporting `No difference detected.`

1. **Style Training could not show more than 25 of either list (#32).** The third instance of one defect,
   found by checking every paged store list against the screen that spends its cursor after Astra raised
   it on PR #77. `listStyleExamples` pages at 25 and returns a cursor; the route called it twice — once
   for the verified library, once for the suggestions — with no cursor either time, and no component
   offered a link. A suggestion nobody can reach is one nobody can approve or reject, so it stays
   SUGGESTED.

   **What is different here, and what made it worth its own module:** two lists page on one page. A single
   `cursor` parameter would make "show more suggestions" also advance the verified library, so an operator
   paging one would lose their place in the other — a bug that looks like data disappearing. Each list has
   a parameter of its own (`verifiedCursor`, `suggestedCursor`), the next link carries the other list's
   cursor through untouched, and `style-screen.integration.test.ts` asserts exactly that: advancing one
   leaves the other equal to what it was.

1. **The archive a stale Publish could undo (#31 / PR #77, fifth cycle).** Astra confirmed the four
   earlier repairs and found one more, in the same R5 stale-UI class.

   **Archiving leaves the version alone.** That one fact is the whole defect: a tab that rendered Publish
   still carried a matching expected version after another operator archived the source, and the
   conditional write named only the version and the indexing state — so the stale click wrote `ACTIVE`
   over the archive and reported success. A source deliberately withdrawn from retrieval was answering
   customers again.

   The write is now bound to the act the screen offered (`PUBLISH` vs `RESTORE`), refuses a status that
   act does not expect, and names `status` in its predicate so an archive landing in the gap misses. The
   answer is a typed `STALE_STATE`; the screen shows the same "reload and look" sentence a conflict gets.

   **The lesson, again, is the premise.** Three of these five findings were a write conditional on fewer
   facts than the decision was made from. A version is not the only premise a screen renders.
1. **Four P5-05 blockers about reachability and atomicity (#31 / PR #77).** Astra's fourth pass on this
   branch. The previous repair was correct on every path its own tests walked; all four findings were
   about paths they did not.

   **An edited live source had no way to publish its staged version.** The store deliberately leaves an
   edited ACTIVE document at `publishedVersion = 1`, the page rendered the "saved v2, customers are
   answered with v1" warning — and its control branch offered Archive to every ACTIVE document and
   Publish only to DRAFTs. The store could do it and the operator could not reach it. The rule now lives
   in `knowledgeLifecycleOf`: a version that is not the published one is publishable whatever the
   status.

   **A missing version was accepted by the action that claimed to refuse it.** `editKnowledgeAction`
   parsed `expectedVersion` and, when it could not read one, omitted the property — and the store checks
   staleness only when it is present. A form that left the field out therefore edited whatever was
   current and reported `VERSIONED`: the whole stale-tab mechanism, steppable around by sending one fewer
   field. The decision moved to `knowledge-submission.ts`, where it is refused before the store is
   reached and can be run against requests no browser built.

   **Publish was not bound to the version the operator saw.** The form submitted no version, the action
   took no `FormData`, and the store published whatever was current when it started. Two tabs on the same
   draft was enough: one saves, the other clicks Publish, and content nobody reviewed is live under a
   success notice. The version now travels page → control → action → store, and a mismatch is a
   `CONFLICT`.

   **Publishing and recording an indexing failure could race into a raw constraint error.** Both read the
   row, decided, then wrote conditional on the version alone — so each could write the other's premise
   away and produce ACTIVE + FAILED + published-at-this-version, the triple the CHECK refuses. Each write
   now names every column its decision came from: the publish refuses with the sentence the pre-read
   would have given, and the health write re-decides once against the state that replaced it, archiving
   the source whose published version the publish just moved.

   **The lesson:** a correct store plus a correct screen is not a correct product. Three of the four were
   gaps *between* two correct pieces — a control that was never rendered, a field that was never required,
   a predicate that named one of the two facts it read.
1. **Three P5-05 concurrency blockers, two of them introduced by the previous repair.** Astra re-reviewed
   the repaired head and found that separating Save from Publish had not closed the interleavings it
   created. All three were correct.

   **A publish could report success having published nothing.** `restoreKnowledge` writes conditionally on
   the version it read — and discarded the row count, so a save landing in the gap meant zero rows changed
   while the action still mapped the result to `PUBLISHED`. The condition was there and its answer was
   thrown away, which is the mistake `recordIndexingResult` had been fixed for the day before.

   **A save was not bound to the version the form showed.** Two tabs at v1: A saves and becomes v2, B —
   still showing v1 — saves over it with wording composed against content it never saw. `expectedVersion`
   now travels page → form → action → store, the document moves first and conditionally, and the chunks
   are written only if it did. Two simultaneous submits cannot both become v2; the loser gets a conflict
   rather than a unique-constraint error from the chunks' position key.

   **A failure in an unpublished version archived the published one.** After publish/index v1 and Save v2,
   a failure to index v2 — content no customer has ever seen — took the document out of ACTIVE and stopped
   healthy v1 answering. `knowledge_documents_failed_not_active_check` was written when a document had one
   version; it is now about the version customers are answered with, and so is the store.

   **Found while fixing it:** the whole knowledge outcome family — CREATED, VERSIONED, UNCHANGED,
   PUBLISHED, ARCHIVED, RESTORED — was missing from `OutcomeNotice`'s allowlist and from both catalogues,
   so every save and publish redirected with an outcome the page ignored. The operator pressed Save and was
   told nothing, which is indistinguishable from pressing Save and nothing happening. A typed conflict
   nobody can see would have been the same defect in a new place.

   **The lesson:** a conditional write is only half a fix. The other half is reading what it did — and
   saying so on screen.
2. **Three P5-05 blockers, all correct (#31 / PR #77).**

   Three screens now share one shape — `knowledge-page.ts`, `review-page.ts`, `style-page.ts`, each with a
   `*-screen.integration.test.ts` that follows the link it rendered. **The pattern worth keeping is the
   test, not the module:** every one of these bugs was a correct store, a correct component and an
   assembly nobody could call.
2. **A human-composed reply was invisible in its own conversation (#29 / PR #76).** Astra's blocking
   finding, and it was correct. ADR-018 Option B made `delivery_jobs.draft_id` nullable and gave a
   human-composed delivery a direct `conversation_id`, but two read paths still reached the conversation
   through `draft: { conversationId }`: the Inbox's pending sends and the cancellation lookup. So a reply
   a person had just written did not appear in the thread, `cancelSend` answered `GONE`, and the row sat
   `SCHEDULED` and went out — the operator was told their reply was not queued, and then it was.

   Both now spread `deliveryOfConversation(conversationId)` from `packages/db/src/delivery-origin.ts`,
   one place that knows what "belongs to this conversation" means for either origin. A third instance of
   the same mistake was found while fixing it: the reconciliation sweep's orphaned-row query selected the
   conversation only through the draft, so an ambiguous human-composed send was raised with an empty
   conversation id — which the queue's payload schema rejects, so it was never raised at all.

   **The lesson, for the next nullable relation:** making a column optional is not the change. The change
   is every query that assumed it was there, and the compiler cannot find them because a relation filter
   that matches nothing is still valid. Grep for the relation, not for the column.
2. **Stage D is open across six stacked branches**, each CI-green with evidence posted:
   #73 (P5-01 shell/onboarding), #74 (P5-10 EN/RU), #75 (P5-02 Inbox), #76 (P5-03 review + composer,
   now complete), #77 (P5-05 Knowledge), #78 (P5-06 Style), #79 (P5-04 AI settings + simulation).
   `feat/p5-07-leads-pipeline` carries the P5-07 store and is not yet a PR.
2. **Fixes go to the earliest affected branch and merge down the chain.** No rebases, no force-pushes,
   no merges to `main`.
3. **P5-07 / Issue #33 (Leads) is the open work.** Its store, migration and tests are committed; the
   kanban and table views are not built yet. One product question is open: the spec allows a Workspace to
   *add* stages, which would require `LeadStage` to stop being an enum — and the draft engine returns one
   in its structured output, so that is a decision, not a display preference.
4. Every surface must take its text from `apps/web/src/i18n/catalogue.ts`; `no-unlocalized-strings.test.ts`

1. **#54 / P3-01 is the latest work**, as PR #81 on `feat/p3-01-customer-identity-memory`, stacked on
   P5-07. It adds the customer identity and durable-memory primitives with no UI; see
   `docs/specs/CUSTOMER_IDENTITY_SEARCH.md`, which the issue referenced and the repository did not have.
2. **PRs #73–#81 are awaiting review.** All are CI-green with evidence posted. Fixes for any of them go to
1. **#55 / P3-02 is the current work**, as PR #82 on `feat/p3-02-goals-followups`, stacked on P3-01's
   accepted head `13212612bb0ac73b2468c1adc99b1c5e48008c16`. Conversation goals, bounded follow-ups and
   human tasks, with no UI; see `docs/specs/GOALS_FOLLOWUPS.md`, which the issue referenced and the
   repository did not have. **It was reviewed CHANGES_REQUESTED and both P1 blockers are now repaired** —
   the missing executable path and the assignee who cannot reach the profile — plus the provider-deadline
   gap the end-to-end test exposed; see the P3-02 entry above for all three.
   - Every follow-up is revalidated at execution rather than at planning, and a `READY` claim goes to the
     **shared delivery coordinator**. There is no second send path.
   - What makes one happen is `apps/worker/src/followup-sweeper.ts`, which enqueues the same AI-draft job
     an inbound message does. Without it the whole feature was unreachable, which is what the first
     blocker was. A claim it cannot enqueue is left claimed: the lease is what makes that safe.
   - Attempts are bounded by CHECK constraints (1–5), so "no unlimited chasing" survives a careless
     caller, a migration and a console session.
   - `human_tasks` has no draft, operation or delivery column at all, which is how "completing a task
     never messages a customer" holds without anybody remembering it.
2. **#54 / P3-01 is accepted** at `13212612bb0ac73b2468c1adc99b1c5e48008c16`; see
   `docs/specs/CUSTOMER_IDENTITY_SEARCH.md`.
3. **PRs #73–#82 are awaiting review.** All are CI-green with evidence posted. Fixes for any of them go to
   the earliest affected branch and merge down the chain.
4. **The chain was repaired on 2026-09-30.** PR #76 gained its second commit — the human composer, on the
   owner's `FINISH_HUMAN_COMPOSER` directive — *after* #77 had been cut from it, so #77 through #81 were
   all missing the human-composed send path. It has been merged down through #77, #78, #79, #80 and #81 in
   order, each verified and pushed. Check ancestry, not just the PR base, before building on a branch:
   `git merge-base --is-ancestor <parent> <child>`.
5. **P5-08 / Issue #34 (Analytics + Audit) is next after #82**, per the owner's directive on PR #81, and
   #35 P5-09 (E2E, accessibility, responsive) follows it. Analytics must count the human-composed send
   path as well as the automated one, which is the reason the repair above came first.
6. One product question is open from P5-07: the spec allows a Workspace to *add* lead stages, which would
   require `LeadStage` to stop being an enum — and the draft engine returns one in its structured output,
   so that is a decision, not a display preference.
7. Every surface must take its text from `apps/web/src/i18n/catalogue.ts`; `no-unlocalized-strings.test.ts`
   fails the build otherwise. New Inbox panes are also held by
   `apps/web/src/ui/inbox/no-provider-payloads.test.ts`, which fails if a pane imports a channel package
   or names a provider payload type. New tables are held by the cascade guard in
   `packages/db/src/constraints.integration.test.ts`: only login data and grants may cascade, so a new
   foreign key is `ON DELETE RESTRICT` and removal is an explicit, auditable act.
8. No rebases, no force-pushes, and no merges to `main`.
9. Continue architecture/product design in parallel without letting future prepared phases bypass dependency
   gates.

Historical note: the original launch sequence (review #2, then launch #3 from a merged `main`) was
superseded by the owner's stacked review-lag mode. Those tasks are implemented and are in the chain above.
