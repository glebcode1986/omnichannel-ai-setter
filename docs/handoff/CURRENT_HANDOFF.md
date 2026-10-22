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

**The chain now runs to #100 plus the P6-09 branch**, each branch stacked on its predecessor and each
CI-green with evidence posted. PRs #79–#100 are completed by Claude and awaiting review; **P6-09 / Issue
#47 is the current task**. Everything in Phase 1 and Phase 2 has an independent PASS at its published
head, including **#72 / P3-03 at `9955ecf6c114145d54bb7dd46abbc902267bd00c`**, **#71 / P2-09 at
`38df858508ec61e2c6821e47a0a5225c86768223`**, **#70 / P2-08 at
`c15a9a6f558d9270263ad7573669f76ca3af8ac0`**, **#69 / P2-07 at
`4c9f496d805316ded56311e41bdd4c3c39ff5a43`** and **#68 / P2-06 at
`fb35665209b90c82bc10f3068450111e75f83299`**; all are propagated downstream. Nothing is merged to `main`.

Everything is unmerged PRs stacked by base — but **not one chain. Two live segments**, which was measured
on 2026-10-13 and had been assumed otherwise until then:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`
` -> #73 -> #74 -> #75 -> #76 -> #77 -> #78 -> #79 -> #80 -> #81 -> #82 -> #83 -> #84`
` -> #85 -> #86 -> #87 -> #88 -> #89 -> #90 -> #91 -> #92 -> #93 -> #94 -> #95 -> #96 -> #97 -> #98 -> #99`
` -> #100`

Phase 6 continues the same chain: #95 (P6-01, Issue #38), #96 (P6-02, #39), #97 (P6-03, #40), #98 (P6-06,
#43), #99 (P6-05, #42), #100 (P6-08, #46) and the P6-09 branch above (#47). **#41 / P6-04 is blocked** on the owner's choice
of first production provider and selling jurisdiction; it is the only Phase 6 issue that cannot be
implemented without that decision. #44 (P6-07, commercial E2E) depends on the chosen adapter path, so after #47
the only Phase 6 work left needs the owner's provider decision.

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
| #83 | P5-08 operational analytics and searchable audit | #34 |
| #84 | P5-09 UX end-to-end, accessibility and responsive pass | #35 |

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

6. #62 (#37): the GitHub Actions `pnpm verify` gate. It is **live** at `.github/workflows/verify.yml` and green on every pull request in this chain; the owner pushed the activation commit after the implementation credential was refused the `workflow` scope. What is still open on Issue #37 is only that `main` has no `push` run yet, because nothing is merged there by design.

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

## Correction — what is true on 2026-10-19

This file is append-only, so sections below state the position on the day they were written. The claims
that **#83 and everything below is frozen** and **still carries the pre-repair #79** are no longer true:
the chain was propagated link by link on 2026-10-19, #80 through #94, fifteen heads, each with its own
green exact-head Actions run and each verified to contain its parent with
`git merge-base --is-ancestor`. The accepted SHAs named in older sections are superseded too — #80 is
accepted at `55e368d`, #81 at `d3ad503` and #94 at `df77cd7`, all by formal exact-head review.

The dated statements are corrected in place rather than deleted, because what was believed when is part
of the record.

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
| #82 | `feat/p3-02-goals-followups` | **Was the current gate when this row was written, and CHANGES_REQUESTED, now repaired.** Two P1 blockers: the follow-up feature had no runtime caller at all, and a task could be assigned to somebody with no access to the Business Profile. Both closed, together with a third gap the end-to-end test found — the automated-response budget being applied to a send that answers nothing. The accepted #81 parent `d9a34ffef120b7f0b171eb12f130d3848c9928cf` is merged in by ordinary merge commit, and at that date this was the only branch below #81 it had been propagated into. **Both facts have since changed:** #81 is accepted at `d3ad503` and the chain was propagated to #94 on 2026-10-19. |
| #83 and below | `feat/p5-08-…` through `feat/p7-02-…` | **Was frozen** and not ready for review *at that date*, as the chain's *second live segment*, forked from `c098c18` and still carrying the pre-repair #79. **No longer true:** every link to #94 now carries the #79 repairs and everything after them, propagated link by link on 2026-10-19, and each link contains its parent. Each propagation directive permits one step only, so nothing below #82 may receive this parent until #82 itself passes. On 2026-10-13 every head here moved twice, for two repairs that had nothing to do with their own features: #90's red CI, and the nine fixture clocks. Both are recorded below; neither advanced any feature. |
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
parent one branch at a time, so at that date #81 and below still carried the pre-repair #79 and each
needed this merged down in turn. That propagation completed on 2026-10-19, through #94. Do not read the #78 propagation described in the next paragraph as covering these —
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
   driven through the ingestion store's `recordActivity` and `startHumanTakeover` and through `takeOver`
   rather than through the helper, because a
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

1. **P6-09 / Issue #47 — the acceptance control, and the evidence behind it.** Branch
   `feat/p6-09-terms-acceptance-ux`, based on #100. The checkout step is now a real surface:
   `settings/billing/checkout`, with the seller's legal identity, the price, who remits the tax, and one
   unticked checkbox per required document version.

   **#46 left the store and the database disagreeing about what "accepted" means, and a probe proved it.**
   `readLegalDocumentOffers` filtered documents by an *exact* locale, so a Russian-reading workspace was
   offered **no documents at all** — `missingAcceptances([], [])` refused nothing, a contract with zero
   acceptances was written, and the deferred coverage trigger killed it at COMMIT with a raw Postgres
   exception. Not a refusal: a 500. The trigger was the only thing standing between that and a silent
   bypass, which is the strongest argument for it the chain has produced.

   The fix has two halves and they have to agree: locale negotiation in the store (exact tag → same
   language, another region → the fallback the product publishes everything in), and
   `legal_acceptances.locale` recording the language of the *page* somebody accepted on — which is not the
   document's locale, and is the fact a dispute actually asks about.

   **Specificity now dominates language, in both implementations.** Choosing the locale first handed a
   Russian reader the platform's generic offer whenever the selling entity had published its own in
   English alone — for a checkout whose contract names that entity. A kind the seller has published at all
   is read only from the seller's own versions, in `readLegalDocumentOffers` and in
   `current_legal_documents()`, and a test holds the two derivations against each other.

   **`contentRef` had to become a URL.** Every value written under #46 was a path fragment, and as an
   `href` on the checkout route a fragment resolves to a page that does not exist — a checkbox asking for
   consent to something unreadable. Now `https` only, enforced in `publishLegalDocument` and by a CHECK.

   **Two refusals that used to be one.** `TERMS_NOT_ACCEPTED` means a box was left unticked;
   `DOCUMENT_SUPERSEDED` means the terms changed while the page was open — including a requirement that
   *appeared* after it was drawn, which the form distinguishes by declaring the ticks it rendered in a
   hidden `offered` field. Without it the store blames somebody for a control they never saw.
   `PROVIDER_UNAVAILABLE` moved to **last**, after the acceptance checks: checked first, it refused every
   checkout in every real process and made the terms enforcement unreachable — and would have made its
   own test green for the wrong reason.

   **`CHECKOUT_AVAILABLE = false` is gone.** It was a constant, so the entire acceptance surface was
   unreachable however a deployment was configured, and somebody would have had to remember to edit a
   file on the day an adapter landed. It is now derived — at least one enabled route whose provider has a
   registered adapter — and `PlanOffers` links to the checkout exactly when that is true, asserted in both
   directions.

   Two traps worth remembering: a parameter named after a column is **silently** shadowed by it in a SQL
   function (`d."seller_profile_id" = seller_profile_id` compared the column to itself and made every
   seller's documents applicable to every seller — caught by #46's own suite), and `semantics.test.ts`
   accepts `htmlFor` only as a double-quoted *literal*, so a dynamic checkbox group has to wrap each input
   in its own `<label>`.

   **A refused attempt deliberately writes nothing.** The contract id *is* the attempt reference, and an
   attempt that was refused offered nothing to consent to; recording "they did not tick a box at 14:02"
   would be surveillance rather than evidence. Stated in `BILLING_ROUTING.md` so it reads as a decision.

   **Not in this issue:** no payment redirect — the step records the contract and stops, because where the
   customer goes next is the adapter's, which is #41.

1. **P6-08 / Issue #46 — seller profiles, payment routing and legal acceptance.** Branch
   `feat/p6-08-billing-routing-seller-profiles`, based on #99. `docs/adr/ADR-019` is brought into the
   chain from `origin/docs/phase6-commercial-billing`; `docs/specs/BILLING_ROUTING.md` records how each of
   its rules is enforced.

   **A browser redirect cannot activate a paid entitlement, structurally.**
   `recordVerifiedBillingEvent` takes a `VerifiedBillingEvent`, and the only values of that type are the
   frozen objects `packages/db/src/billing-events.ts` mints into a module-private `WeakSet` — the
   `tenancy.ts` pattern. Minting happens in two functions and both go through a registered provider
   adapter: one authenticates a raw signed delivery, the other asks the provider what it says is true.
   Casting does not help. The shape of this mistake is a `/billing/success` handler that looks correct and
   is only missing authority nobody noticed it did not have, so a rule in prose would not have held.

   **The client has no parameter in which to name a route, a provider account or a seller entity.** A
   checkout asks for a plan version, an interval, an arrangement kind and a currency; the route is read
   from operator configuration. That is a stronger statement than validating an identifier would be, and
   the suite asserts it by passing forged fields and checking where the contract landed.

   **One live charge path per workspace, as a partial unique index.** `PENDING` counts as live, because a
   second checkout completing while the first is open is exactly how a customer ends up on two providers.
   A provider switch is `supersedeCurrent: true` — it ends the old arrangement, records `supersededById`
   and keeps its `providerReference` for reconciliation, in one transaction. Without the flag a second
   checkout is refused: the default *is* the rule.

   Two things fell out of the database rather than from the issue:

   - **The index predicate had to be spelled as two inequalities.** PostgreSQL rewrites
     `state IN ('PENDING','ACTIVE')` into `= ANY (ARRAY[...])` with casts, and `db:check-drift` then
     reports a changed index on every run. So the predicate is "not ended and not superseded", a state
     added later counts as live until somebody says otherwise, and the suite asserts which states collide.
   - **`ALTER TYPE ... ADD VALUE` needs its own migration** when a later statement in the same file
     *uses* the new value. The two audit kinds are added in `20261007205000_billing_routing_audit_kinds`
     because the next migration rewrites `audit_events_scope_check` to name them, and one file would fail
     with 55P04 on an empty database.

   **The catalogue's price book stays ISO 4217.** `plan_prices_currency_check` refused a `USDT` fixture,
   and the constraint was right: a crypto charge is a *quote* in an asset against a EUR-priced plan, not a
   second price book. A route's `currencies` are therefore the **base** currencies it can take a charge
   for, and the asset lives on the quote — which is what "the quote does not rewrite the plan's meaning"
   amounts to in the schema.

   **Acceptance is a deferred constraint trigger.** The acceptances carry a foreign key to the contract,
   so the contract is written first and a plain `AFTER INSERT` trigger would fire before any acceptance
   could exist. Which kinds are required is read from `required_for_checkout` on the documents, not from
   the route, because which documents a market requires is a legal decision the owner has not made.

   **`apps/worker/src/billing-sweeper.ts` releases the slot an abandoned checkout holds.** Without it the
   one-live index becomes a trap: one unfinished attempt would refuse every later purchase until somebody
   read the table. `loops` in `worker.started` gained `checkout_expiry`.

   **Not in this issue:** no provider adapter is registered outside tests (#41, blocked on the owner's
   provider and jurisdiction choice), and the checkout UI with its acceptance control is #47 —
   `CHECKOUT_AVAILABLE` is still `false`.

1. **P6-05 / Issue #42 — the billing screen.** Branch `feat/p6-05-billing-settings-ui`, based on #98.
   `readBillingOverview` drops `providerPriceId` and the opaque customer/subscription references by
   construction, in one function, and `no-provider-payloads.test.ts` now covers `ui/billing` and fails on
   those three field names. `requestCancellation` and `resumeSubscription` are narrow and OWNER-only and
   never move the plan: a general setter reached from a browser action would let a customer cancelling
   change tier. `CHECKOUT_AVAILABLE = false` until a provider exists.

1. **P6-06 / Issue #43 — the accepted catalogue as data.** Branch `feat/p6-06-commercial-catalog`, based
   on #97. Prices moved off `plan_versions` into `plan_prices`, which meant **rewriting
   `plan_versions_immutable()`**: it named the three dropped columns, so every update to a plan version
   would have failed with a missing-field error. Add-on versions and all catalogue prices are immutable by
   trigger; `workspace_addons` takes the entitlement key, because `readEntitlement` reads it.

1. **P6-03 / Issue #40 — enforcing entitlements where the money is spent.** Branch
   `feat/p6-03-entitlement-enforcement`, based on #96. Three reason codes (`BILLING_INACTIVE`,
   `BILLING_FEATURE_OFF`, `BILLING_LIMIT`), and the delivery claim re-resolves the entitlement inside its
   own transaction under `entitlementLockKeyFor(workspaceId)` — a trial's last day can end while a reply
   waits out its delay, and no row moves.

   **`subscribed` had to be separate from `paidWorkAllowed`.** A capacity check that folded in payment
   would make the first Business Profile impossible, and creating it is what starts the trial. So
   `capacityVerdict` and `featureWithheld` ignore payment and a workspace with no plan withholds nothing.

   **Every seeded workspace is now subscribed.** Without that, suites about credentials or onboarding were
   silently testing the billing gate instead of their own subject.

1. **P6-02 / Issue #39 — the usage ledger.** Branch `feat/p6-02-usage-ledger`, based on #95. Counting is
   keyed on a logical operation identity fixed *before* the work starts, so a provider retry, a schema
   repair and a requeued job are one cycle. `AI_GENERATION_CYCLES` is internal, not a quota: core replies
   are included and unmetered, and there is no path by which an exhausted allowance could hold a reply.

   **Three PostgreSQL facts that cost a cycle each, and are now written down:** `INSERT ... ON CONFLICT DO
   UPDATE` validates CHECK constraints against the *proposed* tuple even when the conflict path runs; a
   failed statement aborts the whole transaction, so "insert and catch the duplicate" leaves everything
   after it failing with `25P02`; and `pg_advisory_xact_lock` returns `void`, so it has to be called as
   `SELECT true AS locked FROM pg_advisory_xact_lock(...)`.

1. **P5-06 / Issue #32 — PR #78 has an independent PASS, and this branch carries it.**

   **PASSed head:** `8692d8f35d16256beb819488da9ae5a263a1a3e1`. That PASS is what released the hold on
   #79 and everything below it, which is why this repair is now merged down the chain rather than held at
   #78. The history of the three repair cycles is kept below, because each one is a defect class worth
   recognising again; what changed with the PASS is only that none of them is outstanding.

   The last cycle's finding was retired-list reachability. Astra had accepted the database-enforced
   immutability and the per-example lifecycle pagination in full, and returned one blocking defect — the
   one the previous evidence comment had named and deliberately left alone as pre-existing.

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

   **Heads in this repair chain:** `d9d1108` was the docs-only handoff; `66a317f` added the
   immutability and lifecycle repair; `9ccb4c9` read the retired list as one keyset; `8692d8f` corrected
   the handoff paragraph the repair had made false, and carries the PASS.

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
1. **P6-01 / Issue #38 — plan, subscription and entitlement primitives.** Branch
   `feat/p6-01-plan-entitlements`, based on #94. The first of Phase 6.

   **The Phase 6 specs existed but were never in the chain.** `BILLING_ENTITLEMENTS.md`,
   `PRICING_PACKAGING.md`, `PHASE6_COMMERCIALIZATION_PLAN.md` and the real ADR-017 (provider-neutral
   billing — distinct from the ambiguous-send ADR-017 already in the chain) live on
   `origin/docs/phase6-commercial-billing`. They are brought in here, because an issue cannot be
   implemented against a spec the branch cannot see.

   **A plan version is immutable, and the database says so.** Two triggers refuse an edit and a delete;
   only withdrawal from sale is permitted. A workspace subscribes to a *version*, so editing one would
   move the terms under every workspace on it — which is exactly what grandfathering exists to prevent,
   and a rule that lived only in TypeScript is one a migration or a console session walks around.

   **Nothing a payment provider says reaches a feature check.** Six normalized states, the product's own
   feature/limit/quota names, and provider identifiers as opaque strings on `billing_accounts` that
   nothing parses or branches on. A snapshot is asserted to contain no provider string at all.

   **`PAST_DUE` and `GRACE` still permit paid work**, per the accepted policy: a renewal that failed on
   Tuesday must not stop a business answering customers on Wednesday, and the spec allows three days.

   **An expired override stops applying but is kept**, so a temporary concession does not become permanent
   by nobody remembering to delete it, and an operator can still see what was granted.

   Also fixed: `audit_events_scope_check` permitted only `MEMBER_CHANGED` to be workspace-scoped, so a
   workspace-scoped deletion audit from #94 could not have been written at all. The constraint now names
   every workspace-level kind.

   **Not in this issue:** the Starter/Growth/Scale catalogue itself is #43, and no payment provider is
   integrated — #38 is explicit that it comes "without integrating a payment provider yet".

1. **P3-04 / Issue #57 — privacy, retention and deletion.** Branch
   `feat/p3-04-privacy-deletion`, based on #93.

   **The contract the issue referenced did not exist**, so it is written now:
   `docs/specs/PRIVACY_RETENTION_DELETION.md`, from what the code actually does, with the deliberate gaps
   named.

   **Deletion is a durable request, not a function call.** `DeletionRequest` carries the scope, the state
   machine (`REQUESTED → PROCESSING → COMPLETED | PARTIAL_FAILURE`) and per-table counts written as the
   work proceeds, so a crash leaves evidence of how far it got. CHECKs tie the clock to the state and
   refuse to call a run with failures complete.

   **Derived data is the point.** Ninety-six of the schema's ninety-nine foreign keys are `RESTRICT`, so
   the purge names every table in an order the database accepts — including breaking the
   `messages ⇄ ai_drafts` cycle with an update first. Transcripts, summaries, facts, preferences and
   style examples go with the correspondence; a reply engine that still held them would not have
   forgotten anybody.

   **Two rules that fell out of the data rather than from the issue:**

   - **You cannot both forget somebody and remember never to message them.** `followup_suppressions` has
     a non-null contact reference, so an opt-out cannot be stripped of its person. A contact with a
     standing one is anonymised instead: names, numbers, correspondence and derived data go, the contact
     row and the provider's id for them stay, and so does the opt-out.
   - **A fact belongs to the person, not the thread.** A conversation-scoped deletion removes only what
     was derived *from that conversation*; a contact-scoped one removes everything.

   **Least privilege, where there was none.** `requireRole` existed and was called from nowhere outside
   `packages/db`. Export, deletion and `forgetCustomer` are now admin-or-owner, and so is writing a
   Workspace-scoped knowledge source or style example — those are read by every Business Profile, so an
   agent granted one profile could change what the others read.

   **The export is audited in the same transaction as the read**, with counts and never content.

   Also fixed: `deleteExpiredChannelConnectStates` had existed since onboarding with no caller — exported,
   tested, never run, the same shape as Issue #9. It is a worker loop now.

1. **P4-07 / Issue #24 — the WhatsApp vertical slice.** Branch
   `feat/p4-07-whatsapp-slice`, based on #92.

   **WhatsApp had no `DeliverySendPort` at all.** Every WhatsApp reply was refused with `NO_ADAPTER`, so
   the whole outbound half of the channel was unreachable while each of its parts passed its own tests —
   the same shape of gap as #23's missing ingestion wiring. `createSender` now resolves the transport from
   the channel the delivery's account names, rather than being Instagram's by construction.

   **Two channel rules were Instagram's applied to everything:**

   - **The automated-dispatch deadline.** Meta requires an *Instagram* automated experience to answer
     within seconds, and the disposition applied that budget to every conversation. On WhatsApp it would
     have shortened or abandoned the human-like delay for a rule that platform does not impose.
   - **The after-window policy and the window itself.** `afterWindow` was hard-coded to
     `{ channel: "INSTAGRAM" }`, so ADR-016's three WhatsApp modes could never take effect, and a closed
     WhatsApp window read as "not eligible" rather than `TEMPLATE_ONLY` — which is the difference between
     "nothing can reach this customer" and "only an approved template can".

   The human-agent exception stays Instagram's: WhatsApp's route out of a closed window is a template, and
   the sender carries free-form text only, so a delivery needing a template is refused by the gate above
   rather than quietly downgraded.

   `docs/specs/WHATSAPP_SLICE_MANUAL_TEST.md` is the sandbox plan the issue asks for — thirteen steps
   covering onboarding, the window, presence timing, coexistence takeover, disconnect/reconnect, voice
   notes, rejection versus ambiguity, and duplicates.

1. **P4-06 / Issue #23 — coexistence and native-human takeover.** Branch
   `feat/p4-06-whatsapp-coexistence`, based on #91.

   **The finding that mattered: the existing echo detection was looking in the wrong place.** Meta
   publishes a business's native sends on their own webhook field, `smb_message_echoes`; P4-01 looked
   inside `messages` and compared `message.from` to `metadata.display_phone_number` — two fields of the
   same payload, formatted differently, on a field that by Meta's contract carries customer-to-business
   traffic only. It never fired on a real native send, and when it failed to fire the business's own
   message became a customer message and started a reply cycle answering ourselves.

   **Authorship cannot be read from a payload.** Meta publishes no device, operator or origin field, and
   states nowhere that Cloud-API sends are excluded from the echo field. So authorship is *correlated* by
   message id, never attributed, and an echo that cannot be correlated is treated as a person's — the two
   errors are not symmetric, and the product must never draft over a colleague.

   **Two correctness fixes, both mutation-checked:**

   - `isAppOriginatedMessage` matched a delivery job only through its draft, so a reply a person composed
     in the Inbox (no draft, ADR-018 Option B) could never be recognised as ours and its echo took the
     conversation over on the strength of our own send.
   - A provider echo arriving before `settle` committed inserted the platform id first, as a human's
     message; `settle`'s plain `create` then violated the unique id and aborted, leaving the delivery
     `SENDING` with no sent time and the audit trail claiming a person wrote the assistant's reply. The
     send is the authoritative record of its own authorship, so it now claims the row it finds.

   **Webhook ingestion had no WhatsApp adapter at all.** `createWhatsAppAdapterRegistry` had no production
   caller, so every WhatsApp webhook answered `ADAPTER_UNAVAILABLE` — none of this was reachable. It is
   wired now, bound to the messaging account the account row carries rather than one looked up while
   binding.

   **The limitation is stated rather than guessed.** An account that cannot see native replies carries a
   `NATIVE_REPLIES_INVISIBLE` caveat on its channel card, in both locales.

