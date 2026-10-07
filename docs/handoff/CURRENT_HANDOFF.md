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

**The chain now runs to #83**, each branch stacked on its predecessor and each CI-green with evidence
posted. PRs #73–#82 are completed by Claude and awaiting review; **#83 / P5-08 is the current task**,
which the owner's directive on PR #81 placed after P3-02 and not before. Everything in Phase 1 and Phase 2 has an independent PASS at its published
head, including **#72 / P3-03 at `9955ecf6c114145d54bb7dd46abbc902267bd00c`**, **#71 / P2-09 at
`38df858508ec61e2c6821e47a0a5225c86768223`**, **#70 / P2-08 at
`c15a9a6f558d9270263ad7573669f76ca3af8ac0`**, **#69 / P2-07 at
`4c9f496d805316ded56311e41bdd4c3c39ff5a43`** and **#68 / P2-06 at
`fb35665209b90c82bc10f3068450111e75f83299`**; all are propagated downstream. Nothing is merged to `main`.

Everything is one stacked chain of unmerged PRs, each branch based on its parent:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`
` -> #73 -> #74 -> #75 -> #76 -> #77 -> #78 -> #79 -> #80 -> #81 -> #82 -> #83 -> #84`

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

## Immediate next actions

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
   repository did not have.
   - Every follow-up is revalidated at execution rather than at planning, and a `READY` claim goes to the
     **shared delivery coordinator**. There is no second send path.
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