1. **P4-05 / Issue #22 — read and typing presence timing.** Branch
   `feat/p4-05-whatsapp-presence`, based on #90.

   **The platform constraint that shaped the product decision:** Meta documents one request for the typing
   indicator and it carries `status: "read"` and `message_id` as required fields. There is no typing-only
   payload. So read receipts and the typing indicator cannot be offered as two independent switches — the
   setting is one three-valued `PresenceMode` (`OFF`, `READ_ON_RECEIPT`, `READ_AND_TYPING`), because a pair
   of booleans would promise a combination no channel can perform.

   **The indicator is raised shortly before the reply, never when the delay starts.** It is dismissed when
   the reply arrives or after 25 seconds, whichever comes first, while the human-like delay is 30–120 s —
   so announcing at scheduling time would show it, drop it, and leave the customer watching nothing for a
   minute. The lead is bounded three ways (the business's setting, the provider's lifetime, the reply's own
   delay) and the tightest wins.

   **It rests on the send's own judgement rather than a second one.** `presenceVerdict` runs the same
   `evaluatePolicy` call the delivery coordinator runs, over the same `DeliverySendContext`, and announces
   only on the same `SCHEDULE` answer. `policyInputFor` was extracted into `delivery/policy-input.ts` so
   there is literally one construction of that question. A shorter list of conditions in the presence path
   would be a second definition of "still valid", and the drift would show up as a customer watching
   somebody type a reply that had already been cancelled.

   **Two findings worth carrying:**

   - **A tenancy gap the acceptance tests found.** `loadForSend` keys on `operation_id`, which is globally
     unique — so a presence job carrying a foreign `workspaceId` loaded a real delivery and would have
     announced on another tenant's conversation. `PresenceStore.load` now takes the workspace and treats a
     mismatch as "no such delivery". Mutation-checked.
   - **Presence must not promise a reply this deployment cannot send.** There is still no WhatsApp
     `DeliverySendPort` — delivery is Instagram-only until P4-07 — so `deliverableChannels(env)` is derived
     from the same configuration that builds the sender and handed to the scheduler. The moment P4-07 wires
     WhatsApp delivery, presence follows without a second decision being made anywhere.

   Also fixed in passing: `COMPONENT_FOR_QUEUE` in the incident reporter had no entry for
   `media-transcription` (left unmapped by #21, falling through to `INTEGRATION`), and `DELAY_ENGINE.md`'s
   job table was missing that family too.

1. **P4-04 / Issue #21 — media and voice-note transcription.** Branch
   `feat/p4-04-whatsapp-media`, based on #89.

   **A reading is stored apart from the recording, and a failed one never carries words.** The database
   enforces it, because the failure that matters is not an empty transcript but a half-written one reaching
   a customer's reply as though the recording had been understood. `AUDIO_NOT_TRANSCRIBED` is a reason code
   of its own rather than `UNSUPPORTED_MEDIA`, which already means the channel cannot carry a reply.

   **No confidence is invented.** There is no whole-response confidence anywhere in the transcription API:
   per-token logprobs exist only on the `gpt-4o-transcribe` family, per-segment `avg_logprob` only on
   `whisper-1` through `verbose_json`, and every one of those models is removed on 2027-02-26. The adapter
   asks for neither, the port's field is optional, and a CHECK refuses a stored number that does not say
   where it came from.

   **Owner's calls on this task:** the model is `gpt-transcribe` (the documented replacement for
   `whisper-1`, deprecated 2026-08-26), and there is **no transcoding** — the recording is sent as it
   arrived and the provider's own answer settles whether it can read an OGG/Opus container. The live guide
   does not list `ogg` while the official OpenAPI spec still does, so either behaviour is safe by
   construction: a refusal is a typed failure and a review item, never a transcript.

   **Two defects found by the tests that were written for the acceptance criteria**, both of the class
   recorded earlier — correct pieces with a gap between them:

   - **The reading was never dispatched inline.** `processEvent` returned only the debounce entry's id, so
     the transcription entry waited for the 5-second outbox sweeper while the draft job went out at once.
     The draft that needed the words usually ran before they existed and held the reply for a person on a
     reading that had worked. `EventProcessingResult` now carries every entry the event wrote, and the two
     ingestion summary counters are named `outboxDispatched`/`outboxDeferred` because the outbox now
     carries two kinds of work.
   - **A disconnected number's media was still fetched.** `send.ts` and `window.ts` both refuse on
     `connectionState`; `media.ts` never read it. A stored token outlives the authorization it was granted
     under, so a business that removed the integration kept having its customers' recordings downloaded.
     All three media calls now refuse with `ACCOUNT_NOT_CONNECTED` before the token is even decrypted.

   Also repaired: `packages/channel-whatsapp` did not typecheck at the previous head — `media.test.ts`
   passed an unresolved config where a resolved one was required. `vitest` transpiles without typechecking,
   so the suite was green while `pnpm -r typecheck` was not. The suite now resolves the config the way
   production does, which is also what made the `connectionState` gap visible.

   **Retention:** `MEDIA_RETENTION=DELETE_AFTER_READING` asks the provider to delete its copy once the
   words are stored, and the date is recorded only when the provider agreed. A failed reading never
   deletes anything — the recording is the only remaining record of what the customer said.

1. **P4-03 / Issue #20 — the template catalogue and the outside-window policy.** Branch
   `feat/p4-03-whatsapp-templates`, based on #88.

   **The finding worth carrying:** Meta's `parameter_format` is `positional` or `named`, and the two do not
   serialize the same way — a named template's values each carry a `parameter_name`. P4-01's payload
   builder emitted positional parameters for everything, so a business whose templates use named
   parameters could not send a template at all. The format is now derived from the names (a positional
   parameter's name *is* a number) and the approved shape is parsed once at sync rather than on the way to
   a customer.

   **Approval is not permanent.** Quality feedback moves an approved template to `PAUSED` or `DISABLED`,
   unused templates are archived after twelve months and deleted 28 days later, and none of it is
   announced synchronously. So a stored status carries `syncedAt`, a row older than the freshness bound is
   unknown rather than approved, and `message_template_status_update` is applied as it arrives — to every
   connection on the messaging account, because the template belongs to the account rather than to one of
   its numbers.

   **Eligibility is decided before the policy engine sees it**, and the engine is told two booleans and
   never which template. A model may rank or suggest; a suggestion that fails any check is refused rather
   than repaired, because substituting a template that would have worked is this layer choosing the words
   a customer reads.

   **The settings surface already existed.** P5-04 (#79) exposes all three ADR-016 modes and the
   automation allowlist, including the empty-allowlist warning, so the configuration requirement was
   already met.

   **Deliberately left open:** dispatching an outside-window template — composing the proposal, carrying
   it through the delivery command, recording the send. The draft engine proposes no template today, so
   that path would be unreachable code; everything it needs (`selectTemplate`, `templateRouteOf`, the
   catalogue read, the policy gate) is in place and tested. Flagged for the owner to sequence with P4-07.
1. **P4-02 / Issue #19 — WhatsApp Embedded Signup is implemented.** Branch
   `feat/p4-02-whatsapp-embedded-signup`, based on #87.

   **Two live findings shaped it, not just the PR body.** Embedded Signup v2 and v3 — including their
   public previews — are deprecated on **2026-10-15**, so the implementation targets v4 only. And Meta is
   splitting the WhatsApp Business Account into a WhatsApp Account (numbers, identity) and a Messaging
   Account (templates, billing, webhook subscriptions): existing `waba_id` values keep working and now
   **denote the messaging account**. Keeping `wabaId` a separate field in #18 turned out to be the right
   call, and the store keeps the business portfolio as a third identifier.

   **The code lives 30 seconds.** That one number decides the shape of the flow: the exchange happens in
   the request that receives the code, nothing persists or queues it, and an expiry is a refusal the
   operator resumes from.

   **Nothing the browser says about assets is believed.** The `phone_number_id` is looked up *on* the
   `waba_id` with the exchanged token, and the token is checked against this app with `debug_token`. Those
   two checks are what stop a customer's own browser connecting someone else's number — both identifiers
   arrive from a page.

   **A failed provider step persists nothing.** Subscription and registration must both succeed before any
   row is written, so there is no half-connected account; both calls are idempotent, so retrying is free.
   `connected_at` is the claim and CHECK constraints hold it, with the coexistence exemption from phone
   registration written out in the constraint rather than implied in code.

   **New status value: `DEGRADED`.** The onboarding spec asks for it, and it means the provider flagged the
   number — a red quality rating. The credential and the assets are fine, so a person may still approve a
   reply and the policy engine holds every unattended one. **Found while wiring it:** both channel
   registries mapped `status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED"`, so a degraded account would
   have been refused by the *transport* — a human-approved reply would have got a retryable "account is not
   connected" and never left. Fixed in both.

   **Not stored: the two-step PIN.** Used once for registration, never logged, returned or persisted.
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
1. **#34 / P5-08 is the current work**, as PR #83 on `feat/p5-08-analytics-audit`, stacked on P3-02.
1. **#35 / P5-09 is the current work**, as PR #84 on `feat/p5-09-product-ux-e2e`, stacked on the repaired
**Stage E has started.** Its gate — the Stage D handoff recorded on Issue #36, plus the owner advancing it —
is satisfied; the owner asked for Stage E to begin while the Stage D chain is in review.

1. **P4-01 / Issue #18: the WhatsApp Cloud API transport adapter is implemented**
   (`packages/channel-whatsapp`, 65 tests). It mirrors the Instagram adapter's shape deliberately — the two
   packages may not import each other, so the similarity is in structure and not in shared code.

   **What is genuinely different from Instagram, and why:**

   - **Four window states instead of two.** Outside the 24-hour customer-service window a WhatsApp
     conversation is not closed, it is `TEMPLATE_ONLY`: an approved template may still reach the customer.
     Collapsing that into `NOT_ELIGIBLE` would discard the only business-initiated route the platform has.
     The adapter reports the state; whether to use a template is product policy.
   - **Two provider identifiers, kept apart.** `phone_number_id` is the sending asset and the webhook's
     `metadata.phone_number_id`; the WABA owns the subscription and the template catalogue. The display
     phone number is deliberately not an identity — the verification note is explicit that it must not be a
     tenant or idempotency key — and it is used for exactly one thing: recognizing a coexistence echo.
   - **The status-event dedupe key carries the state.** One `wamid` produces sent, delivered and read; a
     bare-`wamid` key would let the first arrival silence the rest and the Inbox would never leave "sent".

   **Two corrections from re-verifying Meta's live docs today**, which the issue asks for: the current Graph
   API version is v26.0 (the draft default was v23.0), and the typing indicator disappears after a reply or
   **25 seconds**, while the product's delay is 30–120 — so presence must be emitted near the send, which
   the adapter now says out loud rather than leaving to a future reader.

1. **The Instagram token lifecycle had no caller, and now does (#9).**
   `refreshInstagramCredential` lived in `apps/web/src/server/`, was covered by eight tests, and was
   called by no route, no action and no loop. A 60-day token therefore expired with
   `channel_accounts.status` still `CONNECTED`, so the Inbox, the setup checklist and the health probe all
   reported a healthy channel while every reply failed with Meta's code 190, and nobody was told to
   reconnect.

   The policy moved to the worker — `instagram-token-refresh.ts` for one connection,
   `instagram-token-sweeper.ts` for the loop — which is where it belongs: a token expires on Meta's clock,
   for every connected account, whether or not anybody opens the dashboard. All eight cases moved with it.
   The send path marks `NEEDS_REAUTH` on a refused token as well, which covers the one case no refresh can
   anticipate: a person revoking access at Meta. Both writes are conditional on the credential's mint time,
   so a connection re-authorized while Meta was answering is left alone.

   **The guard worth keeping:** no unit test can catch "nothing calls this" — the policy passes its own
   tests either way. The worker now reports its running loops in `worker.started`, built from what actually
   started, and `main.test.ts` asserts the list against the real process. When looking for this class of
   bug elsewhere, search for an exported function whose only callers are its own tests.
2. **#35 / P5-09 is the current work**, as PR #84 on `feat/p5-09-product-ux-e2e`, stacked on the repaired
   #83. The full operator journey, an accessibility pass and responsive verification; see
   `docs/specs/UX_VERIFICATION.md`, which the contract asks for and which states the limitations as
   plainly as the coverage.
   - **The journeys drive the real server path**, not a DOM. Each enters through
     `resolveBusinessProfileContext` — session check included — and then the same stores the server
     actions drive, against a migrated database. Every journey has an authorization probe and a
     stale-state probe, because the contract asks for those rather than a happy path.
   - **Contrast is computed, not eyeballed.** WCAG ratios come from the stylesheet's own tokens in both
     themes. It found a real defect: `--border-strong` was 1.91:1 light and 1.86:1 dark against the
     surface a `.button` actually sits on, where SC 1.4.11 wants 3:1 for a control's own boundary.
   - **jsdom evaluates no media queries and lays nothing out**, so no test here claims a page *looks*
     right at 375px. What the responsive tests hold is that the narrow-screen rules exist and still name
     what the components render — which is how this breaks in practice.
2. **#34 / P5-08 is complete**, as PR #83 on `feat/p5-08-analytics-audit`, stacked on P3-02.
   Operational metrics and a searchable, append-only audit log; see `docs/specs/ANALYTICS_DEFINITIONS.md`,
   which is the definition of record for every metric on the page.
   - **Application state and provider state are never summed.** "Handed to the provider" is our claim;
     "delivered" is the platform's, and only the second may be shown to a customer as delivered. Two
     result groups, two panels, two captions.
   - **A day needs a timezone and the caller says which.** The reader chooses, the page states which it
     used, and the quiet-hours zone is deliberately not borrowed — it answers a different question.
   - **`audit_events` is append-only by trigger.** `BEFORE UPDATE`/`BEFORE DELETE` raise; a correction is
     a new row. Sensitivity is derived from the kind, never passed by the caller.
   - Where a metric has no denominator it reports `null`, never zero.
3. **#55 / P3-02 is complete**, as PR #82. Conversation goals, bounded follow-ups and human tasks; see
   `docs/specs/GOALS_FOLLOWUPS.md`. Attempts are bounded by CHECK constraints (1–5), every follow-up is
   revalidated at execution, and `human_tasks` has no column a send path could attach to.
4. **#54 / P3-01 is accepted**; see `docs/specs/CUSTOMER_IDENTITY_SEARCH.md`.
5. **PRs #73–#84 are awaiting review.** All are CI-green with evidence posted. Fixes for any of them go to
   the earliest affected branch and merge down the chain.
6. **PR #73 was repaired on 2026-10-03 after an independent review, and the fix is in every branch here.**
   Astra returned `CHANGES_REQUESTED` at `98895f4344ca3a0a2582ba69b497e9271dc263fc`: activation was
   permitted while the STYLE step was unfinished and had not been deliberately skipped.
   `ONBOARDING_UX.md` requires "style configured **or** intentionally skipped" — a gate with two ways to
   clear it — and `blockersFor()` had neither the skip set nor a style blocker, so `canActivate` came out
   true from channel, knowledge, policy and review facts alone.

   `blockersFor()` now takes the validated skip set and adds `STYLE_NOT_CONFIGURED`.
   `activateBusinessProfile()` needed no separate change, which is the point: it already re-reads through
   `readOnboarding()` inside its row-locked transaction, so the gate it enforces *is* this rule. A second
   readiness rule would agree until somebody edited one of them.

   **Three tests were passing on the bug**, which is why it took an outside reader: a domain test quoted
   the spec sentence and asserted its opposite; the integration fixture called a profile "ready" while
   creating no style profile, no approved example and no skip; and a keyboard test used an unconfigured
   style as a stand-in for a ready profile, so it only found an enabled button because the gate was
   broken.

   Propagated through #74–#83 by ordinary merge, every branch verified at its own head. One consequence
   needed fixing at #73 and re-propagating: the new fixture wrote an unapproved `ACTIVE` style example,
   which `style_examples_verified_check` refuses from P5-06 onward, so the test passed at #73 and failed
   everywhere it was merged to.
7. **The chain was repaired on 2026-09-30.** PR #76 gained its second commit — the human composer, on the
   owner's `FINISH_HUMAN_COMPOSER` directive — *after* #77 had been cut from it, so #77 through #81 were
   all missing the human-composed send path. It has been merged down through #77, #78, #79, #80 and #81 in
   order, each verified and pushed. Check ancestry, not just the PR base, before building on a branch:
   `git merge-base --is-ancestor <parent> <child>`.
8. **Stage D's Phase 5 surfaces are complete with #84.** Nothing further is queued in MASTER #61's Stage D order; the next task is the owner's to name.
9. One product question is open from P5-07: the spec allows a Workspace to *add* lead stages, which would
   require `LeadStage` to stop being an enum — and the draft engine returns one in its structured output,
   so that is a decision, not a display preference.
10. Every surface must take its text from `apps/web/src/i18n/catalogue.ts`; `no-unlocalized-strings.test.ts`
   fails the build otherwise. New Inbox panes are also held by
   `apps/web/src/ui/inbox/no-provider-payloads.test.ts`, which fails if a pane imports a channel package
   or names a provider payload type. New tables are held by the cascade guard in
   `packages/db/src/constraints.integration.test.ts`: only login data and grants may cascade, so a new
   foreign key is `ON DELETE RESTRICT` and removal is an explicit, auditable act.
11. No rebases, no force-pushes, and no merges to `main`.
12. Continue architecture/product design in parallel without letting future prepared phases bypass dependency
   gates.

Historical note: the original launch sequence (review #2, then launch #3 from a merged `main`) was
superseded by the owner's stacked review-lag mode. Those tasks are implemented and are in the chain above.

## PR #82 accepted, and joined to #83 — 2026-10-14

**#82 / P3-02 is accepted at `9040a2cfbd77c4373d97e1f9e5aec48cd25e11c5`.** Gemini (Google Antigravity)
published a formal exact-head review on 2026-10-13T21:07:24Z: GitHub state `APPROVED` on that commit,
carrying `ANTIGRAVITY_REVIEW: PASS head=9040a2cfbd77c4373d97e1f9e5aec48cd25e11c5`. The acceptance covers
that SHA and no other.

**Reviewer routing (owner decision, 2026-10-13T20:32:45Z).** Gemini/Antigravity is **temporary primary**
independent reviewer; **Astra is secondary, advisory-only** until it has a working PostgreSQL/Redis/Linux
runner of its own and the owner changes routing. This is an owner-approved infrastructure exception rather
than quota exhaustion: Astra's `BLOCKED` note on this head reported its missing database and Redis
runtime, which is neither a PASS nor a CHANGES_REQUESTED. Its earlier `CHANGES_REQUESTED` at
`2e876c1d1d62ce9fabaf18ae8240784d4603eada` stays historical. Claude remains the sole author. The
readiness marker keeps the `CLAUDE_READY_FOR_ASTRA` spelling for parser compatibility.

**#83 / P5-08 is the sole current propagation and review gate. #84 onwards are frozen** — no Stage E, no
P5-09, no downstream propagation, nothing into #84+ until #83 has its own current-head PASS.

**The ancestry was not what the numbering suggested, and that is why this merge was needed.** Segment two
(`#83 -> ... -> #105`) forked from an **older** #82 at `c098c18290bb88ea749a8b4d708912870044df89`, which
was also the merge base of the two segments. #83 named `feat/p3-02-goals-followups` as its base while
containing none of the accepted repair; GitHub compared them as 20 ahead / 20 behind. #83 is now joined
to the accepted head by an **ordinary non-rebase merge** — no rebase, no force-push, no squash, nothing to
`main`, and nothing propagated downstream. `git merge-base --is-ancestor 9040a2c… HEAD` succeeds on the
new head.

### What the merge reconciled

Three conflicts, each resolved to keep both behaviours rather than to pick a side. The third is the one
that mattered: the human takeover now does both things inside its single transaction — #83's
`TAKEOVER_STARTED` audit row **and** the accepted head's `cancelPendingFollowUps`. Keeping only one side
would have left either a conversation somebody holds with no record of who took it, or a human-held
conversation with an automated chase still scheduled. The other two were `index.ts` (#82's three tenancy
types added, #83's duplicate export dropped) and `policy-store.ts` (#83's audit writes kept alongside
#82's `profileDefaultPolicyWrite()` and wider tenancy import).

Two pieces of integration fallout, both inside #83's own audit suite, both from accepted #82 behaviour
rather than from anything new:

1. **`savePolicy` requires `expectedVersion`** — deliberately, so that no caller can decide not to care.
   The five call sites now go through the same `save` helper `policy-store.integration.test.ts` uses, and
   the transactional case reads the version *outside* the transaction because that case has to write
   through `tx` itself.
2. **A Business Profile is born with its default policy.** `createBusinessProfile` writes it as a nested
   create from the domain's `profileDefaultPolicyWrite()`, so the fixture creating one by hand violated
   `automation_policies_profile_default_key`. The fixture's own comment — "which onboarding creates in
   the real flow" — is now literally true in code, and the hand-written row is gone.

### Verification of this head

Commands as run, with their actual numbers and limits. Nothing was skipped except where noted, and no
assertion or timeout was changed.

| what | command | result |
|---|---|---|
| migration drift | `pnpm --filter @omnichannel/db db:check-drift` | **No difference detected.** |
| typecheck | `pnpm typecheck` | exit 0, 0 errors |
| lint + boundaries | `pnpm lint` (`eslint . --max-warnings=0 && pnpm lint:boundaries`) | exit 0 |
| PostgreSQL suites | `vitest run --project @omnichannel/db --maxWorkers=2`, `REQUIRE_DB_TESTS=1` | 34 files, **709/709**, exit 0, no skips |
| Redis suites | `vitest run --project @omnichannel/queue --maxWorkers=2`, `REQUIRE_REDIS_TESTS=1` | 3 files, **53/53**, exit 0 |
| worker + web E2E | `vitest run --project @omnichannel/worker --project @omnichannel/web --maxWorkers=2` | 80 files, **892/892**, exit 0 |
| evals | `pnpm evals` | **20/20 passed, 0 failed, 0 quality regressions** |
| no-infrastructure path | `env -i … CI=1 pnpm verify` | exit 0, 104 files passed / 48 skipped, 1479 passed / 839 skipped |

`--maxWorkers=2` is deliberate and is disclosed rather than hidden: unbounded local full runs on this
machine produce a *different* load-sensitive failure set on each attempt, in files a change cannot have
touched, and each passes alone. The reviewer's own Linux runner reported the same thing and bounded its
runs the same way. The 48 skipped files and 839 skipped tests in the last row are the PostgreSQL and Redis
suites declining to run without `TEST_DATABASE_URL`/`TEST_REDIS_URL`, which is that path's purpose; they
are the same suites counted in full in the rows above.

One environment note, not a code defect: `packages/billing-stripe` left on disk by a checkout of a later
branch breaks `scripts/verification/gate.test.ts` with ENOENT on branches that do not have that package.
It was removed before the run above.

## PR #83 accepted, and joined to #84 — 2026-10-14

**#83 / P5-08 is accepted at `c7b02267e183b58a54814c0b4663ee69d5608612`.** Gemini (Google Antigravity)
published a formal exact-head GitHub review on 2026-10-14T12:07:55Z: state `APPROVED` on that commit,
carrying `ANTIGRAVITY_REVIEW: PASS head=c7b02267e183b58a54814c0b4663ee69d5608612`. Verified through
`GET /pulls/83/reviews` rather than from a coordination comment — state, `commit_id` and the marker all
match.

**Routing unchanged:** Gemini/Antigravity temporary **primary**, Astra **secondary advisory-only** until
it has a working PostgreSQL/Redis/Linux runner of its own and the owner re-routes. Claude is the sole
author. The marker keeps the `CLAUDE_READY_FOR_ASTRA` spelling for parser compatibility.

**#84 / P5-09 is the sole propagation and review gate. #85 onwards are frozen** — no Phase 4
propagation, no Stage E, no new feature work until #84 has its own exact-head PASS.

**The ancestry repair.** #84 reported #83 as its base while its live base SHA was the *pre-acceptance*
#83 head `8f84deebf92c1ee204cacb80654a9a228759db07`, which was also the merge base; GitHub compared them
as 16 ahead / 21 behind, so #84 held none of the accepted work. Joined by an **ordinary non-rebase
merge** — no rebase, force-push, squash, merge to `main`, or propagation into #85+.
`git merge-base --is-ancestor c7b02267e183b58a54814c0b4663ee69d5608612 HEAD` succeeds on the new head.

This is the second link of the shape #82→#83 had, and it was **measured in advance**: a throwaway local
probe predicted zero conflicts and three typecheck errors in one file. That is exactly what occurred,
which is the useful part — a clean merge is not a working merge, and both links so far compiled only
after fixing files that had no textual conflict at all.

### What the merge reconciled

Zero conflicts. Three pieces of integration fallout, all in
`apps/web/src/journeys/operator-journey.integration.test.ts` and all from accepted #83 behaviour:

1. **`savePolicy` requires `expectedVersion`.** The journey now reads the profile default's live version
   and posts it back, which is what the real screen does. The requirement exists so that no caller can
   decide not to care, and it was not weakened.
2. **`listPolicyAudits` answers a `PolicyAuditPage`, not an array.** `audits[0]` became
   `audits.entries[0]`. The change history is paged because the spec wants old and new values kept rather
   than capped.
3. **A Business Profile is born with its default policy.** The journey's hand-written
   `automationPolicy.create` violated `automation_policies_profile_default_key`; it is gone, and
   `MANDATORY_REVIEW_REASON_CODES` left the import with it. This is the same fallout #83's audit suite
   had — the second place it surfaced, and worth expecting at every further link.

Accepted #83 behaviour was re-verified here rather than assumed: the human takeover still retains both
the `TAKEOVER_STARTED` audit row and `cancelPendingFollowUps` inside one transaction, policy
`expectedVersion` concurrency and default-policy creation are intact, and the analytics/audit
tenant-isolation, append-only and sensitive-event invariants all pass.

### Verification of this head

Commands as run, with their real numbers and limits. No assertion or timeout was changed.

| what | command | result |
|---|---|---|
| migration drift | `pnpm --filter @omnichannel/db db:check-drift` | **No difference detected.** |
| typecheck | `pnpm typecheck` | exit 0, 0 errors |
| lint + boundaries | `pnpm lint` | exit 0 |
| production build | `pnpm build` | exit 0 |
| PostgreSQL suites | `vitest run --project @omnichannel/db --maxWorkers=2`, `REQUIRE_DB_TESTS=1` | 34 files, **709/709**, exit 0, no skips |
| Redis suites | `vitest run --project @omnichannel/queue --maxWorkers=2`, `REQUIRE_REDIS_TESTS=1` | 3 files, **53/53**, exit 0 |
| worker + web E2E | `vitest run --project @omnichannel/worker --project @omnichannel/web --maxWorkers=2` | 84 files, **941/941**, exit 0 |
| P5-09 coverage specifically | the same, narrowed to `a11y` and `journeys` | 3 files, **42/42** — contrast, semantics, the operator journey |
| evals | `pnpm evals` | **20/20 passed, 0 failed, 0 quality regressions** |
| no-infrastructure path | `env -i … CI=1 pnpm verify` | exit 0, 107 files passed / 49 skipped, 1501 passed / 866 skipped |

**Retries and failures, disclosed.** The first `pnpm typecheck` after the merge failed with the three
predicted errors. The first full worker+web run then failed one file — the journey's `beforeAll` hitting
the profile-default unique constraint, which the typecheck could not see. Both were fixed as described and
re-run clean. `--maxWorkers=2` is deliberate and disclosed: unbounded local runs on this machine give a
different load-sensitive failure set each attempt in files a change cannot have touched. The 49 skipped
files in the last row are the PostgreSQL and Redis suites declining to run without
`TEST_DATABASE_URL`/`TEST_REDIS_URL`, which is that path's purpose; they are counted in full in the rows
above.

## PR #84 accepted, and joined to #85 — 2026-10-14

**#84 / P5-09 is accepted at `ca86e7d7877b8ab2deb1fb280956d2306224e898`** — Gemini/Antigravity formal
GitHub review, state `APPROVED`, 2026-10-14T13:27:18Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=ca86e7d7877b8ab2deb1fb280956d2306224e898`. Verified through
`GET /pulls/84/reviews`, not from a coordination comment.

**Routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#85 / FIX-ISSUE-9 is the sole
gate; #86 onwards are frozen.**

**The ancestry repair.** #85 reported #84 as its base while its live base SHA was the pre-acceptance #84
head `82f9f3fbe6cbc67966f8ba4d1a34569cff544501`, also the merge base; GitHub compared them as 12 ahead /
22 behind. Joined by an ordinary non-rebase merge — no rebase, force-push, squash, merge to `main`, or
propagation into #86+. `git merge-base --is-ancestor ca86e7d… HEAD` succeeds.

### The one conflict, and why it is the most consequential of the propagation so far

`apps/worker/src/main.ts`. **Both sides of it are a fix for the same class of defect — a loop nobody
starts.** This branch adds the Instagram token refresh, whose own comment says *"every part of the
Instagram token lifecycle is implemented and none of it runs: a 60-day token expires, the account still
reads CONNECTED, and every reply fails with a provider error nobody was warned about."* The accepted
parent adds the follow-up sweeper, whose comment says *"`dueFollowUps` and `claimFollowUp` had no caller
at all, so the feature existed and never ran."* A resolution keeping one side would have silently
re-created whichever defect it dropped, and each is a two-line `const`.

**Five edits were needed. The conflict markers showed two.**

1. Both `const` declarations, token refresh then sweeper, matching start order.
2. Both `.close()` calls.
3. **The startup `loops` report.** It merged cleanly and would have stopped naming the sweeper — a loop
   running while the observability built to report running loops stayed silent about it, which is the
   original Issue #9 shape arriving through a merge instead of through a missing caller. `follow_ups` is
   added **unconditionally**; `instagram_tokens` stays conditional on the refresh runner's `running`
   state. The asymmetry is deliberate and now documented in the code: the sweeper always starts, so its
   absence would be a defect, while the refresh only runs where it is configured, so its absence is
   information.
4. **The shutdown commentary's own count.** Both sides read *"`allSettled`, not `all`: five independent
   closes"* above five entries. There are now six; the sentence merged without a conflict and became
   wrong, pointing at a count that no longer matched the lines beneath it.
5. **`main.test.ts`'s expected loop list** — the one a conflict probe could not predict, found by running
   the real worker. The case named *"says which background loops are running, so a loop wired to nothing
   is visible (#9)"* asserts the entire list, so it now names `follow_ups` too. Its sibling case, which
   proves the refresh drops out of the list without a credential key, now also asserts that `follow_ups`
   is still there — which is what pins the unconditional half of the asymmetry above.

Items 3 and 4 fail no typecheck, no lint and no test. Item 5 is why "inspect the merged code rather than
trust the probe" was the right instruction: the probe got four of five, and the fifth lived in the test
that exists to catch exactly this defect.

### Verification of this head

| what | command | result |
|---|---|---|
| migration drift | `pnpm --filter @omnichannel/db db:check-drift` | **No difference detected.** |
| typecheck | `pnpm typecheck` | exit 0, 0 errors |
| lint + boundaries | `pnpm lint` | exit 0 |
| production build | `pnpm build` | exit 0 |
| PostgreSQL suites | `vitest run --project @omnichannel/db --maxWorkers=2`, `REQUIRE_DB_TESTS=1` | 35 files, **721/721**, exit 0, no skips |
| Redis suites | `vitest run --project @omnichannel/queue --maxWorkers=2`, `REQUIRE_REDIS_TESTS=1` | 3 files, **53/53**, exit 0 |
| worker + web | `vitest run --project @omnichannel/worker --project @omnichannel/web --maxWorkers=2` | 86 files, **954/954**, exit 0 |
| worker lifecycle specifically | the same, narrowed to `main`, `bundle`, `instagram-token`, `followup-sweeper` | 5 files, **32/32** — boot report, graceful shutdown, refresh scheduling and lease, sweeper behaviour |
| evals | `pnpm evals` | **20/20 passed, 0 failed, 0 quality regressions** |
| no-infrastructure path | `env -i … CI=1 pnpm verify` | exit 0, 109 files passed / 50 skipped, 1511 passed / 881 skipped |

**Failures and retries, disclosed.** The first worker run failed exactly one case — item 5 above — and
nothing else; it was fixed and re-run clean. `--maxWorkers=2` is deliberate and disclosed: unbounded local
runs on this machine give a different load-sensitive failure set each attempt. The 50 skipped files in the
last row are the PostgreSQL and Redis suites declining to run without
`TEST_DATABASE_URL`/`TEST_REDIS_URL`, which is that path's purpose; they are counted in full above.

## PR #85 accepted, and joined to #86 — 2026-10-14

**#85 / FIX-ISSUE-9 is accepted at `5f56302f8101b1512f9d46a4263643b36f3bbce6`** — Gemini/Antigravity
formal GitHub review, `APPROVED`, 2026-10-14T17:25:58Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=5f56302f8101b1512f9d46a4263643b36f3bbce6`. Verified through
`GET /pulls/85/reviews`.

**Routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#86 is the sole gate; #87
onwards are frozen.**

**The ancestry repair.** #86 reported #85 as its base while its live base SHA was the pre-acceptance #85
head `36314e2068e8fb3a7bc2cbdb4ba79e1bc014ac55`, also the merge base; GitHub compared them as 11 ahead /
23 behind. Ordinary non-rebase merge — no rebase, force-push, squash, merge to `main`, or propagation into
#87+. `git merge-base --is-ancestor 5f56302f… HEAD` succeeds.

### The first costless link, and why that still had to be checked

**Zero conflicts and zero fixes.** This is the first link of the propagation that needed no edit at all,
and it is worth saying why that was not obvious in advance.

#86 changes exactly one file — `apps/worker/src/delivery-policy.ts`, **−42/+11**, deleting the dead
suspension resolver — and the accepted chain had modified **that same file**, adding the `proactive`
handling that keeps a provider dispatch deadline off a follow-up. Git reporting no conflict means only
that the two edits did not overlap textually. That is the shape where a clean merge can be wrong in
**either** direction: the deletion silently undone, or the addition left orphaned. Neither happened, and
each was checked rather than assumed:

1. **`createSuspensionResolver` and its wiring are still deleted** — zero occurrences anywhere in
   `apps/` or `packages/`.
2. **The guarded kill-switch path in `delivery-store.ts` remains authoritative** — `activeSuspension` is
   read there, and `suspensionLockKeysFor` still supplies the keys that protect the claim against the
   transaction race.
3. **`proactive` and its `dispatchDeadline` branch are intact** in `delivery-policy.ts`: still set
   upstream on a `FOLLOW_UP` trigger, still consumed, deadline logic unchanged.
4. **Both worker loops still start, report and close** — token refresh conditional on its runner's
   `running` state, `follow_ups` unconditional, both `.close()` calls present, and the shutdown comment
   still states six.

### Verification of this head

| what | command | result |
|---|---|---|
| migration drift | `pnpm --filter @omnichannel/db db:check-drift` | **No difference detected.** |
| typecheck | `pnpm typecheck` | exit 0 |
| lint + boundaries | `pnpm lint` | exit 0 |
| production build | `pnpm build` | exit 0 |
| the suites this directive names | `vitest run --project @omnichannel/worker --maxWorkers=2 kill-switch reliability main bundle instagram-token followup-sweeper delivery-policy` | 9 files, **76/76** |
| PostgreSQL suites | `--project @omnichannel/db --maxWorkers=2`, `REQUIRE_DB_TESTS=1` | 35 files, **721/721**, no skips |
| Redis suites | `--project @omnichannel/queue --maxWorkers=2`, `REQUIRE_REDIS_TESTS=1` | 3 files, **53/53** |
| worker + web | `--project @omnichannel/worker --project @omnichannel/web --maxWorkers=2` | 86 files, **954/954** |
| evals | `pnpm evals` | **20/20, 0 failed, 0 quality regressions** |
| no-infrastructure path | `env -i … CI=1 pnpm verify` | exit 0, 109 passed / 50 skipped files, 1511 passed / 881 skipped |

**No retries and no failures on this link** — the first time that has been true. `--maxWorkers=2` remains
deliberate and disclosed, and the 50 skipped files are the PostgreSQL and Redis suites declining to run
without their service variables, counted in full in the rows above.

## PR #86 accepted, and joined to #87 / P4-01 — 2026-10-15

**#86 is accepted at `3f6a7e48cda96417332c2f11e0918329e865b6de`** — Gemini/Antigravity formal GitHub
review, `APPROVED`, 2026-10-14T18:50:34Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=3f6a7e48cda96417332c2f11e0918329e865b6de`, verified through
`GET /pulls/86/reviews`.

**Routing unchanged.** **#87 / P4-01 is the sole gate; #88 onwards are frozen.**

**Ancestry repair.** #87 reported #86 as its base while its live base SHA was the pre-acceptance #86 head
`67846521f682693d27b4fe5438b4898cb0821994`, also the merge base; GitHub compared them as 9 ahead / 24
behind. Ordinary non-rebase merge — no rebase, force-push, squash, merge to `main`, or propagation into
#88+. `git merge-base --is-ancestor 3f6a7e48… HEAD` succeeds.

### Zero conflicts, zero fixes — and why that needed more checking here, not less

#87 is **additive**: a new `packages/channel-whatsapp`, 2,560 insertions against 7 deletions. New files
never conflict, so a zero conflict count on this link carries almost no information. Two things were run
because of that rather than despite it: **`pnpm lint:boundaries`** — a fresh package is precisely how a
forbidden dependency edge enters a layered workspace — and **`pnpm install --frozen-lockfile`** before
anything else, because the branch moves `pnpm-lock.yaml`.

### The P4-01 contract, verified in the merged code

- **Signature.** `createHmac("sha256", appSecret).update(rawBody)` compared with `timingSafeEqual` after
  a length pre-check (`timingSafeEqual` throws on a length mismatch, and both lengths are attacker-visible
  anyway). It fails closed on an empty app secret, and `normalize` refuses outright to run on an
  unverified webhook.
- **Tenant isolation and identity.** `display_phone_number` appears in exactly one behavioural place: to
  recognise that a message came from the business's own number, which is a **coexistence echo** rather
  than a customer message (ADR-013 — the adapter records the fact and leaves takeover attribution to the
  application). It is never an identity or idempotency key. That is `sourceEventId(kind, …parts)`, which
  falls back to a deterministic SHA-256 digest rather than truncating, because truncation would cut the
  trailing parts that make the key unique.
- **Send outcomes** are confined to `ACCEPTED | REJECTED | AMBIGUOUS`, with ambiguity preserved rather
  than made retryable for convenience.
- **Accepted #86 invariants intact:** the dead suspension resolver stays deleted, the guarded kill-switch
  claim path stays authoritative, `proactive` and its `dispatchDeadline` branch are present, and both
  background loops still start, report and close — with the shutdown prose still stating six.

### Meta re-verification — 2026-10-15

| what | finding | source |
|---|---|---|
| current Graph API version | **v26.0**, released **2026-07-29**, expiration TBD. **No v27.0 exists.** So `DEFAULT_GRAPH_VERSION` is unchanged from the 2026-10-04 note. | [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions/) |
| signature header | `X-Hub-Signature-256`, value prefixed `sha256=`, generated from the payload with the **App Secret** | [Webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started) |
| the escaped-unicode trap | Meta computes the signature over an **escaped-unicode** payload (`äöå` → `äöå`), not decoded bytes, so implementations that parse and re-serialize produce a different hash | Meta webhooks guidance |

**That last one is the reason this check was worth doing, and this adapter is unaffected.**
`apps/web/src/server/webhooks.ts` reads the body as `new Uint8Array(await request.arrayBuffer())` before
any parsing, and **the same bytes are both hashed and parsed** — `parseWebhook(input.rawBody)` — so
whatever Meta put on the wire is exactly what is verified. Nothing re-serializes in between.

**Reported and deliberately not fixed:** `packages/channel-whatsapp/src/config.ts:103` illustrates the
endpoint as `https://graph.facebook.com/v23.0/<phone_number_id>/messages` while the constant is `v26.0`.
The URL is built from `config.graphVersion`, so behaviour is correct and only the comment is stale — and
it predates this merge, so changing it would be the unrelated cleanup these directives forbid.

### Verification of this head

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries / production build | exit 0, exit 0, exit 0 |
| `@omnichannel/channel-whatsapp` | 5 files, **65/65** — signature, duplicate inbound, media/audio/reply, reordered status, send ambiguity, window, malformed payloads, coexistence, tenant isolation |
| PostgreSQL suites (`--maxWorkers=2`, `REQUIRE_DB_TESTS=1`) | 35 files, **721/721**, no skips |
| Redis suites (`--maxWorkers=2`, `REQUIRE_REDIS_TESTS=1`) | 3 files, **53/53** |
| worker + web | 86 files, **954/954** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| no-infrastructure path (`env -i … CI=1 pnpm verify`) | exit 0, 114 files passed / 50 skipped, **1576 passed** / 881 skipped |

**No retries and no failures on this link**, the second such in a row. `--maxWorkers=2` stays deliberate
and disclosed; the 50 skipped files are the PostgreSQL and Redis suites declining to run without their
service variables and are counted in full above.

## PR #87 accepted, and joined to #88 / P4-02 — 2026-10-16

**#87 is accepted at `c13d32dea988daf38a6a4a6b03a612553c26c72b`** — Gemini/Antigravity formal GitHub
review `5529023598`, `APPROVED`, 2026-10-15T06:25:13Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=c13d32dea988daf38a6a4a6b03a612553c26c72b`, verified through
`GET /pulls/87/reviews` (state, `commit_id` and marker all read independently).

**Routing unchanged.** **#88 / P4-02 is the sole gate; #89 onwards are frozen.**

**Ancestry repair.** #88 reported `feat/p4-01-whatsapp-adapter` as its base while its live merge base was
the pre-acceptance #87 head `48fd78a93d626ea56b2ada97c24a25ccd2595e14`; GitHub reported `diverged`, 9
ahead / 25 behind. Ordinary non-rebase merge at `6bac028d3c658ca4e2ea01fbaf4f74fa1acdb8cb` — no rebase,
force-push, squash, merge to `main`, or propagation into #89+. `git merge-base --is-ancestor c13d32de… HEAD`
succeeds, and the prior #88 head `960f7174abaa732a183624defcc5c1104af262da` is still an ancestor.

### Zero conflicts, and the change that does not announce itself

77 files, 7,976 insertions against 311 deletions, no conflict markers. On this link the zero was the thing
to distrust: **#88 widens a channel-account status union**, and widening a union breaks exhaustive consumers
*without* ever producing a conflict. So the merge was followed by `pnpm install --frozen-lockfile` (the
branch moves the lockfile), then `pnpm typecheck` — clean across all 14 packages — and `lint:boundaries`,
clean at 535 package source files with no cycles. Nothing had to be adapted; this is the second costless
link in a row, and it was still measured rather than assumed.

### The one authored change, and the defect I shipped into it before catching it

The directive's step 3 scoped exactly one post-review source risk into this cycle: the coexistence echo
comparison this author had disclosed on #87 after that PR's own review had already passed.

`normalize.ts` matched an echo with `message.from === value.metadata?.display_phone_number`. Two Meta
surfaces, two spellings: `from` is a `wa_id` (digits only), while the Graph `/phone_numbers` edge returns
the same number as `+1 631-555-5555` — the spelling this product stores at onboarding and already carries
in its own fixtures as `"+1 555 0100"`. Meta's **webhook** metadata uses the digits-only spelling, so
nothing was broken in production. What made it worth repairing is where a miss lands: not in "ignored" but
in `INBOUND_MESSAGE`, with the business's own number as the sender, on a thread the draft path would answer.

`sameNumber` now compares canonical digits and refuses a match when either side reduces to no digits. The
test that covered this was **powerless** — `from` and `metadata.display_phone_number` came from the same
fixture constant, so one value sat on both sides of the `===`. The fixture now declares `BUSINESS_WA_ID`
and `BUSINESS_DISPLAY_NUMBER` as separate constants with genuinely different values, `envelope()` takes a
`displayPhoneNumber` override, and five cases state both wire values independently. Each clause of the fix
is killed by exactly one case under mutation; the empty-digits guard earned its place only after a second
case was written for it, because the first one survived the mutation.

**The defect I introduced:** the helper's first placement split `belongsToThisAsset`'s doc comment from its
function, leaving one comment documenting the wrong thing. Typecheck, lint and 102 passing tests all stayed
green — none of them read doc comments. Found by re-reading the file I had just edited, and fixed by moving
the helper below that function.

### Meta re-verification — 2026-10-15 and 2026-10-16

Recorded in full, dated and sourced, in `docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`. This is the
file the previous link deferred that record to, and it is now current.

**Embedded Signup v4 remains latest** (expiry TBD) and `onboarding.ts` has always targeted v4 only. The v2
deprecation date **passed while Meta's own pages still read "will be deprecated on October 15, 2026" in the
future tense**, with no changelog entry recording the cutover — so enforcement is announced-and-reached, not
observed, and this handoff does not claim otherwise. A precision correction to the 2026-10-04 baseline: the
versions table gives v3 only `"October, 2026"`, a month with no day; the sole primary source naming 15
October for v3 is Meta's blog post of 2026-05-14.

`v26.0` is still the current Graph version and **no v27.0 exists**, so `DEFAULT_GRAPH_VERSION` is unchanged
and `config.ts`'s illustrative `v23.0` names a version supported until 2027-10-08. The 30-second code TTL,
the six-digit PIN on `register`, the Allowed-Domains-**and**-Valid-OAuth-Redirect-URIs conjunction, and the
24-hour window with `131047` are confirmed verbatim and unchanged.

**Four documented risks were checked against this code and found absent**, which is why the pass changed no
behaviour beyond the echo repair: no `sessionInfoVersion` is sent (Meta does not corroborate `4` for v4); no
`subscribed_fields` is sent (the `subscribed_apps` reference documents no such parameter);
`code_verification_status` and `quality_rating` are plain `string` end to end, so the contradictory
enumerations Meta publishes on sibling pages cannot break a parse; and the adapter reads neither
`conversation` nor `pricing` from a status, which Graph v24.0+ drops.

**One finding that reframes the repaired branch without being a defect.** Meta documents a coexistence
business's app-sent and companion-device messages under a field of their own — `smb_message_echoes` →
`value.message_echoes[]` — where arrival under that field *is* the authorship signal. At this head the
adapter records `whatsapp.unhandled_field` and drops every non-`messages` change, so a real echo is logged
and dropped here; consuming that field belongs to the later coexistence task in this chain. The repair still
earns its place, because `message_echoes[].from` is documented as the business *display* phone number — the
same spelling trap, waiting for whatever consumes echoes next. The code comment now states this so the
branch is not mistaken for the coexistence mechanism.

Also recorded: a hard date of **2026-12-31** to migrate `paid_messaging_account_id` → `messaging_account_id`
under Meta's account-model split. **This repository uses neither identifier**, so there is nothing to
migrate; it is written down because Phase 2 (H1 2027) will require `messaging_account_id` in multi-account
setups, and because the Embedded Signup session-info field names under the new model are not yet published.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; every suite bounded to `--maxWorkers=2`.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries / production build | exit 0, exit 0, exit 0 |
| `@omnichannel/channel-whatsapp` | 6 files, **102/102** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 36 files, **743/743**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **53/53** |
| worker + web E2E | 88 files, **1002/1002** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0, 117 files passed / 51 skipped, **1661 passed** / 903 skipped |

**No retries, no reruns, no flakes on this link.** `--maxWorkers=2` stays deliberate and disclosed. The 51
skipped files in the no-infrastructure run are the PostgreSQL and Redis suites declining to start without
`TEST_DATABASE_URL` / `TEST_REDIS_URL` — the behaviour CI depends on — and are the same suites reported in
full above. One environment note worth recording: those variables are `TEST_DATABASE_URL` and
`TEST_REDIS_URL`, not `DATABASE_URL`; a first run with the wrong names failed 31 suites loudly rather than
skipping them silently, which is the right design and is why it was caught immediately. Local runs are
macOS; the authoritative Linux evidence is the exact-head GitHub Actions run.

## PR #88 accepted, and joined to #89 / P4-03 — 2026-10-17

**#88 is accepted at `98c2b2696f670ccc82a32252a91fa0460d2dfffa`** — Gemini/Antigravity formal GitHub review
`5550962495`, `APPROVED`, 2026-10-16T16:53:26Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=98c2b2696f670ccc82a32252a91fa0460d2dfffa`, verified through
`GET /pulls/88/reviews`. The verdict audited `sameNumber` explicitly and found zero blocking defects.

**Routing unchanged.** **#89 / P4-03 is the sole gate; #90 onwards are frozen.**

**Ancestry.** Both segments fork from `960f7174abaa732a183624defcc5c1104af262da` — accepted #88 ran 27
commits ahead of it, #89's authored segment 9 — so #89 against accepted #88 was genuinely `diverged`, 9
ahead / 27 behind. Ordinary non-rebase merge at `3752ae2b11cfa8dc6b53365385e2e80845e23026`; no rebase,
force-push, squash, merge to `main`, or propagation into #90+. `--is-ancestor` succeeds for both the
accepted #88 head and the prior #89 head `f257f0a6f73e55f98d5395abce46d9f72e0bb190`.

### The conflict that was only a comment, and why that still took work

Two conflicts. The documentation one was a plain union: both segments had appended a dated section to
`META_WHATSAPP_PHASE4_VERIFICATION.md`, so both are kept, in chronological order — #89's P4-03 templates
re-verification of 2026-10-04, then #88's propagation re-verification of 2026-10-16. Neither was folded into
the other.

The other was `evaluate.ts`, and it was a **doc comment** — which made it more dangerous rather than less,
because the two sides disagreed about a fact. #89's prose counted "unattended sending needs the allowlist"
among four conditions; #88's said the allowlist is **not** read in the policy engine at all but arrives as
two settled booleans computed where the catalogue is. A comment cannot be resolved by preferring the longer
one, so it was resolved against the code: `evaluateTemplateGate` reads
`input.templateRoute.approvedTemplateAvailable` and `input.templateRoute.automatable`, and touches no
catalogue. #88's framing is the factual one.

The resolution is a genuine union rather than a choice. It keeps #89's four operator-facing conditions —
each of which does describe real behaviour — keeps #88's distinction between `undefined` and an empty
refusal list, and ends by naming `selectTemplate` as the place the two booleans are decided. That closing
sentence is *more* true after this merge than before it, because `selectTemplate` is #89's own new
`packages/application/src/policy/template-route.ts`. The two segments did not conflict about behaviour; they
conflicted about which of them owned a sentence, and the merged code makes both halves of it true.

### The semantic union, checked rather than presumed

- **#88's echo normalization survives** — `sameNumber` defined and still called at the echo branch, with
  `BUSINESS_WA_ID` and `BUSINESS_DISPLAY_NUMBER` still separate constants in fixture and test.
- **#89's template work survives** — `policy/template-route.ts` with its 17 cases,
  `channel-whatsapp/templates.ts`, `db/whatsapp-template-store.ts`, `domain/message-template.ts`, the new
  reason codes, and migration `20261004210000_whatsapp_template_shape` with both CHECKs.
- **The boundary the #87 verdict demanded holds.** That review required transport-owned template checks not
  to claim the then-unbuilt Issue #20 catalogue. #89 now builds it, so the boundary was re-checked instead
  of presumed: `checkSendable` refuses only shape — missing template name or language, empty parameter —
  and never approval status, freshness or the allowlist. Eligibility stays in `selectTemplate`. No
  duplicated check and no contradiction between the layers.
- **#89's freshness rule was mutation-checked**, since it is the claim its own prose rests on ("a cached
  catalogue row is not a permission forever"). Making `isFresh` always true, and separately computing
  availability without the freshness filter, each fail exactly the two staleness cases. The tests have
  power; nothing needed changing.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; every suite bounded to `--maxWorkers=2`.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries | exit 0, 14 packages; 13 packages, **545** source files, 0 cycles |
| `@omnichannel/application` | 6 files, **138/138** |
| `@omnichannel/channel-whatsapp` | 7 files, **123/123** |
| `@omnichannel/domain` | 13 files, **266/266** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 37 files, **753/753**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **53/53** |
| worker + web E2E | 89 files, **1010/1010** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0; 121 files passed / 52 skipped, **1733 passed** / 913 skipped |

**Disclosed limitations.** No retries, no reruns, no flakes, and no test skipped to make a gate pass. One
precision worth recording rather than glossing: `pnpm --filter @omnichannel/db db:migrate:deploy` reported
*"No pending migrations to apply"* on this branch, and that was **correct but not evidence** — this
long-lived local database already had `20261004210000_whatsapp_template_shape` applied on 2026-10-05 during
earlier work on this branch. Nor does `db:check-drift` consult the live database; it compares the migrations
directory against `schema.prisma`. What actually demonstrates the migration is sound is that every
integration suite builds a **fresh** database per run through `createMigratedTestDatabase`, and 753 tests
passed against those. Local runs are macOS; the authoritative Linux evidence is the exact-head GitHub
Actions run.

## PR #89 accepted, and joined to #90 / P4-04 — 2026-10-17

**#89 is accepted at `cdba474caead94c87bdc5038500e8b32274a1507`** — Gemini/Antigravity formal GitHub review
`5557475655`, `APPROVED`, 2026-10-17T10:54:39Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=cdba474caead94c87bdc5038500e8b32274a1507`, verified through
`GET /pulls/89/reviews`.

**Routing unchanged.** **#90 / P4-04 is the sole gate; #91 onwards are frozen.**

**Ancestry.** Both segments fork from `f257f0a6f73e55f98d5395abce46d9f72e0bb190` — the accepted #89 segment
29 commits ahead of it, #90's authored segment 11 — so #90 against accepted #89 was genuinely `diverged`,
11 ahead / 29 behind. Ordinary non-rebase merge at `3c2f00665ddb16426bfcfdf0b1170b775bad8988`; no rebase,
force-push, squash, merge to `main`, or propagation into #91+. `--is-ancestor` holds for the accepted #89
head and the prior #90 head alike.

### Three conflicts, resolved as unions

**An import collision** in `packages/db/src/ingestion-store.ts`: #90 added `createPendingTranscripts`, the
accepted segment added `cancelPendingFollowUps`, on the same line. Both symbols are used in the merged body,
so keeping one would have deleted a feature outright. Both kept.

**Two whole suites appended at one place** in `packages/db/src/ingestion.integration.test.ts` — #90's
`describe("a customer's voice note")` (eight cases) and #89's `describe("a webhook calls off a chase")`
(three). Unrelated subjects, so both kept. The care needed was structural rather than semantic: the two
sides shared one `/**` opener above the conflict marker, so each side's prose continued the *same* comment.
The second suite was given its own opener instead of letting #89's paragraphs run on under #90's heading.

**A dated research section from each side**, kept in chronological order. The file now holds five
re-verification sections: P4-01, P4-02 and P4-03 of 2026-10-04, P4-04 of 2026-10-04/05, and the propagation
re-verification of 2026-10-16.

### The fallout that produced no conflict, and that only the typechecker could catch

`apps/worker/src/followup-slice.integration.test.ts` arrived from the accepted #89 segment calling
`createHandlers` with four arguments. #90 had inserted a fifth parameter — `transcribeMedia` — **as the
fourth**, ahead of `reconcile`. Neither side touched the other's lines, so git merged both cleanly and the
test's `"no reconciliation is processed in this slice"` rejecter silently took the *transcription* slot
while `reconcile` received nothing.

Resolved by passing both rejecters in the signature's order, with a comment recording why the fourth one
exists. What is worth keeping from it:

- **The test could not have caught this.** Every non-draft handler in that slice is a rejecter, so a
  mis-ordered resolution passes just as well — the suite proves that no other job runs, not which slot each
  rejecter sits in. The whole-repository `pnpm typecheck` was the only gate that could see the arity, which
  is the standing reason to run it on every link rather than trusting a green Vitest run.
- This is the recurring shape of this chain: a parameter added in the middle of a positional signature,
  merged against a caller that predates it, with no textual overlap to raise a conflict.

### The semantic union, checked rather than assumed

#89's `policy/template-route.ts`, the `selectTemplate` reference in the resolved `evaluate.ts` comment, the
`cancelPendingFollowUps` call on the ingestion path and the chase suite are all present. #90's
`db/transcript-store.ts`, its `createPendingTranscripts` call on the same path, the voice-note suite and the
`transcribeMedia` wiring in `apps/worker/src/main.ts` are all present. #88's `sameNumber` is still defined
and still called at the coexistence echo branch.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; every suite bounded to `--maxWorkers=2`. Each focused
package was run **separately with its own label**, after a labelling error on the previous link that came
from reading a multi-filter run's blocks in the order the filters were typed rather than in pnpm's
dependency order.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries | exit 0, 14 packages; 13 packages, **561** source files, 0 cycles |
| `@omnichannel/application` | 13 files, **271/271** |
| `@omnichannel/domain` | 6 files, **138/138** |
| `@omnichannel/channel-whatsapp` | 8 files, **152/152** |
| `apps/worker` follow-up slice (the adapted test) | 1 file, **7/7** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 38 files, **793/793**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **55/55** |
| worker + web E2E | 93 files, **1055/1055** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0; 125 files passed / 55 skipped, **1801 passed** / 988 skipped |

**Disclosed limitations.** No retries, no reruns, no flakes, and no test skipped to make a gate pass. The
988 skipped tests in the no-infrastructure run are the PostgreSQL and Redis suites declining to start
without `TEST_DATABASE_URL` / `TEST_REDIS_URL` — the behaviour CI depends on — and are the same suites
reported in full above with infrastructure present. One honest note on method: in the batched gate run the
drift line came back blank because the summary took the last line of its output and that line was empty; it
was re-run on its own and printed `No difference detected.` A blank line is not a pass, and it was not
counted as one. Local runs are macOS; the authoritative Linux evidence is the exact-head GitHub Actions run.

## PR #90 accepted, and joined to #91 / P4-05 — 2026-10-17

**#90 is accepted at `07ce360c09999e83a6a882fdd79152df535865b6`** — Gemini/Antigravity formal GitHub review
`5557862173`, `APPROVED`, 2026-10-17T13:00:07Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=07ce360c09999e83a6a882fdd79152df535865b6`, verified through
`GET /pulls/90/reviews`.

**Routing unchanged.** **#91 / P4-05 is the sole gate; #92 onwards are frozen.**

**Ancestry.** Both segments fork from `b3fe33e775c32f5654066a11edc04e7df1ab41d8` — the accepted #90 segment
31 commits ahead of it, #91's authored segment 8 — so #91 against accepted #90 was genuinely `diverged`, 8
ahead / 31 behind. Ordinary non-rebase merge at `6b0613952cc01c85afc5dff7b61a579a25c371b7`; no rebase,
force-push, squash, merge to `main`, or propagation into #92+.

### Three conflicts, and five pieces of fallout that conflicted with nothing

The conflicts were the easy part. `policy-store.ts` had four hunks of the same shape — #91's two presence
fields against the accepted segment's `version`, appended at the same point in the view interface, the
select, the row type and the row mapping — and all three fields were kept in all four.
`settings-actions.ts` was overlapping edits rather than appends, and two of the four things that had to
survive were only visible by reading the merged body: the accepted segment's `.trim()` on
`takeoverPauseHours`, and its `customSeconds`/`custom` pair, which the already-merged body between the two
hunks **references**, so discarding that side would not have compiled. The research note took a dated
section from each side and now holds six in chronological order.

**The work was in what merged cleanly and was still wrong.** The directive's step 3 asked specifically for
a re-check of positional handler signatures and lifecycle wiring, which is exactly where two of these came
from:

1. **A stale Prisma client that looked like a source defect.** `draft-disposition.ts` failed typecheck
   claiming a policy row lacked the presence columns, though the row comes from an unselected `findMany`.
   The install had been a no-op — `Lockfile is up to date`, 19 ms — so `prisma generate` never ran and the
   client still described #90's schema. `db:generate` cleared it with no source change. **Regenerate before
   believing a merge produced a type error in code that works.**
2. **`defaultAutomationSettings()` no longer satisfied its own type**, because
   `AutomationPolicySettings` is `Omit<AutomationPolicy, …>` and #91 widened `AutomationPolicy`. Filled
   from #91's own defaults, `"OFF"` and `DEFAULT_PRESENCE_TYPING_LEAD_MS` — and that is verified rather
   than chosen: `domain.test.ts` asserts the default `toEqual`s what `createAutomationPolicy` produces, an
   exhaustive comparison that fails on any other value.
3. **`createHandlers` arity, for the second link running.** #91 inserted `announcePresence` fifth of six,
   again ahead of `reconcile`, so the follow-up slice test the previous link had corrected to five
   arguments now needed six. The comment there now carries the full parameter order and the reason types
   cannot police it: the rejecters take no arguments, satisfy every slot, and the suite passes in any
   order. Order read from `handlers.ts`, corroborated against the production call in `main.ts`.
4. **The settings page used a variable the accepted segment had replaced** — `policy` where the refactor
   introduced a single `form` object built from `edited ?? stored`. Presence now reads from `form`.
5. **A fixture hand-wrote a profile default that already exists.** `presence-handler.integration.test.ts`
   hit `automation_policies_profile_default_key`, failing the suite and skipping its 15 tests, because
   `createBusinessProfile` has written that row since the accepted P3-02 head. Changed to edit the existing
   default. The other four `automationPolicy.create` sites were checked and do not collide.

### Disclosed, not fixed

**A sixth breakage, found by checking a disclosure before publishing it.** I had written that presence was
absent from the rejected-proposal round trip and that this discarded nothing, because #91 predates that
mechanism. Tracing the save path first showed the claim was wrong: `saveSettingsAction` builds a
`PolicyProposal` and `editFrom` maps it to the store's `PolicyEdit` field by field, with no presence in the
mapping — so the form posted presence, `proposalFrom` read it, and it was dropped before `savePolicy`.
**#91's presence setting could not be saved from the settings page.** #91's own head built the edit directly
with presence included, so the accepted segment's mapper is what broke it. Typecheck could not see it —
presence enters through conditional spreads, which evade excess-property checking — and no test asserted
that presence reaches the store. Fixed after a failing test proved it: `PolicyProposal` now declares both
fields, `decodeProposal` re-validates them like every other user-editable field, `editFrom` carries them,
and the page prefers `edited ?? stored` for them as every sibling field does.

Also: the two presence inputs lack `disabled={!mayEdit}`, which #91's own head lacked too
(the server still refuses an AGENT); `presenceSettingsOf`'s coercions are unreachable from its only caller,
because the columns are a Prisma enum and `Int NOT NULL`, and no test pins them; and
`profileDefaultPolicyWrite()` does not map the presence columns, which changes nothing today because the
schema defaults are the same two values.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; `--maxWorkers=2` throughout; each focused package run
separately with its own label.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries | exit 0, 14 packages; 13 packages, **571** source files, 0 cycles |
| `@omnichannel/domain` | 6 files, **138/138** |
| `@omnichannel/application` | 14 files, **294/294** |
| `@omnichannel/channel-whatsapp` | 8 files, **152/152** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 38 files, **793/793**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **55/55** |
| worker + web E2E | 95 files, **1086/1086** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0; 126 files passed / 57 skipped, **1826 passed** / 1017 skipped |

**Disclosed limitations.** The presence-handler suite **failed on the first full run** and is reported as
fixed rather than as having passed first time: `automation_policies_profile_default_key`, one failed file
and 15 skipped tests. It was reproduced on its own, fixed at the fixture, and re-run — the whole E2E project
then went from 94 passed / 1 failed with 15 skipped to **95 passed with no skips**. No other
retries, no flakes, and nothing skipped to make a gate pass. The 1017 skipped tests in the no-infrastructure
run are the PostgreSQL and Redis suites declining to start without `TEST_DATABASE_URL` / `TEST_REDIS_URL`,
which is what CI relies on. `db:migrate:deploy` again reported "No pending migrations to apply": correct but
not evidence, because this long-lived local database already had `20261005160000_presence_timing` applied on
2026-10-05 — checked in `_prisma_migrations`, not assumed — and the integration suites build a fresh
database per run regardless. Local runs are macOS; the authoritative Linux evidence is the exact-head
GitHub Actions run.

## PR #91 accepted, and joined to #92 / P4-06 — 2026-10-17

**#91 is accepted at `550100cae7d6f18f78a341543ec2feb194f1797e`** — Gemini/Antigravity formal GitHub review
`5558442119`, `APPROVED`, 2026-10-17T15:19:11Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=550100cae7d6f18f78a341543ec2feb194f1797e`, verified through
`GET /pulls/91/reviews`. That verdict also judged four author-disclosed observations non-blocking, and
named the missing decode cases as a coverage gap to be closed in later polish.

**Routing unchanged.** **#92 / P4-06 is the sole gate; #93 onwards are frozen.**

**Ancestry.** Both segments fork from `f0d89c6e3b9cc5a8a5d413d1bf2d5a00b37b22b0` — the accepted #91 segment
34 commits ahead of it, #92's authored segment 7 — so #92 against accepted #91 was genuinely `diverged`, 7
ahead / 34 behind. Ordinary non-rebase merge at `7fe737e0855457aa6f3f6f125c0bdd005a51ed88`; no rebase,
force-push, squash, merge to `main`, or propagation into #93+.

### The one collision in this chain where both sides were half right

Three conflicts, all of them already measured: `git merge-tree` had been run against #92 from the #91 head
before this directive existed, and it named `normalize.ts`, its test, and the research note.

The code conflict is the substantive one. **Both segments had independently reached the same conclusion
about the coexistence echo, and each held only half the answer.** #92 replaced the old classification with
a refusal, and its comment states both reasons — the branch was never where Meta publishes native sends, so
it never fired on a real one, and when it failed to fire *because the two fields are formatted differently*
the business's own message became an inbound message from a "customer" who is the business, starting a
reply cycle answering ourselves. #92 also brought the real mechanism, `smb_message_echoes` and
`normalizeEcho`. #91, meanwhile, had fixed the comparison — canonical, digits-only — but was still
classifying.

So #92 had the right semantics with the very comparison that caused the failure it describes, and #91 had
the right comparison attached to semantics that are now wrong. The resolution keeps #92's refusal, comment
and warning, and uses `sameNumber` in the condition, with a paragraph explaining why: a refusal keyed on
raw equality misses in exactly the cases where the spellings differ, which would leave the phantom-inbound
behaviour reachable through the refusal instead of through the classification.

**What makes this provable rather than asserted:** #91's fixture split put the digits-only spelling in
`envelope`'s metadata and left `BUSINESS_DISPLAY_NUMBER` as the punctuated Graph form, so **#92's own
refusal case now compares two different spellings of one number**, where on its own branch both sides were
the same constant and the case could not fail. Restoring raw `===` fails #92's case and nothing else;
deleting the empty-digits guard fails the no-digits case, which now guards against a *false refusal*.

#91's `OUTBOUND_ECHO` assertions were not carried over, because the behaviour they asserted no longer
exists. Their value was: the test file keeps #92's suite verbatim and adds a block for what it cannot cover
— the plain spelling refused, and the two ways a canonical comparison could refuse something it must not.
`sameNumber`'s docstring was rewritten too: it still described "echo detection" and called itself
belt-and-braces for a mechanism "a later task in this chain consumes", and that task is in this file now.

### The coverage gap I disclosed on #91, folded forward

The verdict's own words were that it "can be addressed during future polish without destabilizing the
current verified HEAD". This is that head. Four cases now cover `decodeProposal`: presence survives the
round trip, an unrecognised mode is dropped, and a negative or over-long lead is dropped. Checked both
ways — removing presence from the decoder fails the carry case alone; carrying it unvalidated fails all
three validation cases. The first case records in its comment why it must exist separately: the file's
`toEqual(PROPOSAL)` round-trip assertion cannot show a field the fixture omits.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; `--maxWorkers=2` throughout; focused packages run
separately with their own labels. `db:generate` was run before typechecking, which is the lesson from the
previous link, where a no-op install left a stale client that looked like a source defect.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries | exit 0, 14 packages; 13 packages, **576** source files, 0 cycles |
| `@omnichannel/domain` | 6 files, **138/138** |
| `@omnichannel/application` | 14 files, **294/294** |
| `@omnichannel/channel-whatsapp` | 9 files, **166/166** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 39 files, **804/804**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **55/55** |
| worker + web E2E | 95 files, **1090/1090** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0; 127 files passed / 58 skipped, **1844 passed** / 1028 skipped |

**Disclosed limitations.** No retries, no reruns, no flakes, and no test skipped to make a gate pass. The
1028 skipped tests in the no-infrastructure run are the PostgreSQL and Redis suites declining to start
without `TEST_DATABASE_URL` / `TEST_REDIS_URL`, which is what CI relies on, and are the same suites reported
in full above. Local runs are macOS; the authoritative Linux evidence is the exact-head GitHub Actions run.

## PR #92 accepted, and joined to #93 / P4-07 — 2026-10-17

**#92 is accepted at `fddf0a2f0154135fce7c3d62cbc91c67e0651fe0`** — Gemini/Antigravity formal GitHub review
`5559051465`, `APPROVED`, 2026-10-17T17:21:42Z, carrying
`ANTIGRAVITY_REVIEW: PASS head=fddf0a2f0154135fce7c3d62cbc91c67e0651fe0`, verified through
`GET /pulls/92/reviews`.

**Routing unchanged.** **#93 / P4-07 is the sole gate; #94 onwards are frozen.**

**Ancestry.** Both segments fork from `ce7fe8f536709872b25f4d155a6fbf388c4adb4c` — the accepted #92 segment
36 commits ahead of it, #93's authored segment 8 — so #93 against accepted #92 was genuinely `diverged`, 8
ahead / 36 behind. Ordinary non-rebase merge at `1c36c19501c4bed44a849f02e07b4fe639667a1c`; no rebase,
force-push, squash, merge to `main`, or propagation into #94+.

### One conflict, where both sides excluded the same budget for different reasons

`draft-disposition.ts`, the computation of `remainingMs`. Each segment had added its own reason the
provider's automated-response budget does **not** apply, and each reason had already cost this product a
working feature once.

#93's reason: the budget is Instagram's and only Instagram's, because WhatsApp publishes no such deadline,
so measuring one against a WhatsApp send would shorten or abandon the human-like delay for a rule that
platform does not impose. The accepted segment's reason: it must not apply to a planned follow-up, whose
anchor is the customer's last message — a follow-up exists precisely because they stopped writing, so the
budget is always already spent, and applying it sent **every** follow-up to `DEADLINE_MISSED`. That
docstring's own words: the feature "could be wired up correctly end to end and still never send anything".

Keeping either alone reintroduces a defect already found and accepted as fixed. The union is all three
conditions — a budget only when there is a `lastInboundAt`, **and** the channel is Instagram, **and** the
draft is not a follow-up — with a docstring carrying both reasons and recording that each has cost a
feature. The comment above `timing` was trimmed rather than left restating the first reason, because two
statements of one rule drift apart.

**Both halves are pinned, and establishing that took two passes.** Dropping the follow-up exclusion fails
two cases. Dropping the channel exclusion appeared to fail nothing — a conclusion I nearly published, and
it was wrong: that run had #93's own slice suite not executing. With the suite running, dropping the same
clause fails `schedules through the shared disposition, with a delay the delay engine chose`. **A mutation
result is only as good as the suite that ran.**

### The branch's flagship suite was not running, and said "skipped"

`whatsapp-slice.integration.test.ts` is thirteen end-to-end cases and the whole point of P4-07. It failed in
`beforeAll` on `automation_policies_profile_default_key`, because the fixture hand-wrote a profile default
that `createBusinessProfile` has written since the accepted P3-02 head. Vitest then reports that file's
cases as **skipped**, so a batched run reads `1090 passed | 13 skipped` and looks green; only a single-file
run prints the `FAIL`. This is the second occurrence of that masking — the first was #91's presence handler.

Fixed as before: edit the existing default rather than create a second one. The E2E project went from 95
files with 1090 passed and 13 skipped to **96 files with 1103 passed and no skips**.

**The standing rule this leaves:** in an infrastructure run with `TEST_DATABASE_URL` and `TEST_REDIS_URL`
set, a non-zero skip count is a failure until explained. The suites are gated on exactly those variables, so
nothing should skip.

### Step 3's other named re-checks

`createHandlers` is unchanged at six parameters — #93 adds no queue family, so the arity fallout that hit
two earlier links did not recur — and the `loops` list is unchanged. The accepted #92 behaviour is intact:
the echo reaches `process-event.ts`'s `case "OUTBOUND_ECHO"`, `ingestion-store.ts` sets
`UNMATCHED_OUTBOUND_ECHO` only when the state is not already `HUMAN_ACTIVE`, and the self-message refusal
with `sameNumber` survives untouched with the WhatsApp suite's normalization cases passing. #93 adds no
migration and drift is clean.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; `--maxWorkers=2` throughout; focused packages run
separately with their own labels; `db:generate` before typecheck.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries | exit 0, 14 packages; 13 packages, **578** source files, 0 cycles |
| `@omnichannel/domain` | 6 files, **138/138** |
| `@omnichannel/application` | 14 files, **294/294** |
| `@omnichannel/channel-whatsapp` | 9 files, **166/166** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 39 files, **804/804**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **55/55** |
| worker + web E2E | 96 files, **1103/1103**, **no skips** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0; 127 files passed / 59 skipped, **1844 passed** / 1041 skipped |

**Disclosed limitations.** The flagship slice suite **failed on the first run of this head** and is reported
as fixed rather than as green first time — it is described above. No other retries, no flakes, and no test
skipped to make a gate pass. The 1041 skipped tests in the no-infrastructure run are the PostgreSQL and
Redis suites declining to start without `TEST_DATABASE_URL` / `TEST_REDIS_URL`, which is what CI relies on;
that is the one place a skip count is expected, and it is 59 files rather than 58 because this head adds the
slice suite to them. With the services present nothing skips at all. Local runs are macOS; the authoritative
Linux evidence is the exact-head GitHub Actions run.

## PR #93 accepted, and joined to #94 / P3-04 — 2026-10-18

**#93 is accepted at `f3243dea3674d28242a812c8feb49013282d5cdf`** — Gemini/Antigravity formal GitHub review
`5563083113`, `APPROVED`, 2026-10-18T12:59:07Z. **Phase 4 is complete**: #87 through #93 each carry their own
exact-head verdict.

**Routing unchanged.** **#94 / P3-04 is the sole gate; #95 onwards are frozen.**

**Ancestry.** Both segments fork from `e439f39ab2a402707978f5c9cd58bbf16c9ff1e1` — the accepted #93 segment
38 commits ahead of it, #94's authored segment 10 — so #94 against accepted #93 was genuinely `diverged`, 10
ahead / 38 behind. Ordinary non-rebase merge at `449696ba9271cab97c76c0cda261b0e8d25db363`; no rebase,
force-push, squash, merge to `main`, or propagation into #95+.

### The worker lifecycle, and the count that merged cleanly while being wrong

Both conflicts were measured from the #93 gate before this directive existed, with `git merge-tree` and no
checkout, and reported there. The directive then stated the required outcome — seven loop entries, seven
close calls, prose saying "seven" — which is what this merge produced. The useful part is that **only two of
the three places were conflicts**.

`main.ts` conflicted on the `loops` array: #94 had added `"retention"` to a list that did not yet contain
`"follow_ups"`, while the accepted head had `"follow_ups"` in a reformatted multi-line list. Resolved as the
union, with #93's comment widened to cover both unconditional sweepers.

**The shutdown block conflicted with nothing.** Git merged both additions cleanly, so the list correctly
gained `retention.close()` beside `followUpSweeper.close()` — seven calls — while the comment above still
read "six independent closes". #94's diff had bumped that word from "five" to "six" because its base lacked
the follow-up sweeper, and the accepted side also said "six", so there was nothing for git to stop on.
Nothing typechecks a number in a comment and no test reads one. It now says "seven", and the three counts
are compared against each other rather than trusted.

`main.test.ts` conflicted on the whole-list assertion and was resolved to the seven-entry list in the order
`main.ts` reports. **Its sibling case also needed a change that was not a conflict:** the boot-without-key
case asserts `not.toContain("instagram_tokens")` then `toContain("follow_ups")`, calling that "the
unconditional loop" — singular, and correct when `follow_ups` was the only one. `retention` is unconditional
too, so it is asserted there now; a loop checked only in the fully-configured case is a loop that case would
not notice losing.

### Deletion and export are reachable from nothing, and that is now owned rather than open

Re-measured on the merged head with bare re-exports and migration comments excluded:
`requestDeletion`, `requestProfileDeletion`, `executeDeletion`, `listDeletionRequests` and `exportContact`
have **no real caller**. The retention sweeper this branch adds calls only `deleteExpiredConnectStates`, and
nothing under `apps/web` references any of the five.

**Reconciled against Issue #57, store-only is the intended scope of P3-04**, and the evidence is recorded in
`docs/tasks/CLAUDE_EXECUTION_QUEUE.md` rather than summarised here: the issue is titled "…deletion
*foundations*", its required behaviour and tests describe capabilities and workflow states rather than any
interface, its acceptance criteria are satisfied by the store layer, two of the four specs it names
(`MVP_RELEASE_SCOPE.md`, `TEAM_ROLES_UX.md`) do not exist in the repository at all, and the privacy spec
describes *who may* act while demonstrably knowing how to flag an absent surface when it means one.

**What was genuinely ambiguous was ownership of the surface, and it now has a name.** It is not P7-01: Issue
#59 builds a platform operator console and states the boundary itself — internal SUPPORT / BILLING /
OPERATIONS / PLATFORM_ADMIN roles kept "separate from customer OWNER / ADMIN / AGENT roles" — while deletion
and export are customer admin-or-owner actions, so placing them there would breach that issue's own role
separation. Its MVP surface list excludes them, and neither P7 branch references any of the five functions.
Phase 5 runs P5-01 to P5-10 and completes without a privacy screen, so **P5-11** is proposed and specified in
the queue document. Opening that issue is the owner's action; the specification is the record this directive
asked for.

### A missing authorization check on a cross-profile write, found and fixed in this cycle

Checking that the merge preserved the tenancy invariants rather than assuming it had: #94 adds
`requireWorkspaceWideWrite` to `tenancy.ts` and calls it from nowhere. Tracing where its rule is actually
applied found three workspace-scoped writes, and `saveStyleProfile` — the base voice every Business Profile
inherits — had **no role check at all**, so a member granted a single profile, including an `AGENT`, could
rewrite the voice every profile replies in. Its siblings `createKnowledge` and `createStyleExample` do
enforce the role half, and the privacy spec assigns these acts to an admin or owner, so this was an omission
rather than a delegation. Untested.

Fixed by mirroring the sibling: `requireRole(context, WORKSPACE_ADMIN_ROLES, …)` for the `WORKSPACE` case,
with three cases pinning it — an `AGENT` refused, the same agent still writing their own profile's layer as
the control, an `ADMIN` allowed — and the guard's removal failing the agent case alone. Judged inside step
5's carve-out because Issue #57's first required behaviour is that authorization be "Workspace + role +
BP-scope + action specific".

The `ALL`-scope half is **proposed, not done**: wiring `requireWorkspaceWideWrite` needs three web actions to
obtain a `WorkspaceContext`, which reaches into a layer this propagation never touched. The gap it leaves:
an ADMIN with `SELECTED` scope — a state `addWorkspaceMember`'s own comment confirms is supported — can
create Workspace-scoped knowledge or style examples that profiles they were never granted will read.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; `--maxWorkers=2` throughout; focused packages run
separately with their own labels; `db:generate` before typecheck. **Any unexplained skip treated as a
failure**, per the directive.

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint + boundaries | exit 0, 14 packages; 13 packages, **585** source files, 0 cycles |
| `@omnichannel/domain` | 6 files, **138/138** |
| `@omnichannel/application` | 14 files, **294/294** |
| `@omnichannel/channel-whatsapp` | 9 files, **166/166** |
| `apps/worker` lifecycle (`main.test.ts`) | 1 file, **10/10** |
| PostgreSQL suites (`REQUIRE_DB_TESTS=1`) | 41 files, **836/836**, no skips |
| Redis suites (`REQUIRE_REDIS_TESTS=1`) | 3 files, **55/55** |
| worker + web E2E | 96 files, **1103/1103**, **no skips** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify`, service variables unset) | exit 0; 127 files passed / 61 skipped, **1844 passed** / 1073 skipped |

**Disclosed limitations.** No retries, no reruns, no flakes, and nothing skipped to make a gate pass. **With
the service variables present nothing skipped at all**, which is the condition the directive set. The 1070
skips in the no-infrastructure run are the PostgreSQL and Redis suites declining to start without
`TEST_DATABASE_URL` / `TEST_REDIS_URL` — the behaviour CI relies on — and the file count is 61 rather than
58 because this head adds the deletion and privacy suites to them. One honest note on the branch's own code:
the new `startRetentionSweeper` has no dedicated test file, and its startup is covered only through the
worker lifecycle case that now asserts the loop. That matches `backlog-guard` and `reconciliation-sweeper`,
which have none either, while the follow-up, outbox and Instagram-token sweepers do — a mixed pattern in the
repository rather than something this merge introduced. Local runs are macOS; the authoritative Linux
evidence is the exact-head GitHub Actions run.

## PR #94 `CHANGES_REQUESTED`, remediated — 2026-10-18

**Review `5563757640`, state `CHANGES_REQUESTED`, at exact head
`5da1213cce104bf21ff0d697021db97867da7c58`.** Gemini/Antigravity independently reproduced the
authorization finding this branch had disclosed, naming three scenarios — Knowledge Hijack, Knowledge
Denial of Service, Style Governance Bypass — and specified remediation matching the patch already prepared
locally. The owner's `CLAUDE_FIX_DIRECTIVE_FROM_PR94_CHANGES_REQUESTED` directed it onto the branch.

**Routing unchanged.** **#94 / P3-04 remains the sole gate; #95 onwards are frozen.** No rebase,
force-push, squash, merge to `main`, or propagation into #95+.

### One shape of mistake, five call sites

Making a Workspace-scoped row required `WORKSPACE_ADMIN_ROLES`; changing or retiring one required nothing
beyond access to any single Business Profile. Every lifecycle call resolved its row through
`scopeFilter(undefined, …)` or `exampleScopeFilter(undefined, …)`, whose `null` branch **is** the
Workspace-scoped row, and applied no role check.

- `editKnowledge` — rewrite the facts every profile answers from.
- `archiveKnowledge` — retire it from every profile's retrieval. This one wrote through a blind
  `updateMany` and never read the row, so an ownership read had to be added before a guard had anything to
  check.
- `restoreKnowledge` / `publishKnowledge` (the same function under two buttons) — put it back into every
  profile's retrieval. The guard sits **above** the `act` check: a refusal that depended on `act` would
  leave whichever screen omitted it unguarded.
- `decide` — approve, reject, archive and restore a shared style example, through one private helper, so
  one guard covers all four. Its selected row gained `businessProfileId`, which it had not read.
- `saveStyleProfile` — rewrite the voice every profile replies in. Fixed earlier, at `5da1213`.

Approve and restore both stamp `approvedByUserId`, and a CHECK requires that name for anything `ACTIVE` —
the database insisting a human verified it. Unguarded, an agent could supply that provenance for content
every profile's voice draws on, which is why this was more than an integrity question.

### Reachability, stated rather than implied

Approve and reject start from `SUGGESTED`, and **no writer in this repository produces a Workspace-scoped
suggestion**: `suggestStyleExample`, the composer's learning write and `recordEditedDraft` all stamp
`profileScopeOf(context).businessProfileId`, while `createStyleExample` lands a Workspace example straight
in `ACTIVE`. Those two rows are inserted directly by the tests and the guard on those transitions is
defensive. Archive, restore, publish and all four knowledge paths are reachable from ordinary screens.

### Tests, and the control each one needs

Fifteen cases across the two integration suites: an `AGENT` refused for every listed Workspace-scoped
mutation, the **same agent still performing the corresponding profile-scoped operation** as the control,
and an `ADMIN` allowed for each act the agent was refused. Without that last row the refusals would also
pass if the lifecycle were simply broken for everyone.

Each guard was then removed one at a time and the owning suite rerun, because a refusal test that still
passes with its guard gone proves nothing:

| guard removed | suite result |
|---|---|
| `editKnowledge` | 1 failed / 51 passed — the knowledge refusal case |
| `archiveKnowledge` | 1 failed / 51 passed — same case |
| `restoreKnowledge` / `publishKnowledge` | 1 failed / 51 passed — same case |
| `decide` | **4 failed** / 45 passed — archive, approve, reject and restore refusals |
| `saveStyleProfile` | the voice refusal case failed |

All five are individually pinned. The knowledge refusals share one `it`, so a failure names the case rather
than the guard; each was still isolated by removing one guard at a time with the others present.

**A mistake worth recording.** The first mutation loop restored each file with `git checkout --`, which
reverted the *uncommitted* patch instead of only the mutation, so runs two through five measured a file
with no guards at all rather than one missing guard. The reverted work was recovered from the patch
artifact and the loop rerun against a scratchpad snapshot. Never restore an uncommitted working tree from
git.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7 in Docker; `--maxWorkers=2`; a dedicated shadow database for the
drift check. **Any unexplained skip treated as a failure.**

| what | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint / boundaries | exit 0 / exit 0 / exit 0 |
| unit suites (`pnpm test`) | 188 files, **2932/2932** |
| PostgreSQL suites (`pnpm test:db`) | 41 files, **851/851**, no skips |
| Redis suites (`pnpm test:redis`) | 3 files, **55/55** |
| worker + web E2E (`pnpm test:e2e`) | 96 files, **1103/1103** |
| evals | **20/20, 0 failed, 0 quality regressions** |
| production build | exit 0 |
| no-infrastructure path (`pnpm verify` under `env -i`) | exit 0; 127 files passed / 61 skipped, **1844 passed** / 1088 skipped |

The two suites this change touches are **52/52** (knowledge) and **50/50** (style), up by 3 and 12
cases — 15 in all, which is also the +15 in the `pnpm test:db` total above.

**Disclosed limitations.** No retries, no reruns, no flakes, nothing skipped to make a gate pass; with the
service variables present nothing skipped at all. The 1088 skips in the no-infrastructure run are the
PostgreSQL and Redis suites declining to start without `TEST_DATABASE_URL` / `TEST_REDIS_URL`, the
behaviour CI relies on. The ADMIN + `SELECTED`-scope half remains open by this directive's own step 4: an
ADMIN holding only `SELECTED` profiles can still create Workspace-scoped knowledge or style examples that
profiles they were never granted will read. Local runs are macOS; the authoritative Linux evidence is the
exact-head GitHub Actions run.

## PR #94 round two — the refusal tests were green and proved nothing — 2026-10-18

The remediation above was correct in the source and **vacuous in the tests**, which I established by
adversarially re-checking my own work rather than by being told. Both halves are now fixed on the same
branch.

### What was wrong with tests that all passed

Every refusal case asserted only `rejects.toBeInstanceOf(WorkspacePermissionError)`. Nothing read the row
back. Two of the five guarded functions — `archiveKnowledge` and `saveStyleProfile` — are **not
transactional**, so a guard that fired *after* its write would throw exactly the same error while the write
committed anyway. Measured, with the guard moved below its `updateMany` and nothing else changed:

| mutation | before this round | now |
|---|---|---|
| `archiveKnowledge` guard moved below its write | **52/52 passed** — and the shared source committed as `ARCHIVED` | **1 failed**, the archive refusal |
| `saveStyleProfile` guard moved after the write *and* the audit | **50/50 passed** — the agent's persona committed to the `businessProfileId = null` layer, audit row claiming the save | **1 failed**, the voice refusal |

So an `AGENT` archived a Workspace-wide knowledge source out of every profile's retrieval, and rewrote the
voice every profile inherits, with the whole suite green. I had checked guard *sensitivity* — remove the
guard, does a test fail — and never checked that a refusal **changes nothing**. Those are different
questions and only the second one is the behaviour.

### What else the re-check found, all now fixed

- **Bundled assertions hid three guards behind one.** The knowledge refusals were five `await expect`s in
  one `it`; the first failure ends the case, so the later acts were pinned only while the earlier guard
  held. Removing all three knowledge guards reported exactly **one** failure. Now one act per case.
- **`publishKnowledge` *is* `restoreKnowledge`** (`export const publishKnowledge = restoreKnowledge`), so
  three of those five assertions shared one guard and differed only in `act`. Stated in the test now
  instead of reading as five independent acts.
- **"The same agent" was not the same agent.** Every control created a second user — `"Knowledge Agent"`
  refused, `"Knowledge Agent Two"` allowed. Equivalent principals, so the risk was low, but the claim was
  false as written. Each control now refuses the shared row **and** performs the profile-scoped act as one
  principal, which also made each guard removal fail more cases.
- **The provenance argument was asserted nowhere.** The commit's central claim is that an unguarded approve
  lets an agent supply the verified-human stamp a CHECK requires. No case read `approvedByUserId`. The
  refusal now asserts the row stays `SUGGESTED` **and** unstamped; the admin case asserts the admin is
  stamped.
- **A doc comment asserted the opposite of the code.** `restoreStyleExample` said "The approver is
  re-stamped rather than left as it was"; `decide` writes `approvedByUserId` only when the row has none,
  and its own comment calls re-stamping the bug that was removed. Verified against the implementation and
  the comment corrected. My own test comment repeated the false claim and is corrected too — what a
  restore actually protects is the *retrieval* half.

**Not a finding, recorded so it is not re-litigated:** the `?? ""` id fallbacks are safe. A missed lookup
yields `""`, which matches no row and returns `GONE` — a resolved promise, so every refusal case fails
loudly rather than passing for the wrong reason.

### Guard sensitivity at this head

| guard removed | cases failed |
|---|---|
| `editKnowledge` | 1 |
| `archiveKnowledge` | 2 |
| `restoreKnowledge` / `publishKnowledge` | 1 |
| `decide` | **7** |
| `saveStyleProfile` | 2 |

### Verification

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint / boundaries | exit 0 / exit 0 / exit 0 |
| unit suites | **2934/2934** |
| PostgreSQL suites | 41 files, **853/853**, no skips |
| Redis suites | **55/55** |
| worker + web E2E | 96 files, **1103/1103** |
| evals | **20/20**, 0 quality regressions |
| production build | exit 0 |
| no-infrastructure `pnpm verify` under `env -i` | exit 0; 1844 passed / 1090 skipped |

The two suites are **54/54** (knowledge) and **50/50** (style).

### A live instance of the same class, upstream — disclosed, not fixed here

Re-bounding the class across every write in `packages/db` — rather than trusting the earlier bound — found
**`saveStageDisplays` (`lead-store.ts:76`)**: `LeadStageDisplay` has **no `businessProfileId` column**, is
keyed `@@unique([workspaceId, stage])`, and `readStageDisplays` reads it by `workspaceId` alone, so it is
the lead board every profile sees. The function takes a `BusinessProfileContext` and then
`deleteMany({ where: { workspaceId: context.workspaceId } })`, recreating every stage row. No role check at
any layer: `saveStagesAction` calls only `requireBusinessProfileContext`, and the Leads page renders the
form with no role conditional. **An AGENT with one profile can rename, reorder and hide the lead stages on
every other profile's board.** It also never calls `profileScopeOf`, so the branded-context validation
never runs there.

**Introduced by `3c666dd`, which is #80 / P5-07 — upstream of this branch.** Fixing it here would sit
downstream of its own origin and leave #80→#93 carrying the hole, so it belongs at #80 as its own
directive.

**Why the earlier bound missed it:** that bound was built by grepping the idiom
`{ OR: [{ businessProfileId: null }, { businessProfileId }] }`, which **structurally cannot see a model
with no `businessProfileId` column**. Enumerate by write and ask "can more than one Business Profile read
this row?" — a grep for a scope filter answers a narrower question than the one that matters.

Also unguarded and currently unreachable: `recordIndexingResult` (`knowledge-store.ts:608`) can flip a
shared source to `ARCHIVED` with no role check, and `seedKnowledge` / `seedStyleExample`
(`retrieval/seed.ts:44`, `:100`) default to Workspace-wide, bypass the guarded writers, and
`seedStyleExample` writes `ACTIVE` with `approved_by_user_id = context.userId` — minting exactly the
provenance `decide`'s guard withholds. Both exported from `index.ts`.

## P5-07 authorization fix — the shared lead board had no role check — 2026-10-19

**Found while bounding a different authorization class on PR #94 (P3-04), and traced back to this branch
as its origin (`3c666dd`).** The owner directed the fix here rather than downstream, so this head moves and
the `ANTIGRAVITY_REVIEW: PASS head=bd1c039998fb41fe339af97ae2dc5e515810aa6c` no longer covers it: #80 needs
a fresh verdict, and the chain below it needs this merged down one link at a time.

### What was wrong

`lead_stage_displays` has **no `business_profile_id` column**. It is keyed `(workspace_id, stage)`, and
`readStageDisplays` reads it by Workspace alone, so the labels, order and hidden flags are the board
**every** Business Profile in the Workspace sees. `saveStageDisplays` took a `BusinessProfileContext`, then
inside one transaction deleted every row for `context.workspaceId` and recreated them from the submitted
form — with no role check at any layer. `saveStagesAction` called only `requireBusinessProfileContext`, and
the Leads page rendered the `StageConfig` form unconditionally.

**So an AGENT granted a single Business Profile could rename, reorder and hide the lead stages on every
other profile's board**, and hiding a stage takes those leads off everyone's board view.

A second defect in the same function: it reached for `context.workspaceId` directly and never called
`profileScopeOf`, so the branded-context validation in `tenancy.ts` — the check that a context was issued
by `authorizeBusinessProfileAccess` rather than assembled as a plain object — never ran on that path. It
and `readStageDisplays` were the only two functions in `lead-store.ts` that skipped it; the other six call
it.

### The fix

- `saveStageDisplays` requires `WORKSPACE_ADMIN_ROLES`, **before the input validation**: whether a member
  may reconfigure the shared board does not depend on whether their form was well formed, and an
  unauthorized post should not be able to probe the validation rules. That ordering matches
  `createStyleExample`, which guards before it validates.
- Both `saveStageDisplays` and `readStageDisplays` now call `profileScopeOf(context)` and use
  `scope.workspaceId`. The read keeps no role check — every role sees the board.
- `leads/page.tsx` computes `canConfigure = WORKSPACE_ADMIN_ROLES.includes(context.role)` and renders
  `StageConfig` only for an admin or owner, the same gate the channels and setup screens use. The store
  refuses it either way; hiding the form is so an agent is answered by the page rather than by an error
  boundary — the doctrine `settings-actions.ts` states.

### Tests, and why they read the rows back

Four cases: an AGENT refused with the `lead_stage_displays` rows asserted **unchanged**; an AGENT posting
*invalid* input still refused with the permission error rather than a validation message; the **same**
AGENT still moving a lead and still reading the board; an ADMIN succeeding with the configuration asserted
to have really landed.

The control is a different shape from the knowledge and style ones on #94: `LeadStageDisplay` has no
profile column, so there is **no profile-scoped variant** to fall back on. What must still work is the
ordinary pipeline, which is what the third case asserts.

The rows are read back rather than the exception being trusted, which is the lesson from #94's own round
two — there, refusal tests that asserted only the thrown error passed 52/52 and 50/50 while the write
committed. Measured here, each mutation applied alone:

| mutation | result |
|---|---|
| guard deleted | **3 failed** |
| guard moved after the transaction commits | **2 failed**, including "the board every profile reads does not move" |
| guard moved after the input validation | **1 failed**, the probe case |

### Verification

Real PostgreSQL 17 + pgvector and Redis 7; `--maxWorkers=2`; dedicated shadow database for the drift check.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| typecheck / lint / boundaries | exit 0 / exit 0 / exit 0 — 13 packages, 452 source files, no cycles |
| unit suites | 138 files, **2039/2039** |
| PostgreSQL suites | 27 files, **492/492**, no skips |
| Redis suites | **51/51** |
| worker + web E2E | **832/832** |
| evals | **20/20**, 0 quality regressions |
| production build | exit 0 |
| no-infrastructure `pnpm verify` under `env -i` | exit 0; **1424 passed / 615 skipped** |

These line up with the numbers the accepted review recorded for `bd1c039` — 488 PostgreSQL cases and
1424/611 — plus exactly the four cases this change adds, which skip without infrastructure.

## The P5-07 propagation reaches its last link — P3-04 / PR #94 — 2026-10-20

The directive on #93 propagated the accepted `feat/p4-07-whatsapp-slice` head
`8a84f3109c5468ddf80ddb0c4dc2e9d1e0cdbdea` into `feat/p3-04-privacy-deletion`, whose head was
`df77cd717c68104333942bc077e44b4b27f2c689`. This is the **fifteenth and final** link of the lead-board
authorization propagation, which began at its origin on #80 and moved one branch per directive.

### What the merge actually carried

**Nothing under `apps/` or `packages/`.** `git diff $(git merge-base T P) P` names exactly two files,
both documentation:

| file | why it differed |
|---|---|
| `docs/handoff/CURRENT_HANDOFF.md` | merged cleanly |
| `docs/tasks/CLAUDE_EXECUTION_QUEUE.md` | three conflict regions, resolved as unions |

That is the expected shape at the end of a propagation: every code change the fix needed had already
arrived at #93 and was verified there, so the last link carries only the record of it. The emptiness was
**measured, not assumed** — the diff was taken against the merge base, never two-way against the target,
which is the error that makes a propagation look larger than it is.

Both live segments were then checked by name rather than by the absence of a conflict, because
[[merge-fallout-without-conflict]] is this chain's recurring failure mode — five shapes merge clean and
still break. Every file below is byte-identical to the pre-merge target:

`knowledge-store.ts`, `style-store.ts`, `deletion-store.ts`, `tenancy.ts`, `lead-store.ts`,
`apps/worker/src/main.ts`, `apps/worker/src/draft-disposition.ts`.

And the individual contracts each segment owns are all present: four `requireRole` guards in the
knowledge store and three in the style store; `requireWorkspaceWideWrite` defined in `tenancy.ts` and
still — deliberately — with no caller; the lead-board role check; `transcription: producer` in
`dispatchOutbox`; both presence spreads keyed on `presenceAnnouncer === undefined`; and the three-part
automated-response budget union that keeps a follow-up sendable.

### The queue conflict

Three regions, one of them 247 lines that exist only on this side. Resolved by exact conflict-marker line
numbers rather than by a regex over the file — an earlier attempt at the latter miscounted the regions
and captured a `>>>>>>>` that belonged inside one side. The union was then checked mechanically in both
directions: the child contributes 220 lines over the base with 4 lines missing, all four being headings
renamed on purpose so that the file keeps exactly **one** `### Current work`; the parent contributes 46
lines with **nothing** missing.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database for the drift check.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` (typecheck, lint, test, build) | exit 0 — 188 files, **2938/2938** |
| PostgreSQL suites | 41 files, **857/857**, **no skips** |
| Redis suites | **55/55** |
| worker + web E2E | **1103/1103** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **1844 passed / 1094 skipped**, with zero infrastructure variables in the environment |

The two suites this branch exists for were run by name to confirm they execute rather than skip:
`deletion.integration.test.ts` and `privacy.integration.test.ts` — **2 files, 29/29**. The P4-07 slice
that arrived from the parent was likewise run by name: **13/13**. The P3-04 knowledge and style suites:
**2 files, 104/104**.

### A failure that was mine, not the code's — disclosed because the first run was red

Those deletion and privacy suites **first failed, 17 errors**, every one
`TypeError: Cannot read properties of undefined (reading 'create')`. That is not a defect in this head
and not a flake. The generated Prisma client in my working copy was stale after a day of branch
switching, so the client had no model for tables this branch adds.
`pnpm --filter @omnichannel/db db:generate` fixed it and the suites then passed 29/29.

This is worth recording rather than quietly re-running, for a reason that is general: the `typecheck`
script **begins** with `prisma generate`, so `pnpm verify` regenerates the client every time. On the
previous fourteen links I ran `verify` first and the staleness could never surface. Here I ran the
targeted suites first, in isolation, and got a red result that said nothing about the code.

**The rule:** a suite invoked directly through Vitest, outside `pnpm verify`, can be running against a
client generated on a different branch. Run `db:generate` before any targeted database suite after a
branch change, and never read such a failure as evidence about the branch until the client's provenance
is established. Related: [[vitest-green-tsc-red]], which is the same gap seen from the other side —
Vitest transpiles without typechecking, so neither tool alone tells you the generated code matches.

## P6-02 usage ledger, and the accepted #95 propagated into it — PR #96 — 2026-10-21

#95 was accepted at `1c23f1b107a7c20a3c2d03b4f43e0316cfc91b67` (formal exact-head review, 2026-10-20),
and the directive propagated that head into `feat/p6-02-usage-ledger`, which was at
`d5c563d0d920a51664e4882f246ef9fbccde9cca` — **73 commits behind** while carrying 9 of its own.

### What P6-02 is, recorded here for the first time

The work was on the branch and verified there, but neither canonical document named it. That is a gap in
the record, not in the code, and it is closed now.

**Two kinds of counting, and keeping them apart is the point.** An *internal metric* serves unit
economics, fair use, anomaly alerting and capacity planning, and **can never refuse work**. A
*customer-facing quota* is an allowance a plan sells, and exhausting it stops the thing it pays for. Core
AI replies are included and unmetered in the initial plans, and `AI_GENERATION_CYCLES` being internal is
how the code *states* that rather than merely documenting it: `reserve` against an internal metric is
refused with `NOT_A_QUOTA`, in the store and again by a CHECK, so there is no path by which an exhausted
allowance could hold a reply.

**One logical operation is counted once, and the database enforces it.** Every write names a
`usageOperationId` built from facts fixed before the work started, and `usage_ledger_operation_key` is
unique on `(workspace, metric, operation, kind)`. A duplicate worker, a provider retry or a requeued job
cannot double-count — not because a caller checked first, which a second worker can lose a race against,
but because the second insert is refused.

**The last unit of an allowance cannot be sold twice.** `reserveUsage` locks the counter row, resolves the
entitlement and decides *inside* that lock, so the read, the judgement and the write describe one instant.
Commit and release settle a hold; `d5c563d` races two settlements of one hold precisely to prove the lock
does what the prose claims. Stale holds expire via `expireStaleReservations` on a 30-minute TTL, swept by
the worker's `usage_reservations` loop.

**Ingestion never calls any of it**, so nothing here can stop an inbound message being persisted.

### The merge, and the one resolution that mattered

`apps/worker/src/main.ts` and `main.test.ts` conflicted. **This is the most consequential resolution of
the whole propagation, and the conflict markers showed two of the six edits it needed** — because both
sides add a background loop the other lacks. This branch starts the usage-reservation sweeper; the
accepted parent starts the follow-up sweeper. Keeping either side would have silently stopped a loop that
is wired and running: the Issue #9 defect arriving through a merge instead of through code.

| # | place | shown by a marker? |
|---|---|---|
| 1 | the `loops:` report — a union of three, in the order `main.ts` prints them | yes |
| 2 | the comment enumerating the unconditional loops | yes |
| 3 | **the count in prose** — "seven independent closes" over what is now eight | **no** |
| 4 | the expected list in `main.test.ts`, asserted as the *whole* list on purpose | yes |
| 5 | that test's explanatory comment | yes |
| 6 | **the sibling case** pinning the unconditional loops when the token refresh cannot start — it had `follow_ups` and `retention` but not `usage_reservations`, and its own comment says a loop checked only in the fully-configured case is one it would not notice losing | **no** |

Git merged the eight declarations and the eight `close()` calls correctly by itself. The array was counted
by bracket depth rather than by eye, after a first attempt with a line range overran the end and reported
eleven — a reminder that a count is evidence only if the thing counted is the thing bounded.

`packages/db/prisma/schema.prisma`, `packages/db/src/index.ts` and `apps/web/src/server/simulation.ts`
merged **clean**. Checked rather than trusted: **56 models against 56 `CREATE TABLE` statements** (52 at
#95 plus P6-02's `UsageCycle`, `UsageLedgerEntry`, `UsageCounter`, `UsageReservation`), no duplicate name
across the barrel's 51 export lines, and no drift. P6-02's own `usage.ts` and `usage.test.ts` are
byte-identical to the pre-merge head.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` (typecheck, lint, test, build) | exit 0 — 193 files, **3033/3033** |
| PostgreSQL suites | 43 files, **910/910**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | **1106/1106** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **1886 passed / 1147 skipped**, zero infrastructure variables in the environment |

Run by name, so that "it executed" is measured rather than inferred from a total:

| suite | result |
|---|---|
| `apps/worker` `main.test.ts` — where the six-edit resolution lives | **10/10** |
| `packages/domain` `usage.test.ts` (P6-02) | **24/24** |
| `packages/db` `usage-store.integration.test.ts` (P6-02) | **27/27** |
| `apps/worker` `usage-sweeper.test.ts` (P6-02) | **3/3** |
| `packages/db` `entitlements.integration.test.ts` — the parent's P6-01 | **23/23** |

Against #95's accepted numbers (193 vs 190 files, 3033 vs 2976 tests; PG 43 vs 42 files, 910 vs 880
cases; E2E 1106 vs 1103) the deltas are exactly P6-02's own suites.

### The resolution was mutation-checked, because "it passes" was the weakest possible evidence here

The whole risk was a loop silently vanishing, so a passing suite proves nothing unless it would have
failed. Each loop removed from the report, one at a time, against the restored file:

| mutation | result |
|---|---|
| drop `"usage_reservations"` | **2 failed**, 8 passed |
| drop `"follow_ups"` | **2 failed**, 8 passed |
| drop `"retention"` | **2 failed**, 8 passed |
| control, unmutated | **10 passed** |

**And edit 6 was then shown to carry its own weight rather than being tidy-up.** With the sibling case's
new `toContain("usage_reservations")` reverted, dropping that loop fails **one** test instead of two — the
whole-list assertion only. The second failure is the no-credential-key configuration, which the full-list
case never exercises. That is precisely the gap the test's own comment warned about.

Both files were restored from scratchpad copies and verified by `git hash-object` rather than by
`git checkout --`, which discards uncommitted work.

## P6-03 entitlement enforcement, and the accepted #96 propagated into it — PR #97 — 2026-10-21

#96 was accepted at `8ce410252269fb6dd5af0737df3f310290e49542`, and the directive propagated it into
`feat/p6-03-entitlement-enforcement`, which was at `94f37d8770e0779da3512d3b9eab8bfbecfa21ec` — **74
commits behind** while carrying 11 of its own.

### What P6-03 is, recorded here for the first time

**The commercial fact is three booleans, and it is required rather than optional.** `CommercialAccess`
carries `paidWorkAllowed`, `aiDrafts` and `autopilot`; `PolicyInput.commercial` is required, and its own
comment says why — an optional commercial fact would default to "allowed" at every site that forgot it,
which is the one direction a billing boundary must never fail in. Required, the compiler names every
caller that has to decide. This propagation produced exactly such a caller and the compiler named it.

**Three refusal codes, because they call for three different actions from whoever reads them.**
`BILLING_INACTIVE` → pay, and deliberately not a claim about the plan's contents: a workspace on the best
plan in the catalogue carries it the day after its card fails. `BILLING_FEATURE_OFF` → change plan, and
the *server* decides it, so a business that set AUTOPILOT on a plan not selling it gets replies held for a
person however the screen looked when they chose. `BILLING_LIMIT` → wait for the cycle or top up, and
never invent the thing that could not be paid for; core AI replies cannot produce it, because the initial
plans do not meter them.

**An approval answers these gates**, so the manual path stays open while automation is held and a
workspace whose billing lapsed is still usable. And the `aiDrafts` check is repeated at the decision even
though generation refuses earlier, on the rule its comment states: a gate that trusts an upstream layer to
have already checked is not a gate.

### The merge: three conflicts, and the one that was a real collision

`apps/web/src/server/simulation.ts` and `packages/db/src/testing/fixtures.ts` were both "each side appends
its own thing" — an import line, and two helper functions sharing one doc-comment opener. Resolved as
unions, and then every imported name was checked to be *used*, because an import union that leaves one
unused fails `eslint --max-warnings=0`. Both halves of `fixtures.ts` have live callers
(`setProfileDefaultPolicy` in five suites, `createPaidWorkspace` in five more), so neither side was
droppable.

**`createBusinessProfile` in `packages/db/src/repositories/workspaces.ts` was a genuine semantic
collision.** This branch wraps the create in its own transaction with the capacity lock and
`PlanLimitError`; the accepted parent writes the profile's default automation policy as a nested create in
the same statement. Neither side's `create` call had the other's contribution, so **either side taken
whole loses a feature** — the capacity ceiling, or the policy every profile is born with. The union keeps
both, with the nested policy write inside the transaction the capacity check already holds.

### Two defects that merged clean, and one that compiled and still failed

| what | found by | why no conflict |
|---|---|---|
| `policy-store.integration.test.ts` called `createBusinessProfile(tx, …)` | `tsc` | this branch changed the signature to `DbClient`; the test lives on the other side and never conflicted |
| `simulation-inputs.test.ts` built a `PolicyInput` with no `commercial` | `tsc` | the field became required here; the fixture is the parent's |
| `followup-slice.integration.test.ts` left three follow-ups `PENDING` | the suite | its workspace had no subscription, so the billing gate refused every send |

**On the first: a cast would have been worse than the type error.** Prisma would open a second,
independent transaction, so the test's outer rollback would never reach the inner one and the case would
assert a guarantee nobody provides. The case is removed with an in-file note recording where its property
is still covered — and, explicitly, what is not.

**On the third: the suite had silently become a test of the billing gate** — passing or failing for a
reason it was not written to examine. `apps/worker/src/testing/paid-workspace.ts` exists precisely to
prevent that, and its own doc comment says so; four sibling slice suites already used it and this one did
not. Converted to it.

### Disclosed, not fixed: the capacity lock has no test that observes it

Mutation-checking my own resolution produced one result I did not expect and will not paper over.

| mutation | result |
|---|---|
| drop the nested `automationPolicies` write | **29 of 37** `policy-store` cases fail |
| drop the `serializeCapacity` call | `entitlements.integration` still passes **33/33** |

The second is a real coverage gap, and it is mine from the earlier P6-03 work rather than anything this
merge did. The case named *"holds a capacity lock only for as long as the transaction that took it"*
**never calls `createBusinessProfile`**: it pins a fact about PostgreSQL — an advisory lock taken under
autocommit is gone by the next statement, one taken inside a transaction survives it. That fact is true
and is the premise the fix rests on, but the function's own lock is unobserved, so the line can be deleted
with nothing going red.

Two comments overclaimed on the strength of that test and both are corrected on this commit: the one in
`workspaces.ts` which said the test "pins the lock lifetime the argument rests on", and the note I had
just written in `policy-store.integration.test.ts`. What would close the gap is an observer reading
`pg_locks` while the function's count-and-insert runs — not added here, because this directive bounds the
change to the propagation, and a new concurrency test belongs in its own reviewed change.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database; every gate run after the
documentation edits.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` (typecheck, lint, test, build) | exit 0 — 194 files, **3090/3090** |
| PostgreSQL suites | 44 files, **928/928**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 97 files, **1117/1117** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **1914 passed / 1176 skipped**, zero infrastructure variables present |

Run by name, the enforcement and concurrency suites the directive asks for:

| suite | result |
|---|---|
| `delivery-store.integration` — a revocation driven through a waiting send | **49/49** |
| `entitlements.integration` — capacity refusal and lock-lifetime | **33/33** |
| `domain/entitlements` | **29/29** |
| `policy/evaluate` — the billing gate inside the decision | **94/94** |
| `ai/generate-draft` — draft-generation blockers | **44/44** |
| `usage-store.integration` — the P6-02 settlement race | **27/27** |
| `policy-store.integration` — the file this merge edited | **37/37** |
| `simulation-inputs` — the fixture this merge edited | **19/19** |

Totals moved 193→194 files and 3033→3090 tests, PG 43→44 files and 910→928 cases, E2E 1106→1117.

## P6-06 commercial catalogue, and the accepted #97 propagated into it — PR #98 — 2026-10-21

#97 was accepted at `2aaf661574a9f2b72dbb6243111bef2e5afb0499`, and the directive propagated it into
`feat/p6-06-commercial-catalog`, which was at `c32b9fb6b15cd37a19429910ebd8b6e13909a328` — **75 commits
behind** while carrying 12 of its own.

### What P6-06 is, recorded here for the first time

**The price book is data, in one file, read through the ordinary catalogue store.** The spec requires that
public pricing come from the plan catalogue rather than duplicated constants, so a pricing page reads it
through `readCatalog`. The consequence is the point: a price shown to a customer and a price they are
charged **cannot drift apart, because there is only one of them.** Starter / Growth / Scale in EUR, with
immutable versions — re-pricing or re-packaging publishes a new version, and triggers refuse an edit or a
delete on either table.

**Add-ons come in two kinds and the distinction is structural.** `RECURRING_CAPACITY` raises a limit while
held (one more Business Profile at €25/mo, one more seat at €7/mo); `ONE_TIME_ALLOWANCE` tops up a metered
allowance once (voice packs of 500, 2,000 and 5,000 minutes).

**Two absences are load-bearing.** There is **no AI-reply quota** — core generation is customer-facing
`UNMETERED` on every paid tier, so no `AI_GENERATION_CYCLES` entry exists to find; the ledger still counts
generations internally, which is a different thing and must never be shown as a billable allowance. And
there are **no provider price identifiers** — those are references a billing adapter fills once a provider
is chosen (#41), and the catalogue is interpretable without them because a plan's entitlements come from
its own grants, never from a provider's price object. Verified on this head: zero occurrences of
`price_`, `prod_`, `cus_`, `sub_` or any provider name across `accepted-catalog.ts`, `catalog-store.ts`
and `scripts/catalog/publish.ts`.

**`pnpm catalog:publish` is the producer, and its absence had not been a small gap.**
`publishAcceptedCatalog` was reachable only from tests, so a deployed database held no plan versions and
no prices at all — and that does not fail loudly. It fails quietly in three places at once: the first
Business Profile connects, `ensureWorkspaceTrial` finds no trial plan and silently returns
`{ started: false }`; `readCheckoutOffer` has nothing to quote and refuses with `NO_PRICE`; the billing
screen reads an empty catalogue, so a pricing page shows nothing to buy. Each reads like a product
decision rather than a missing deployment step, which is why it survived review — the same shape as the
release tables before `pnpm release:record` existed.

**Publishing is deliberately not idempotent, and the script states it rather than pretending.**
`publishPlanVersion` cuts version N+1 every time, so a repeat is "wasteful rather than wrong": a second
identical version goes on sale while `readCatalog` still answers with one plan per code. The script
declines by default once anything is published and reports what it found; `--republish` cuts a new version
deliberately, which is what a changed price needs; `--dry-run` writes nothing and reports the decision.

### The merge: zero conflicts, and for once that was the truth

The two links before this one both merged clean in files that then failed to compile, so the merged tree
was typechecked before anything else: **0 TypeScript errors**. The reason is in #98's own history — it had
merged #97's earlier states four times, the last being `c32b9fb` *"Merge the capacity-lock correction"*,
so its callers were already adapted to the required `PolicyInput.commercial` and to
`createBusinessProfile`'s `DbClient` signature. **A branch that tracks its parent pays the propagation
cost in instalments**, which is the first time in this chain that has shown up as a measurable saving.

Checked anyway, because the absence of a conflict is not evidence:

| check | result |
|---|---|
| models vs `CREATE TABLE` statements | **62 = 62** |
| duplicate name across the barrel's 53 export lines | none |
| migration drift | **No difference detected.** |
| worker loop registry | **8 loops, 8 `close()` calls, prose says "eight"** |

That last one was counted by bracket depth after a line-anchored pattern reported seven — it had missed
the conditional `...(tokenRefresh.running ? …)` spread. Same lesson as the eleven-vs-eight miscount two
links ago: a count is evidence only if the thing counted is the thing bounded.

### The capacity-lock record, carried forward unchanged

Per the directive's point 6: Gemini accepted the capacity-lock implementation as architecturally sound,
and the direct `createBusinessProfile` observer/interleaving test **remains absent**. That gap is **not**
closed, and nothing in this link closes it. The correction published on #97 (comment 6305293853) also
stands: the review's §3.B cited `entitlement-lock.integration.test.ts` as proving it, and that file covers
a *different* advisory lock — the entitlement key ordering a plan change against a delivery claim. With
`serializeCapacity` deleted, that file still passes 6/6, `entitlements.integration` 33/33 and
`policy-store.integration` 37/37.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` (typecheck, lint, test, build) | exit 0 — 196 files, **3123/3123** |
| PostgreSQL suites | 45 files, **956/956**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 97 files, **1117/1117** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **1919 passed / 1204 skipped**, zero infrastructure variables present |

Run by name:

| suite | result |
|---|---|
| `catalog.integration` — versioning, add-ons, top-ups (P6-06) | **28/28** |
| `scripts/catalog/publish.test.ts` — the producer | **5/5** |
| `entitlements.integration` — capacity and lock lifetime (P6-03) | **33/33** |
| `entitlement-lock.integration` — the *other* advisory lock | **6/6** |
| `delivery-store.integration` — revocation through a waiting send | **49/49** |
| `usage-store.integration` — the P6-02 settlement race | **27/27** |
| `apps/worker` `main.test.ts` — the loop registry | **10/10** |

**Every test file in the repository runs in `pnpm verify`**, including the root tooling ones: the root
vitest config declares a third project, `tooling`, over `scripts/**/*.test.ts`. Verified by arithmetic —
170 `.test.ts` plus 23 `.test.tsx` under `apps/` and `packages/`, plus 3 under `scripts/`, is exactly the
196 files `verify` reports.

Totals: 194→196 files and 3090→3123 tests, PG 44→45 files and 928→956 cases; E2E unchanged at 1117.

## P6-05 billing and usage settings screen, and the accepted #98 propagated into it — PR #99 — 2026-10-21

#98 was accepted at `28ff22f963da6786941c654831a5e053a57185e4`, and the directive propagated it into
`feat/p6-05-billing-settings-ui`, which was at `be39535e74d12634fbcf4756804fe1897fbc5b0c` — **76 commits
behind** while carrying 12 of its own.

### What P6-05 is, recorded here for the first time

**The browser is never the authority.** A checkout return parameter is read and all it decides is which
*sentence* to show; the plan, the state and the dates are the server's answer at `at`. So a page reached
with `?checkout=success` after a payment no webhook has confirmed shows the subscription as it actually is
and says a confirmation is pending, rather than claiming an upgrade the system has not seen.

**A downgrade is explained before it is offered.** Nothing is deleted, and the person is shown *which* of
their resources exceed the new plan, so every offer carries its own consequences instead of a yes-or-no.
`planChangeConsequences` names the excess on the stated ground that *"you are over"* is not something
anybody can act on and *"these three Business Profiles are over"* is.

**The arithmetic lives in the domain, not in a component.** `packages/domain/src/plan-change.ts` holds the
change consequences and `ALLOWANCE_HEALTHS` (`OK` / `WARNING` / `EXHAUSTED`), because a number a business
is about to act on should not be computed where nothing can test it.

**`CHECKOUT_AVAILABLE` is one named constant and is deliberately `false`** until a provider adapter exists
(#41) — stated once rather than as scattered conditionals, so the screen says "not available here" in one
voice and there is a single place to change later.

**No provider identifier reaches the page.** The read model copies an amount and a currency and drops the
provider's own price object; mutations are OWNER-only with authorization re-resolved from the database on
every call. And the screen is assembled away from the authenticated request path, exactly as
`style-screen.ts` is — `billing-page.ts` adds authorization and the translator and cannot be imported
under Vitest because Auth.js reaches for Next's server runtime. That line is why a *screen* has a
14-case integration suite at all.

### The merge

**Zero conflicts and zero application-code edits — the second link running.** The merged tree was
typechecked before anything else (**0 TypeScript errors**), because the two links before #98 merged clean
and then failed to compile. The cause is the same as #98's: this branch had been tracking its parent, so
its callers were already adapted to the contracts #97 changed.

| check | result |
|---|---|
| models vs `CREATE TABLE` statements | **62 = 62** |
| duplicate export name in the barrel | none |
| migration drift | **No difference detected.** |
| worker loop registry | **8 loops, 8 `close()` calls, prose "eight"** (bracket-depth count) |

**The guard that mattered most here is the provider boundary**, since this is the first UI that displays
money: `billing-screen.integration.test.ts` serialises the entire screen and asserts it contains no
`providerPriceId`. It passes, as do the three `apps/web/src/i18n` gates — which fail a *build* rather than
a test, and so are the ones a UI-heavy branch can least afford to merge blindly.

### The capacity-lock record, carried forward unchanged

Per the directive's point 5: the implementation was accepted as architecturally sound and the direct
`createBusinessProfile` observer/interleaving test **remains absent**. Not closed, not claimed closed, and
not this link's to close. #98's own review carried the same record correctly, citing the correction
published on #97 rather than the misattributed file.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` (typecheck, lint, test, build) | exit 0 — 200 files, **3196/3196** |
| PostgreSQL suites | 46 files, **978/978**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 99 files, **1155/1155** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **1956 passed / 1240 skipped**, zero infrastructure variables present |

Run by name:

| suite | result |
|---|---|
| `billing-screen.integration` — read model and the provider-leak guard | **14/14** |
| `ui/billing/billing-panes` — the screen's components | **24/24** |
| `billing-overview.integration` — the store read behind it | **18/18** |
| `domain/plan-change` — downgrade consequences and allowance health | **13/13** |
| the three `apps/web/src/i18n` gates | **34/34** |
| `catalog.integration` — P6-06 | **28/28** |
| `entitlements.integration` — P6-03 | **37/37** |
| `usage-store.integration` — P6-02 | **27/27** |

Totals: 196→200 files and 3123→3196 tests, PG 45→46 files and 956→978 cases, E2E 97→99 files and
1117→1155. Note `entitlements.integration` itself moved 33→37: this branch adds four cases to it, which is
why that suite's number differs from the one recorded for #98.

## P6-08 seller profiles and billing routing, and the accepted #99 propagated into it — PR #100 — 2026-10-21

#99 was accepted at `9b3823f2776eb0d221c10f2cf1df8c43c947543d`, and the directive propagated it into
`feat/p6-08-billing-routing-seller-profiles`, which was at `23b1a61f5c856983001f33763efe7be6d40cd0f9` —
**77 commits behind** while carrying **19** of its own, the largest own contribution in the chain.

### The reviewer route changed on the same day

The owner made **Codex/Astra the primary independent reviewer and paused Gemini/AntiGravity** (Issue #7,
comment 6308798183; echoed on #100 as 6308804154). Earlier Gemini PASSes at their exact heads — #96
through #99 and predecessors — **remain accepted and are not to be repeated**. New gates route to Astra
alone with **no fallback**.

**Corrected within the hour, and the correction matters the other way round** (Issue #7, comment
6309185847): **Astra has usage available now** and no `WAIT_ASTRA_QUOTA` hold is authorized; it is
**Gemini** whose weekly quota is exhausted, replenishing in about three days. The first routing comment
had the two models reversed, and I repeated it here and in my #100 readiness comment before the
correction arrived. A routing or availability statement is a claim like any other: attribute it, and
expect it to be the kind of thing that gets corrected. Either way the directive is explicit that none of
it authorizes pretending a reviewer has been launched, and nothing about my own work changed — the marker
is `CLAUDE_READY_FOR_ASTRA`, which it has always been.

### What P6-08 is, recorded here for the first time

**The payment provider and the selling legal entity are two different choices**, because the market treats
them as two. A direct processor leaves us the seller of record; a Merchant of Record *is* the seller to the
customer and remits the tax. The same provider can serve two seller entities and the same entity can sell
through two providers, so `SellerProfile` and `BillingRoute` are separate rows and a route names one of
each. Settlement models are `DIRECT_PSP`, `MERCHANT_OF_RECORD` and `CRYPTO_PROCESSOR`.

**Providers differ, and pretending otherwise is how a product ships a lie.** A route *declares* its
capabilities; nothing assumes recurring subscriptions, proration, invoices or tax remittance. Tax
**calculation** and tax **remittance** are two capabilities on purpose — a processor that can work out VAT
is not thereby the Merchant of Record for it.

**Two payment models normalize into one entitlement layer.** `RECURRING` and `PREPAID_TERM` both grant
service; the difference is whether a renewal may be *assumed*, so a prepaid term always carries an
explicit end.

**Money is never a float and a quote is never a price change.** Amounts are whole minor units of a named
currency or asset. The catalogue may price a plan in EUR while a crypto route quotes the same plan in an
asset for fifteen minutes; the quote records what was asked and settles or does not, and the plan's
meaning is untouched either way.

**The client never names a route, a provider account or a selling entity.** `openCheckoutContract` takes
a plan version, an interval, an arrangement kind and a currency — the product facts a customer may choose
— and the route comes from operator configuration the customer cannot write. There is **no parameter in
which a forged identifier could arrive**, which is a stronger statement than validating one would be.

**A checkout is written before the customer is sent anywhere and never edited after**: what was offered,
by which seller entity, at what price, which terms were accepted. A trigger freezes it, and a deferred
constraint trigger refuses to let it commit without its acceptances.

**Only a verified provider event or an authoritative reconciliation activates anything.**
`VerifiedBillingEvent` cannot be constructed outside `billing-events.ts`, so a success-page handler has no
way to reach the activation path even by mistake, and `ACTIVATION_SOURCES` is exactly `VERIFIED_EVENT` and
`RECONCILIATION`. **A browser redirect cannot activate paid entitlement.**

**One live charge path per workspace**, enforced by a partial unique index rather than an application
check — because the race it prevents, two checkouts completing at once, is the one an application check
loses. A provider switch ends the old arrangement and opens the new one in a single transaction.

### The merge: zero conflicts, three defects, and none of them anybody's fault alone

This is the link where "zero conflicts" was most misleading. All three defects were in
`apps/worker/src/main.ts` and its test, all three would have passed every gate, and in each case **neither
side was wrong on its own**:

| the merge produced | where each half came from |
|---|---|
| 9 loops and 9 `close()` calls under prose reading *"eight independent closes"* | the ninth loop (`checkout_expiry`, from `startBillingSweeper`) is this branch's; the word "eight" is the accepted parent's |
| the comment enumerating unconditional loops named three of four | the same split |
| the sibling test case pinned `follow_ups`, `retention` and `usage_reservations` but **not** `checkout_expiry` | this branch had no positive assertions in that case at all; the parent contributed exactly three |

That third one is the interesting shape: the parent supplied the *pattern* of pinning unconditional loops
and this branch supplied the *loop*, so the merge produced a case that pins three of four and looks
deliberate.

All three corrected here, and the correction mutation-checked rather than trusted:

| mutation | result |
|---|---|
| drop `"checkout_expiry"` from the report | **2 failed**, 8 passed |
| drop `"usage_reservations"` | **2 failed**, 8 passed |
| drop `"follow_ups"` | **2 failed**, 8 passed |
| control | **10 passed** |
| revert the new sibling pin, then drop `"checkout_expiry"` | **1 failed** — which is what shows the pin covers the no-credential-key case the whole-list assertion never reaches |

Files were restored from scratchpad copies and verified by `git hash-object`.

Everything else was clean and checked: **69 models against 69 `CREATE TABLE` statements**, no duplicate
export name in the barrel, no drift, and **0 TypeScript errors** on the merged tree.

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` (typecheck, lint, test, build) | exit 0 — 204 files, **3302/3302** |
| PostgreSQL suites | 47 files, **1035/1035**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 100 files, **1158/1158** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **2005 passed / 1297 skipped**, zero infrastructure variables present |

Run by name, covering what the directive's point 7 lists:

| suite | result |
|---|---|
| `billing-routing.integration` — routes, contracts, arrangements, activation | **57/57** |
| `domain/billing-routing` — route coherence, capabilities, quote arithmetic | **38/38** |
| `scripts/billing/publish-routes` — the route producer | **8/8** |
| `billing-screen.integration` — provider-leak guard and untrusted redirect | **14/14** |
| `no-provider-payloads` — the import boundary | **6/6** |
| `catalog.integration` — P6-06 catalogue, add-ons, top-ups | **28/28** |
| `entitlements.integration` — capacity concurrency | **37/37** |
| `usage-store.integration` — idempotency and replay | **27/27** |
| `apps/worker` `main.test.ts` — the nine-loop registry | **10/10** |

Totals: 200→204 files and 3196→3302 tests, PG 46→47 files and 978→1035 cases, E2E 99→100 files and
1155→1158.

No production payment provider, Merchant of Record, seller jurisdiction, tax position or financial term
was chosen; no production route, provider account or identifier was registered; no credentials or
production APIs were used; nothing was published, deployed or released.

## PR #100 `CHANGES_REQUESTED` by Astra, remediated — 2026-10-21

The first blocking verdict of this chain, and Astra's first review since the route changed. Three
findings on `55fbf98`, all real, all in code I wrote. Each was verified by reading the code before
anything was changed.

### P1 — an older-term reversal revoked a newer paid term on the same arrangement

`billing-routing-store.ts`'s `END` branch asked only whether the arrangement was still live and then
wrote `INACTIVE`, so a February chargeback took away access paid for through April. The
superseded-arrangement case that already existed is a *different* shape — there the two terms are two
rows and the guard is structural. Here one arrangement holds two consecutive terms and nothing but
attribution can tell them apart. The asymmetry had been sitting in the file: `SUBSCRIPTION_CANCELED`
preserved a future `paidThrough`; a reversal did not.

**The fix asks two questions**, because a reversal can be identified two ways and the ordinary case is
neither missing a field nor a puzzle:

1. what the provider says — a stated `periodEndsAt` ending before what is already paid for names an
   earlier term outright;
2. what the ledger says — where no period is stated, if the event that granted the term in force occurred
   *later* than the payment being taken back, that term was bought separately.

`writeEvent` now retains a stated period on every event row, so the audit trail can answer (2)
afterwards rather than only at the moment of processing.

**My first attempt at this was wrong, and an existing test caught it.** Treating every unstated period as
"ambiguous, so change nothing" broke the ordinary case: refunding the only payment ever made *is* the
current term and must still revoke it. The qualifier in the finding is "a **separately paid** current
term", and separateness is a fact about the ledger rather than about a missing field. Worth recording
because the wrong fix passed four of my own new tests and failed one old one.

### P1 — a delayed renewal moved the paid-through date backwards

The maximum the code computed guarded only the fallback used when a provider states no period of its own,
so a provider that *does* state one — the normal case — wrote its value straight into the subscription.
Event-id idempotency cannot help: a reordered delivery is a different event, legitimately processed,
carrying an older term.

**And the fix for it was itself incomplete — which the concurrency test Astra asked for is what found.** A
read-then-write comparison is not concurrency-safe. Two renewals with different event ids are two
transactions; both read the same `paidThrough`, both decide they extend it, and the one that commits
second wins, so a renewal buying *less* time still overwrote one buying more. The racing test failed on
`2026-12-07` where it expected `2027-01-07`.

The write now carries the comparison: `extendSubscription` is a conditional `updateMany` whose predicate
holds the term, so under READ COMMITTED the second transaction blocks on the row and re-evaluates against
the committed value. That is the same reasoning the file already applies to
`billing_arrangements_one_live_key` — a decision an application makes before a write is a decision another
writer can invalidate.

### P2 — a verified event was not actually immutable

`Object.freeze` is shallow and the spread feeding it was shallow too, so a minted event shared its
`settled` object and its `Date`s with the adapter that produced them. The adapter could raise the amount
afterwards; anybody holding the event could call `periodEndsAt.setUTCFullYear`; a `WeakSet` membership
test could see neither — while the function's own comment promised precisely that this could not happen.
Another instance of a comment asserting the opposite of its code.

Fixed in three steps, each closing a different hole: the mint **snapshots** nested money and dates, so the
adapter's references are severed; the freeze still stops a field being replaced outright; and the
`WeakSet` becomes a **`WeakMap` of the authenticated facts**, so `assertVerifiedBillingEvent` recomputes
them and an event altered after minting is no longer the event that was verified. A `Date` cannot be made
immutable, so the answer is not to try — it is to make the edit **detectable**. The file's own prose, the
refusal message and the top-of-file description were all corrected to say what the mechanism now is.

### The regressions, and their controls

Fourteen new cases. Seven in `billing-routing.integration.test.ts`: both reversal kinds naming the first
term, an unstated-period reversal, a reordered renewal, a concurrent renewal race, and **two positive
controls** without which the whole thing could collapse into "reversals and renewals do nothing" — a
reversal of the payment that bought the term in force still revokes, and a renewal that genuinely buys
more time still extends.

Seven more in a new `packages/db/src/billing-events.test.ts`, which needs no infrastructure and therefore
runs in the **fast** gate rather than only the infrastructure job. Every case performs the mutation rather
than asserting a shape: a test checking `Object.isFrozen` would have passed against the defect.

| mutation | result |
|---|---|
| the whole store reverted to its pre-fix version | **5 failed** — exactly the new regressions; both positive controls pass |
| the event module reverted to its pre-fix version | **4 of 7 failed** — the three that pass are the control, the forged-object refusal and the field-replacement freeze, all true before |

### Verification of this head

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` | exit 0 — 205 files, **3316/3316** |
| PostgreSQL suites | 48 files, **1049/1049**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 100 files, **1158/1158** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **2012 passed / 1304 skipped**; the new `billing-events.test.ts` runs here, which is the point of putting it in the fast gate |

Deltas against the reviewed head: 204→205 files and 3302→3316 tests (+1 file, +14 cases), PG 47→48 files
and 1035→1049.

### Astra's own stated limitations, carried forward honestly

The review says so itself and it belongs in the record: PostgreSQL, Redis and the container runtime were
unavailable to it, so it did not execute the DB/Redis concurrency suites, migration drift, full E2E,
verify/build/lint/typecheck or evals, and it does not certify the remaining requirements. Its three
findings were reproduced through an in-process probe with a fake adapter and a DbClient double — which
was enough, because all three were real. The capacity-lock observer gap remains explicitly unverified and
non-blocking.

## PR #100 round two — both of my remediations had holes — 2026-10-21

Astra re-reviewed `a5efdf9` and returned `CHANGES_REQUESTED` again. Two findings, **both against my own
fixes rather than the original code**, both right, and neither catchable by the tests I had written —
because I wrote those to the shape of my fix instead of the shape of the defect.

### P1 — I correlated a reversal by the wrong fact

The ledger check compared the granting payment's `occurredAt` with the **reversal's** `occurredAt`. But a
reversal's `occurredAt` is when the reversal was *raised*, not when the charge it reverses was made —
`NormalizedBillingEvent` defines it that way — so a refund issued today for last month's invoice is
legitimately *newer* than today's renewal, and went straight through the guard that existed to stop it.

**My own regression hid it.** I gave the reversal the old payment's timestamp, which covers an old
reversal *delivered late* and not a new reversal *of an old charge*. Astra named that distinction
precisely.

Time cannot answer the question, so identity does. Attribution is now three steps:

1. a stated period ending before what is paid for → an earlier term, no revocation;
2. a stated period reaching the current term → it names *that* term, revoke;
3. no stated period → ask the ledger how many payments have granted a term on this arrangement. **One**
   means there is nothing to confuse: the money being returned bought the access, which is the ordinary
   refund. **More than one** means only the provider's own charge reference can say — retained on every
   event row by `writeEvent` for exactly this purpose — and absent or unmatched, a term somebody paid for
   is not deleted on a maybe.

### P2 — the tamper check guarded the wrong moment

The fingerprint correctly rejects a `Date` mutated *before* entry. But asserting answers a question about
one instant, and `recordVerifiedBillingEvent` then awaits a route lookup, a transaction and several
queries. A caller still holding the object it passed in can move a `Date` inside it while any of those are
pending. Astra's reproduction: a renewal minted ending 2027-01-07, mutated to 2099 during a deliberately
gated route lookup, produced `APPLIED/EXTEND` and a subscription ending **2099**-01-07.

Re-asserting after each await would not close it — there is always another await. So the boundary takes a
**private snapshot**: `snapshotVerifiedBillingEvent` authenticates and returns a frozen deep copy, and the
store reads that copy for all nineteen of its later `event.` accesses. The caller's object is never read
again, and the parameter is renamed `delivered` so that is visible at the signature.

### Five more regressions, including the one that is hard to write

| case | what it pins |
|---|---|
| `REFUNDED` raised **after** the renewal, no period stated | the hole in my first attribution fix |
| `CHARGEBACK` the same | the second mapping row, which could have been wrong alone |
| an ordinary refund of the only payment ever made | that the identity check has not degenerated into "an unstated reversal never does anything" |
| a reversal naming the charge that bought the current term | that identity, when it *can* be shown, still revokes |
| **the asynchronous case** — gate the real route lookup, mutate the caller-held event, release | that the altered year reaches neither a row nor the audit detail |

The asynchronous one drives the real store against the real database with only the route lookup gated,
because the window being tested exists *between* awaits rather than inside a mock.

| mutation | result |
|---|---|
| both files reverted to the exact code Astra reviewed | **3 failed** — the two reversal cases and the interleaving case |
| the two new controls, same mutation | **pass** — they describe behaviour that was already correct |

### Verification of this head

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` | exit 0 — 205 files, **3321/3321** |
| PostgreSQL suites | 48 files, **1054/1054**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 100 files, **1158/1158** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **2012 passed / 1309 skipped** |

### The lesson, recorded because it is the whole point of the round

**A regression written from the fix can only confirm the fix.** Both holes were in tests I wrote
immediately after making a change, from the shape of the change. The cases that found them —
"reversal raised after the renewal" and "mutate during an await" — come from the shape of the *defect*,
which is the thing an author is worst placed to see and an adversarial reviewer is best placed to name.
Astra's executed evidence was again narrower than mine (no PostgreSQL, Redis, drift, E2E, verify or
evals, stated plainly in the review) and again more useful.

Its progress notes are recorded too: the stated-term reversal and reordered-renewal fixes were confirmed
working, the seven new unit tests were confirmed to execute real mutations, and the conditional
`updateMany` was read but **not** certified for real PostgreSQL concurrency — that remains covered only by
my own racing test. The `createBusinessProfile` interleaving gap stays open and non-blocking.

## PR #100 round three — what an authenticated payload can actually prove — 2026-10-21

Astra confirmed round two closed the asynchronous `Date` mutation, and confirmed the historical-reversal
and reordered-renewal behaviour. Two findings remained, both on reversal attribution, and together they
say something sharper than either does alone: **I kept reaching for evidence the payload does not
contain.**

### P1 — a subscription reference is not proof of a payment

`NormalizedBillingEvent.providerReference` is documented as "the provider's own subscription **or** charge
object", so on a recurring arrangement two separately paid terms legitimately carry the same value. My
comparison treated a match as identity, so a refund of the *first* charge — arriving with the shared
subscription id — matched the current row and revoked the *second* term. Reproduced with
`providerReference='sub-shared'`.

### P1 — "the most recent grant" is not the payment that bought the term in force

Selecting `orderBy occurredAt desc` picks by event **time**, while the monotonic renewal rule I added in
round one deliberately lets a **delayed** event buy a term reaching *farther* than one already applied. So
a refund of the shorter, later-raised grant ended the longer term a delayed renewal had bought.

**The two fixes were individually right and contradicted each other.** That is the shape worth carrying
forward: a guard added in one round can invalidate an assumption another round relies on, and nothing in
the type system or the suite notices.

### The repair is to stop guessing

A reversal on an arrangement with more than one grant now revokes **only** when it *states* a period
reaching the term in force — the one proof the payload carries. The reference comparison is gone, with the
reason written into the code so nobody restores it, and the latest-grant selection is gone with it: the
ledger is only **counted** now. A single grant still revokes unconditionally, because there is no other
term it could concern. Anything else is recorded with `effect: NONE`, audited, and left to
`reconcileProviderState`, which *reads the provider* rather than inferring from a field that cannot
answer.

The cost is explicit and stated in the code: a disputed term stays live until that read. The alternative
deletes a term somebody paid for on the strength of a guess, which is worse and irreversible from inside
the transaction.

**Attribution is persisted rather than inferred**, as asked: `writeEvent` now records the
`appliedTermEndsAt` that the grant actually put in force — read back from the arrangement inside the same
transaction — so fallback-computed terms are attributable too, not only the ones a provider chose to
state.

### One of my own controls had to go

*"Revokes the current term when the reversal names the charge that bought it"* encoded exactly the
reference matching Astra rejected. It is replaced by a control that proves the same intent with evidence
that holds: a reversal stating the period the current term covers.

**And a second test went with it by accident, which is worth recording rather than smoothing over.** The
replacement was applied as a block spanning to the next `it(`, and that range swallowed a neighbour —
*"still revokes when the reversal is of the payment that bought the term in force"*, my own round-one
positive control. The two were near-duplicates, so no behaviour lost its only cover, but the deleted one
asserted the arrangement reaching `ENDED` and the replacement did not. That assertion is carried into the
surviving case rather than left out. Caught by arithmetic: the suite gained two tests where the edits
should have added three. **A block replacement anchored on "the next thing that looks like this" deletes
whatever sits between.** Three regressions join it — both
reversal kinds sharing a subscription reference, and a refund of the shorter grant against a longer term
bought by a delayed renewal.

| mutation | result |
|---|---|
| the store reverted to the reviewed `beba1f9` | **3 failed** — the two shared-reference cases and the reordered-grant case |
| the replaced control, same mutation | **passes in both states** — it rests on a proof that was always honoured |

### The pattern across three rounds, stated plainly

Round one: I fixed the defects and wrote tests from the shape of my fix. Round two: both fixes had holes,
found by cases derived from the shape of the *defect*. Round three: my own two fixes contradicted each
other, and the evidence I reached for did not exist in the payload.

The common thread is not carelessness about tests — every round was mutation-checked and every round's
tests did fail against the code they were written for. It is that **an author's tests inherit the
author's model of the problem.** Astra's executed evidence was narrower than mine in all three rounds, and
more useful in all three, because it was derived from the contract rather than from my implementation.

### Verification of this head (round three)

Real PostgreSQL 17 + pgvector and Redis 7; dedicated shadow database.

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` | exit 0 — 205 files, **3323/3323** |
| PostgreSQL suites | 48 files, **1056/1056**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 100 files, **1158/1158** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **2012 passed / 1311 skipped** |

## P6-09 terms acceptance, and the accepted #100 propagated into it — PR #101 — 2026-10-22

#100 was accepted at `27baa3d918001443080c534380a7b44acdf498d5` — after four Astra rounds, three of them
`CHANGES_REQUESTED` — and the directive propagated it into `feat/p6-09-terms-acceptance-ux`, which was at
`cd25fa2fd3b00ff71522aae025b14334ea8f46e6`, **81 commits behind** while carrying 19 of its own.

### What P6-09 is

**The screen exists because of one sentence in the spec:** acceptance of the Public Offer and the Terms is
evidenced by an explicit control **before** the redirect, not by the later act of payment. A product that
inferred consent from a completed charge would hold no record of what anybody agreed to, and no way to
answer the only question a dispute asks — *which version, in which language, by whom, and when.*

The checkout step therefore shows four things a person must be able to read before committing: **who is
selling to them** (the legal entity, not the product's brand), **what it costs**, **who remits the tax** —
on a Merchant-of-Record route the invoice is the provider's and its own terms additionally apply at its
hosted checkout — and **the exact document versions** being accepted, each as its own tick, **none
pre-ticked**.

**Nothing on the screen decides anything.** The server refuses a submission with a box unticked whatever
was rendered, refuses a superseded version, and refuses a route whose provider cannot settle. Like
`billing-screen.ts`, it is assembled away from the authenticated request path so a test can drive it.

**The migration closes two places where #46 left the store and the database disagreeing about what
"accepted" means.** The applicability trigger now requires each acceptance to name the **current** version
of its kind and locale, and the coverage trigger reads the requirement from the current version rather
than from any effective row — which also closes the opposite hole, where an old version marked required
went on demanding an acceptance after a newer version had stopped requiring one. Before this, a caller
reaching the tables directly could satisfy the trigger with a superseded version.

**The locale disagreement was worse than a mismatch.** `readLegalDocumentOffers` filtered by an exact
locale while the trigger filtered by none, so a workspace whose interface language the offer had not been
translated into was offered **no documents at all** and then had its checkout killed by the trigger with a
raw exception. The product half of the fix is locale negotiation in the store; the evidence half is
`legal_acceptances.locale`, recording the language of the page somebody actually accepted on.
`REFUND_POLICY` joins the document kinds so the policy is linkable rather than implied.

### The merge: two conflicts, and the one that mattered

`packages/db/src/billing-routing-store.ts` — **the file four review rounds had just rewritten.** #101
added 354 lines to it while the accepted parent carried every round of the P6-08 remediation, so git
conflicted on a single import line and **auto-merged the rest.** Resolved as the union the calls actually
require:

| symbol | whose | called at |
|---|---|---|
| `billingProviderRegistered` | #101's | `checkoutReady` |
| `snapshotVerifiedBillingEvent` | the parent's trust boundary | the entry point |
| `assertVerifiedBillingEvent` | — | **no caller left**, dropped rather than carried for symmetry |

`apps/web/src/ui/outcome-notice.tsx` — each side appended its own refusal codes, #101's three checkout
refusals and the parent's seven. Both sets kept.

**Then every invariant the four rounds established was checked by name in the merged file**, because the
remainder of a 354-line divergence merged silently and that is exactly where this chain has been bitten
before:

| invariant | present |
|---|---|
| the private snapshot at the entry point | yes |
| `laterOf` | yes |
| `extendSubscription` (the conditional `updateMany`) | yes |
| `billingEvent.count` attribution | yes |
| `appliedTermEndsAt` retention | yes (3 sites) |
| the comment recording why `providerReference` cannot serve as charge identity | yes |

Plus the standing checks: worker registry 9 loops / 9 `close()` / prose "nine", **69 models = 69
`CREATE TABLE`**, no duplicate export name, no drift, **0 TypeScript errors**.

### Verification of this head

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` | exit 0 — 208 files, **3380/3380** |
| PostgreSQL suites | 48 files, **1077/1077**, **zero skipped or todo** |
| Redis suites | **55/55** |
| worker + web E2E | 103 files, **1187/1187** |
| evals | **20/20**, 0 quality regressions |
| no-infrastructure `pnpm verify` under `env -i` | exit 0 — **2039 passed / 1341 skipped** |

Run by name — P6-09's own surface and the regressions the four rounds added:

| suite | result |
|---|---|
| `checkout-screen.integration` | **8/8** |
| `checkout-form` | **4/4** |
| `ui/checkout/checkout-panes` | **14/14** |
| `billing-screen.integration` (extended by #101) | **15/15** |
| `no-provider-payloads` (extended by #101) | **6/6** |
| `ui/billing/billing-panes` | **26/26** |
| `billing-routing.integration` — the four rounds plus #101's 21 | **92/92** |
| `billing-events` — the snapshot and the fingerprint | **7/7** |
| `domain/billing-routing` | **45/45** |
| the three `apps/web/src/i18n` gates | **34/34** |

Totals: 205→208 files and 3323→3380 tests, PG 48 files and 1056→1077 cases, E2E 100→103 files and
1158→1187.

### The conditions #100's approval attached, carried into this link unchanged

Astra's PASS named four things to preserve, and all four hold here: multi-grant reversals with
insufficient period attribution remain an auditable `NONE` pending authoritative reconciliation; the
conditional `updateMany`'s real-PostgreSQL concurrency is still covered only by my racing test and CI, not
by independent certification; the `createBusinessProfile` lock-observer gap **remains open and
non-blocking**, and other lock tests are still not proof of that case; and the snapshot, the monotonic
guards and the conditional update are all intact, verified by name above.

## PR #101 round one — Astra's two blocking findings on P6-09 — 2026-10-22

Astra returned `CHANGES_REQUESTED` on `46e734b` with two correctness findings. Both are real, both are
fixed here, and both were the same shape as the recurring one: a correct piece with no path between it and
the thing it was supposed to protect.

### P1 — an acceptance was not bound to the offer that was displayed

The form carried the plan, the interval and the document ids. It carried nothing identifying the
*commercial* offer, and a globally-required document legitimately applies to every seller — so document
ids cannot bind the selling entity. Trusted operator configuration changing between the GET that drew the
ticks and the POST that accepted them produced a contract naming a different legal entity, a different
jurisdiction and a different tax treatment than the person had read.

The fix is an opaque digest of exactly the terms the summary renders — seller legal name, jurisdiction,
settlement model, who remits the tax, arrangement, interval and base price — computed by the store,
rendered as one hidden field, and compared inside the opening transaction against the store's own fresh
resolution. A mismatch is a new `OFFER_CHANGED` refusal placed *before* the document checks, because the
honest sentence is "the terms moved", not "you did not tick a box". The client cannot choose anything with
it: the value is only ever compared, never read as a seller, a route or a price.

**One disclosure about the reproduction.** Astra's own repro said the stale submission comes back
`available: true`. Against the real schema I could not reproduce that *in the configuration Astra
described*, because this harness's `PUBLIC_OFFER` is seller-specific: switching sellers makes the
previously-offered document inapplicable and the store refuses `DOCUMENT_NOT_APPLICABLE` — a refusal, for
the wrong reason. The defect does reproduce as `available: true` in two configurations I verified on real
PostgreSQL: a seller switch where the required documents are global, and a same-seller legal-identity
rename. The finding stands; its stated symptom depends on the catalogue.

### P2 — one language spelled two ways was two languages

`legal_documents.locale` is what "which version is current in this reader's language?" groups by.
Publication kept `input.locale` verbatim and allocated versions by that raw string, while
`negotiateDocumentLocale` canonicalizes before matching. So `en-US` and `en-us` each became version 1 of
one document, both stayed current, neither superseded the other, and a replacement published under the
other spelling left the superseded text on the checkout page.

Fixed in four places, because the identity has to mean the same thing everywhere it is used:

1. **Publication** canonicalizes the tag, refuses one it cannot parse, and stores the canonical form.
2. **Version allocation** matches existing rows by canonical equality, so a catalogue that already holds a
   non-canonical spelling still gets one sequence instead of two.
3. **The TypeScript current-document grouping** keys on the canonical language, and the winner inside a
   group is now *computed* — specificity, then `effectiveFrom`, then `version` — by a new `supersedes`.
4. **SQL**: `current_legal_documents()` groups by the locale case-folded and separator-folded, with the
   same expression in `ORDER BY` so `DISTINCT ON` keeps the newest of the collapsed group; a CHECK refuses
   the separator form no canonical tag has; and a folded unique index makes the state the defect rested on
   — two rows of one kind and one language sharing a version — unreachable.

### Why the winner had to be computed, which I did not expect

`negotiateDocumentLocale` returns the **first** candidate whose canonical tag matches, and candidates
arrive in `locale ASC` order. So before this change, which of two spellings a reader was offered came down
to the database's collation. Measured against this harness `en-us` sorts before `en-US`, which means the
alias-is-newer order happens to land on the right row and the alias-is-older order lands on the superseded
one; under a collation that sorts the other way it is the reverse. That is why both publication orders are
in the suite and why neither is sufficient alone — and it is also why reverting the grouping key alone
still passed one of my two cases until I measured it.

### The gap between two correct triggers

The coverage trigger matches an acceptance to a requirement by **kind**, so one acceptance of a kind
satisfies it however many rows `current_legal_documents()` returned — it could never have caught the
duplicate. The acceptance trigger matches by **id**, so it is the one that would have let consent to the
superseded alias through. But `openCheckoutContract` resolves the current versions in TypeScript and
refuses before any row is written, so my first store-level regression proved the store and said nothing
about the SQL at all: reverting the whole SQL change left all 100 tests green. The suite now writes an
acceptance row by raw statement against the superseded id and requires the database to raise on its own.

### What proves these are regressions and not restatements of the diff

Five mutations, each reverting one part of the fix, each caught:

| reverted | caught by |
|---|---|
| the canonical grouping key | "continues one version sequence across spellings" |
| `supersedes` back to first-row-wins | "continues one version sequence across spellings" |
| publication storing the raw spelling and allocating by string equality | that case **and** "refuses to store a spelling the database cannot group" |
| `DISTINCT ON`/`ORDER BY` back to the raw locale | "offers one current version when the replacement was written in the other spelling" |
| the folded unique index | "refuses to store a spelling the database cannot group" |

Both alias regressions write their non-canonical row by raw statement, because the fixed writer refuses to
create one — which is what makes them read a row the fix did not produce.

### An honest limit on the SQL half

No SQL expression knows that `iw` and `he` are one language. The database collapses case and separator
aliases, which is the class it can decide, and it provably cannot over-collapse: two canonical tags never
differ only in case, so no two distinct languages can land in one group. Deprecated-subtag aliases are
collapsed only by the TypeScript writer. I am not claiming the database is canonical-aware; I am claiming
it is no longer able to present two spellings of one language as two current documents.

### Verification of this head

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` under `env -i`, no infrastructure | exit 0 — 208 files, **2041 passed / 1350 skipped (3391)** |
| PostgreSQL suites | 48 files, **1086/1086** |
| Redis suites | **55/55** |
| worker + web E2E | 103 files, **1189/1189** |

Run by name:

| suite | result |
|---|---|
| `billing-routing.integration` — 92 at the reviewed head, +5 for P1, +3 for P2, +1 for the required digest | **101/101** |
| `billing-events` | **7/7** |
| `domain/billing-routing` | **45/45** |
| `checkout-screen.integration` | **8/8** |
| `checkout-form` — +2 for the digest reader | **6/6** |
| `ui/checkout/checkout-panes` | **14/14** |
| `billing-screen.integration` | **15/15** |
| `ui/billing/billing-panes` | **26/26** |
| `no-provider-payloads` | **6/6** |
| the three `apps/web/src/i18n` gates | **34/34** |

Totals: 3380→3391 tests, PostgreSQL 1077→1086. Nine of the eleven new cases are in database-gated files,
which is why the no-infrastructure run's skipped count rises by exactly nine and its passing count by the
remaining two — the digest form reader, which needs no infrastructure.

### A hole I found in my own P1 fix, before anybody claimed the head

Published as ready at `8b885c3`, then kept reading my own diff for the recurring finding class — an
optional guard — and found one. `offeredDigest` was optional and the comparison was

```ts
if (input.offeredDigest !== undefined && input.offeredDigest !== resolved.offer.offerDigest) {
```

so **a submission that simply left the field out skipped the check entirely**, restoring Astra's P1 in
full: the acceptance was recorded against whatever the store resolved at POST time with nothing binding it
to what anybody had been shown. Worse for the evidentiary purpose #47 exists for, a stored contract could
not afterwards be told apart from one that *had* been bound, because nothing recorded that the comparison
happened. A guard the untrusted client can switch off is not a guard — and the justification I had written
for making it optional, "an old page must not be refused for a digest it never carried", described a page
that does not exist in a product with no deployment, while the cost was a real bypass.

The field is now **required on `OpenCheckoutInput`**, and `offeredDigestFrom` returns `""` rather than
`undefined` for an absent form field. An empty string cannot equal a sha256 digest, so an unbound
submission is refused by the ordinary comparison: there is no `undefined` branch left to get wrong, and the
conditional spread in the server action is gone. The only production caller is
`apps/web/src/server/checkout-actions.ts` and the page always renders the field, so nothing reachable loses
a path.

Two consequences, both worth it. The digest check runs *before* the document checks, so every existing test
expecting a document refusal had to start supplying a correct digest or it would have been handed
`OFFER_CHANGED` instead — 16 call sites, enumerated by `tsc` once `Request` dropped the field, each now
fetching the digest the way the page does (a new `digestOf` helper, or the `offer` already in scope). And
the three `apps/web` cases now carry it **through the FormData**, which is more faithful than passing it
beside the form: what the server enforces should be read from what a submission actually contained.

Mutation-checked: restoring the skip-when-absent semantics fails exactly one test, the one written for it.

### Unchanged from the accepted predecessor

The four conditions #100's approval attached still hold and are unaffected by this round: multi-grant
reversals with insufficient period attribution remain an auditable `NONE`; the conditional `updateMany`'s
real-PostgreSQL concurrency is still covered only by my racing test and CI; the `createBusinessProfile`
lock-observer gap remains open and non-blocking; and the snapshot, the monotonic guards and the
conditional update are intact.

## PR #101 round two — the seller snapshot the digest was checked against — 2026-10-22

Astra returned `CHANGES_REQUESTED` on `68a94d6` with one blocker, and it is the same mistake I had already
written down after #100: **a validate-then-use boundary that crosses an `await` needs the snapshot, not a
second read.** I fixed that class in the billing event path four rounds ago, recorded the lesson, and then
wrote it again one layer below the guard I had just built.

### The defect

`resolveCheckout` reads the selling entity and `offerDigest` is computed from that row. The write path then
re-read `sellerProfile` and copied the **second** result into the immutable contract. `upsertSellerProfile`
takes neither of this transaction's two locks and the transaction is `READ COMMITTED`, so an operator update
committing between the two reads changed the persisted legal name and jurisdiction **without invalidating
the digest that had just been compared**. The acceptance then named an entity nobody had been shown — the
exact defect the digest exists to prevent, reintroduced below it.

Verified in the source before fixing: the second read fed **five** places, not the two the review located —
`sellerLegalName` and `sellerJurisdiction` on the contract, the audit summary, `sellerJurisdiction` in the
audit detail, and the `seller` on the returned `OpenedCheckout`. Replacing the binding closed all five.

### The fix

`const seller = resolved.offer.seller;` — the snapshot the digest was computed from, selected with exactly
the four fields the second read asked for, inside the same transaction. One read per transaction, so what
was checked is what is written. A later convenience read of that row anywhere below the comparison would be
the same defect again, which the comment now says in those words.

### The regression, and what designing it taught me

Deterministic rather than timed: the real Prisma client is wrapped in a proxy that commits the operator's
rename at a precise call, on a different pooled connection and therefore its own transaction. Every query
still runs against real PostgreSQL; the proxy forwards everything untouched and only chooses *when* the
competing commit lands.

**Two discoveries while building it, both of which changed the test.**

First, the selling entity is not fetched by `sellerProfile.findUnique` on the resolve path at all — it
arrives as a nested `select` under the route read. So the only `sellerProfile.findUnique*` call this
transaction ever made *was* the second read this fix removes. That turns the structural assertion from
"reads it once" into the stronger `sellerRereads === 0`: the transaction must never read that row on its
own, and a convenience re-read added anywhere would make it one.

Second, my first barrier hung off the *first* route read and the checkout came back refused. That was not a
bug in the test or the store: the candidate routes are selected by an earlier `findMany`, so committing the
rename before the read that carries the seller changes what the POST resolves, the digest legitimately
stops matching, and `OFFER_CHANGED` is the correct answer. Correct, but a different case. The window this
blocker is about opens only *after* the route read carrying the seller has resolved — the digest has then
been computed from the old row and is about to be compared and accepted. The barrier is therefore pinned to
`billingRoute.findUniqueOrThrow`, and the reason is written in the test so nobody moves it back.

The case asserts that the competing write really committed and really committed mid-transaction (without
that, every assertion below it would hold against a database nobody had changed), that the row in the
database really is the renamed one, and that the returned offer, the contract row and the audit entry all
still name `Seller Race SRL` / `RO`. Its own seller, route, currency and plan, so the rename touches nothing
shared.

Mutation-checked: restoring the second read fails exactly this case, on the returned seller first.

### Astra's own stated limits on this round, carried honestly

The review says plainly that it did **not** execute the race on PostgreSQL — the interleaving was inferred
from the two source reads, the default isolation and the absence of coordination in `upsertSellerProfile`,
and demonstrated with a database double over the real store source. My regression is the real-PostgreSQL
half, and that is now the only live-database evidence for this case. Its 109 infrastructure-gated checkout
cases were skipped on its side and are not passes; the exact-head CI run is what covers them.

### Verification of this head

| gate | result |
|---|---|
| migration drift | **No difference detected.** |
| `pnpm verify` under `env -i`, no infrastructure | exit 0 — 208 files, **2041 passed / 1351 skipped (3392)** |
| PostgreSQL suites | 48 files, **1087/1087** |
| Redis suites | **55/55** |
| worker + web E2E | 103 files, **1189/1189** |

`billing-routing.integration` is **102/102** — 92 at the first reviewed head, +5 for the digest, +3 for the
locale aliases, +1 for the required digest, +1 for this race. Totals 3391→3392, PostgreSQL 1086→1087.
