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

**The chain now runs to #102 plus the P7-02 branch**, each branch stacked on its predecessor and each
CI-green with evidence posted. PRs #79–#102 are completed by Claude and awaiting review; **P7-02 / Issue
#60 is the current task**. Issue #59 stays open after its slice. Everything in Phase 1 and Phase 2 has an independent PASS at its published
head, including **#72 / P3-03 at `9955ecf6c114145d54bb7dd46abbc902267bd00c`**, **#71 / P2-09 at
`38df858508ec61e2c6821e47a0a5225c86768223`**, **#70 / P2-08 at
`c15a9a6f558d9270263ad7573669f76ca3af8ac0`**, **#69 / P2-07 at
`4c9f496d805316ded56311e41bdd4c3c39ff5a43`** and **#68 / P2-06 at
`fb35665209b90c82bc10f3068450111e75f83299`**; all are propagated downstream. Nothing is merged to `main`.

Everything is one stacked chain of unmerged PRs, each branch based on its parent:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`
` -> #73 -> #74 -> #75 -> #76 -> #77 -> #78 -> #79 -> #80 -> #81 -> #82 -> #83 -> #84`
` -> #85 -> #86 -> #87 -> #88 -> #89 -> #90 -> #91 -> #92 -> #93 -> #94 -> #95 -> #96 -> #97 -> #98 -> #99`
` -> #100 -> #101`

Phase 6 continues the same chain: #95 (P6-01, Issue #38), #96 (P6-02, #39), #97 (P6-03, #40), #98 (P6-06,
#43), #99 (P6-05, #42), #100 (P6-08, #46) and #101 (P6-09, #47). Phase 7 continues the same chain with
the P7-01 branch above (#59). **#41 / P6-04 is unblocked and implemented:** the owner's decision of
2026-10-09 named Stripe as the first production adapter against a Ukrainian-FOP seller, with a Romanian
company as a second seller route and WayForPay and Cryptomus as additional payment routes, all priced in
EUR on a monthly term. PR #104 carries the provider-neutral port extension and the Stripe adapter; see
"P6-04" below. #44 (P6-07, commercial E2E) is now the only Phase 6 work left, and it depends on this
adapter path rather than on a decision.

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

**PR #78 has an independent PASS at `8692d8f35d16256beb819488da9ae5a263a1a3e1`, and the hold is lifted.**
That PASS was the condition every one of these notes was waiting on. The P5-06 repairs are now merged
down the chain by ordinary merge, every branch from #79 to #103 carries them, and each was pushed with
its own CI run. No rebase, no force-push, no merge to `main`.

Propagating found one thing nothing else would have: `style_example_decisions` is append-only from #32,
and a customer's erasure has to empty it, so every deletion request ended `PARTIAL_FAILURE` the moment
the two branches met. Fixed at `feat/p3-04-privacy-deletion` — a `DELETE` is permitted only while a
transaction has declared itself a customer erasure with `SET LOCAL`, and `UPDATE` stays refused either
way. See that branch's own commit for why the guarantee is about rewriting rather than about erasure.

1. **P5-06 / Issue #32 — the retired-list reachability blocker on PR #78, repaired and awaiting
   independent re-review.**

1. **P7-01 / Issue #59 — the internal control plane, first slice.** Branch
   `feat/p7-01-admin-operations`, based on #101. `docs/specs/ADMIN_OPERATIONS.md` and
   `MVP_RELEASE_SCOPE.md` are brought into the chain from `origin/docs/phase6-commercial-billing` — Phase
   7 could not cite its own specs before.

   **The whole design turns on one refusal.** The obvious way to build an internal console is to mint a
   `BusinessProfileContext` for a support engineer so every existing customer read works unchanged. That
   would hand the operator customer `OWNER` authority across every `requireRole` site in `packages/db`,
   because the context carries `role: WorkspaceRole` and nothing downstream can tell a minted one from a
   real member's — the deletion path, `addWorkspaceMember`, `setEntitlementOverride` and the data export
   would all accept it, and each writes `actorUserId` into the **customer's** audit log, readable by that
   customer's own owner. Widening the membership lookup is worse: a staff row in `workspace_members`
   appears in that user's workspace list and consumes a seat the customer pays for.

   So `PlatformContext` has its own brand and its own `WeakSet`, and `scopeOf`, `profileScopeOf` and
   `requireRole` **reject it**. That rejection is the feature, and `platform-boundary.test.ts` parses the
   platform modules' ASTs to assert no exported signature takes a customer context and none imports a
   credential reader.

   **The slice has two typed actions, and it needed them.** A first slice of authorization and evidence
   alone would have satisfied none of #59's acceptance criterion — "routine commercial troubleshooting
   without direct DB mutation" — and the repo documents the two paths that are direct SQL today, in
   `suspension-store.ts`'s and `suspension-lock.ts`'s own comments. So the console pulls and lifts the
   kill switch at the four existing scopes, and asks for an ambiguous operation to be re-examined by
   enqueueing the job the sweeper raises. It never decides: `reconcileOperation` does, in the worker,
   where the provider-evidence port exists.

   **Three defects found before a line was written**, by a three-agent survey-and-critique pass:

   - `readBillingOverview` → `readUsage` → `openUsageCycleWithin` **creates** a `usage_cycles` row, so an
     operator opening a "read-only" usage panel would have written into the customer's tenant with no
     actor and no audit row — failing "every operator action is attributable" on the first page load, in
     the one direction nobody looks. `readUsageSnapshot` is genuinely read-only and a test asserts the
     cycle count is unchanged afterwards.
   - A `SupportScope` with no content-bearing read would have been `requireWorkspaceWideWrite` again:
     exported, documented, never called. So the slice includes exactly one screen that shows a customer's
     words, gated on the scope, and the same page renders the reason when it does not.
   - An `/admin` tree is a sibling of the whole product shell and this app has **no middleware**, so a
     forgotten resolver call in one page file would be an unauthenticated internal page.
     `route-authorization.test.ts` walks every `page.tsx` and `route.ts`, follows ancestor layouts and
     imports two levels, and fails the build — with an allowlist of seven deliberate exceptions, each
     carrying its reason. It is worth more than the console.

   **`automation_suspensions_operator_check` is load-bearing.** `activeSystemSuspension` identifies the
   system's own switch precisely by `by_user_id IS NULL`, so an operator pause with no actor is one the
   backlog guard is free to close. Adding the CHECK broke four existing fixtures that created actorless
   operator pauses, which is the finding rather than a cost.

   **Audit kept separate, for a reason worth quoting rather than re-deriving.**
   `audit_events.workspace_id` is `NOT NULL`, so a platform-level act has no row shape, and
   `audit_events_scope_check`'s second disjunct forces `business_profile_id IS NOT NULL` for any kind
   outside its allowlist. Severity is derived from the kind in the domain *and* paired with it by a CHECK.

   **Decisions that are the owner's, stated in the PR rather than invented quietly:** the role-to-permission
   matrix (`PLATFORM_PERMISSION_MATRIX` is one editable literal with the reasoning beside each row);
   whether break-glass may be renewed and under what cap — nothing stops a chain of fifteen-minute grants,
   so the audit counts the chain instead; "customer approval when required by policy", deferred; and how
   staff authenticate, which is unanswerable today because `apps/web/src/auth.ts` has `providers: []` and
   nobody can sign in at all.

   **Deferred, and named:** the two suspension scopes that do not exist (channel/provider class,
   high-risk feature), the queue/operation inspector and correlation tracing — the survey found three
   breaks in correlation propagation, which is its own change — feature flags, and the remaining typed
   actions. **#59 stays open.**

1. **P6-04 / Issue #41 — the Stripe adapter, and the port it needed.** Branch
   `feat/p6-04-billing-provider-port`, based on #103. The owner's decision of 2026-10-09 settled the
   blocked product choice: Stripe first, against the Ukrainian-FOP seller, EUR, monthly, with the Romanian
   company and WayForPay/Cryptomus preserved as server-configured routes.

   **No vendor SDK, and the reason is written down as ADR-020.** The repository has zero vendor API SDKs,
   seven third-party HTTP APIs already integrated by hand (including one that builds its own multipart
   rather than taking `openai`), no new runtime dependency since Phase 1, and a
   `CORE_FORBIDDEN_THIRD_PARTY` list with no payments entry — so taking `stripe` would turn "application
   and domain never import a provider SDK" from a lint into a promise. Nothing in the specs forbids an
   SDK, which is exactly why the argument is an ADR rather than a comment.

   **The port moved to `application`**, because ADR-017 says so in as many words and because an adapter
   package cannot name an interface that lives in the persistence package. `billing-stripe -> db` is a
   forbidden edge: an adapter that could reach the database could activate an entitlement without a
   verified event, which is the one rule this boundary exists for. `db` re-exports the port's surface and
   keeps one sentence of its own — the refusal of an event the port did not mint.

   **The port gained a third verification outcome, and that gap was only visible from an adapter.**
   `verify` returning `null` meant "forgery", so an authentic event the product does not map had the same
   answer — and the two owe the provider opposite replies, because a provider that is refused redelivers
   for three days. `EVENT`, `ACKNOWLEDGED` and `REFUSED` now say which. It also gained
   `openManagementSession` and `setRenewal`, both optional, because the owner's decision requires the
   provider's own portal and cancel-at-period-end where the provider has them, and a capability list that
   claimed every provider did would make a screen promise a page that does not exist.

   Facts verified against the live documentation on 2026-10-12, API version pinned at `2026-09-30.endive`:
   the signed payload is `timestamp + "." + rawBody`, HMAC-SHA256 keyed with the `whsec_` secret; only the
   `v1` scheme counts, because Stripe deliberately sends a fake `v0` with test events; **every** `v1` is
   tried, because rolling a secret leaves two active for 24 hours; the tolerance is five minutes and a
   tolerance of zero is documented as wrong; each retry carries a fresh timestamp; `created` is seconds
   and explicitly not an ordering key.

   **Three things the documentation contradicted a reasonable guess about**, each now a test:
   `current_period_end` is no longer on the subscription object — it lives on `items.data[]`, and reading
   the old place loses every period end silently; reactivation in the default `flexible` billing mode is
   confirmed by `cancel_at` being null rather than by `cancel_at_period_end`, so a single-field reader is
   right in one billing mode and wrong in the other; and `Stripe-Should-Retry` is documented as guidance
   the status code does not carry, so it overrides the status-code table rather than the reverse.

   **Attribution travels in metadata because the store leaves no other way.**
   `recordVerifiedBillingEvent` resolves an arrangement from the event's own id or from the checkout
   contract it names, and from nothing else — there is no lookup by provider reference. So the contract id
   goes into `client_reference_id` *and* into `subscription_data[metadata]`, and every renewal reads it
   back from `invoice.parent.subscription_details.metadata`, which the docs define as an immutable
   snapshot taken at invoice finalization. Without it every month after the first would be `UNATTRIBUTED`.

   **The callers are in this PR, which is the point.** Eight billing functions had no production caller;
   this registers the adapter from `STRIPE_ROUTES` (one entry per route, so two sellers do not share an
   account), adds `/api/billing/webhooks/stripe`, and hands the customer to the provider *after* the
   contract commits — a session opened first would leave a paid session with nothing to attribute.

   **One gap found while wiring it, and closed:** catalogue prices are immutable by trigger, and
   `publishAcceptedCatalog` published none of the provider price ids — so `provider_price_id` could never
   be set in a deployment that published its catalogue the normal way, and no Stripe checkout could ever
   be priced. The publisher now takes an optional provider-price map, because publication is the only
   moment at which it can be stored.

   **Deliberately not implemented:** refunds and disputes. A refund arrives on a charge, a charge carries
   no subscription metadata, and attributing one needs a second API call and a decision about partial
   refunds that Issue #41 does not ask for. The endpoint is not subscribed to those types, and an
   unexpected one is answered `ACKNOWLEDGED` rather than mapped to something that looks handled.

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

   **Not in this issue:** no provider adapter was registered outside tests, and the checkout UI with its
   acceptance control is #47. Both are closed since: #47 landed the checkout screen, and #41 registers the
   Stripe adapter from configuration and hands the customer to it.

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

## P7-02 / Issue #60 — launch readiness, staged rollout and release evidence

`docs/specs/RELEASE_PROCESS.md` is the operational companion; `LAUNCH_READINESS.md` stays the contract.

What a later session has to know about this slice:

1. **A release can now actually be recorded.** `pnpm release:record` and `pnpm release:review`, both
   requiring the new `OPERATE_RELEASE` platform permission, both audited. Before them the release tables,
   the gate catalogue, the severity model and the §18 send gate were reachable only from tests — so the
   stage in force was always "none", and "none" is the one state in which the rollout gate permits
   everybody. A schema nobody can write to is not an implementation of §20.
2. **The §18 gate fails closed when it cannot tell.** `readReleaseInForce` reports `NONE`, `IN_FORCE` or
   `INDETERMINATE`, and only the first permits. The earlier version searched a window of ten candidates
   and reported "no release" when it found nothing approved — so recording ten unreviewed proposals, the
   most common state a candidate is in, would have switched unattended sending on platform-wide.
3. **`HIGH` disables something.** `releaseDecision(...).disabledCapabilities` is carried into the rollout
   posture, so a release whose autopilot gate returned `HIGH` keeps autopilot off whatever stage it names.
   It was computed and read by nothing, which made the severity decoration.
4. **The release catalogue has its own advisory key.** `release-lock.ts` plus a trigger on all three
   tables, taken shared by the delivery claim — the `entitlement-lock.ts` pattern, for the same reason: a
   candidate that would change the answer may not exist yet when the claim starts, so no row lock covers
   it. The claim's existing "every read is locked" invariant test caught the unlocked version.
5. **Evidence lives in `scripts/release/evidence.ts`, not in a test.** `suites` are test files and
   `implementation` is source offered as evidence of itself — separate fields, because three production
   files listed as suites is how §16's gate came to look covered.
6. **CI does not run `pnpm evals`**, so §5's gate is settled by a person. The one-line fix is staged at
   `docs/handoff/ci-evals-step.patch`; it is not applied because this repository's push credential cannot
   write `.github/workflows`. **Someone with that scope should apply it.**
7. Four limitations are stated in `RELEASE_PROCESS.md` rather than hidden: the CI gap above, no
   per-feature rollout (§18's "repeat a staged rollout" has one global stage plus one allowlist), reviewer
   independence being a process property rather than a constraint, and only `AUTOPILOT` being a capability
   the send path can actually switch off.
8. **Fixture clocks must be in the past.** A trigger refuses a review `submitted_at` in the future,
   because `reviewerStatusOf` takes the newest matching verdict and these tables are append-only — a
   `PASS` stamped 2099 could never be withdrawn. A suite stamping fixtures with tomorrow's date fails on
   its own fixtures.
9. **One commit may be proposed at several stages, once each** (`@@unique([sha, stage])`), and reviews are
   keyed by `reviewed_sha` with no foreign key to a candidate. Advancing a stage is a new release decision
   that inherits the verdict already given about that code. Pulling a rollout back during an incident is
   the kill switch's job, not this table's.

Historical note: the original launch sequence (review #2, then launch #3 from a merged `main`) was
superseded by the owner's stacked review-lag mode. Those tasks are implemented and are in the chain above.

## Phase 6 commercial chain and the 2026-10-14 corrections

**Date:** 2026-10-14. Nothing is merged to `main` (`940c541`). The chain is two live segments: `#26…#82`
and `#83 → #84 → #85 → #86 → #87 → #88…#105`, forked from an older #82, so a repository-wide fix needs
both and branch order is not PR-number order. Measure the graph with `merge-base --is-ancestor`; never
infer it.

**#82 is blocked on the reviewer's environment, not on its code.** Astra confirmed the head
`9040a2cfbd77c4373d97e1f9e5aec48cd25e11c5`, the exact-head readiness marker and a green run, then issued
no verdict: its runner has no `TEST_DATABASE_URL`/`TEST_REDIS_URL` and no PostgreSQL, Redis, Docker or
Podman, so it cannot perform the independent execution the review contract requires. Everything
downstream waits behind that. Unblocking it is an owner/infrastructure action — either give that
environment a container runtime or reachable PG17+pgvector and Redis 7 endpoints (`compose.yaml`,
README §56, and the two variables; the role needs `CREATE DATABASE` because the harness makes a fresh
database per run, and the `retrieval` migration needs `vector`), or decide that CI's own
`infrastructure suites` job satisfies the contract. That job is not Claude's machine: it raises
`pgvector/pgvector:pg17` and `redis:7-alpine` as service containers, and because `pnpm test:db` /
`test:redis` / `test:e2e` export `REQUIRE_DB_TESTS=1` / `REQUIRE_REDIS_TESTS=1`, a missing variable is a
hard error rather than a skip — a green run there cannot be a silent skip.

### Two behaviour changes

1. **A failed charge may only suspend the path the workspace is paying on** (#46, PR #100). `apply`'s
   `SUSPEND` branch was the one entitlement effect that never looked at the arrangement; its three
   siblings all guard. It read the subscription and wrote `GRACE` regardless of what the failure
   concerned, so an old provider retrying a **superseded** subscription suspended the live paying path, an
   event naming an arrangement the event's **route does not own** resolved to no arrangement while the
   workspace still arrived from the contract, and the last failed charge after a cancellation at period
   end overwrote `CANCELED_PENDING_END` with `GRACE` — taking away a paid term *and* losing the date
   saying when it ended. Guarded now; dropping any one of the three clauses fails exactly one test.

2. **The Business Profile capacity lock now holds for the work it protects** (#40, PR #97).
   `createBusinessProfile` took a `DbExecutor` — a type that deliberately omits `$transaction` — and
   called `pg_advisory_xact_lock` on it. PostgreSQL releases an `xact` lock when its transaction ends, and
   under autocommit that is the lock statement itself: asked directly, `pg_locks` reports **0** held
   afterwards and **1** inside a transaction. The count-then-insert it was meant to serialize ran
   unprotected. `addWorkspaceMember` always opened its own transaction, which is why seats never had it.
   **A `DbExecutor` parameter is the tell: that type cannot hold an xact lock across anything.**

   I could not write a test that fails on the unfixed code, and the commit says so. Two concurrent
   creates in `Promise.all` passed with the lock deleted entirely, three runs out of three; a barrier
   holding the key from another connection also passed against the defect, because an autocommit lock is
   still acquired and still contended — it is merely released too early. Forcing the interleave needs a
   client proxy that pauses between the count and the insert. The defect is argued from PostgreSQL's
   behaviour and the type signature, and the added test pins that behaviour rather than the race.

### Issue #44's scenario list

Thirteen of sixteen are covered. Five were closed on 2026-10-13/14 and only the first of those was
broken rather than merely untested: the suspension guard above; a reversal of an older term cannot revoke
the term that replaced it (both `REFUNDED` and `CHARGEBACK`); all three accepted tiers bought through the
real checkout from `publishAcceptedCatalog`; two concurrent settlements of one usage hold, where removing
`FOR UPDATE` now fails exactly those cases; the `only` in `PRICING_PACKAGING.md` §142-148, which needed
the fixture's plan corrected before the claim was expressible at all; and an entitlement revoked while a
delayed AUTOPILOT reply waits, refused by the claim's final revalidation.

Three remain, each waiting on something that is not code:

- **recurring add-ons and one-time voice top-ups.** `grantUsageTopUp` and `setWorkspaceAddOn` have no
  production caller and `addOnVersionId` appears nowhere outside `catalog-store.ts`, so the accepted
  catalogue publishes and prices five add-ons that cannot be bought. §186-209 settles the *policy*, so
  this is unimplemented spec rather than an open product question — but `CheckoutContract.planVersionId`
  is not nullable and a settlement that grants an allowance instead of activating a subscription is a
  fork in the billing core's semantics. **That needs an ADR, not improvisation.** The narrower open
  questions are how a recurring add-on is represented at the provider and whether proration is attempted
  on the first one at all (§201 says "where the provider supports reliable proration").
- **downgrade over BP/seat capacity** — needs the owner's active-resource selection policy.
- **the 3-day failed-renewal grace** — `paidWorkPermitted` declines to decide how `GRACE` ends while
  `BILLING_ENTITLEMENTS.md` names three days. Both cannot be right.

### Reported and deliberately not built

- **Nothing in production creates a workspace or a Business Profile.** `createBusinessProfile` and
  `createWorkspaceWithOwner` are not exported from `@omnichannel/db`, `db.businessProfile.create` appears
  in exactly one place — inside the former — and nothing in `apps/web` creates either. `addWorkspaceMember`
  has no production caller either. So §178's funnel (create account → connect first Business Profile →
  trial → choose a plan) has no front door, and the capacity gates, the trial start and `readEntitlement`
  are currently reachable only from tests. Read as not-yet-built rather than broken; it is the whole
  sign-up surface and wants its own issue.
- **The analytics tier limits are unenforced in both the catalogue and the code.**
  `ANALYTICS_RETENTION_DAYS` (30/183/730) is declared, published per tier, asserted at publication and
  localized for display, and read by nothing — no retention logic exists in `analytics-store.ts` or
  `analytics-view.ts`, so a Starter workspace can query the 24 months Scale pays for. `ADVANCED_ANALYTICS`
  is granted to all three tiers by `CORE_FEATURES` and its only reader is the billing screen's display
  list, so §127's analytics-depth split exists nowhere. #34/#38 scope; §152 gives the durations without
  saying whether an over-long range is clamped, refused, or clamped with an explanation.
- **`reconcileProviderState` still has no periodic caller**, so the audit rows the best-effort
  cancellation writes are for a person to read rather than for anything to repair.

### Reading a verification run

- **Judge CI by conclusion, then job duration, then the log.** The jobs API intermittently returns
  `conclusion: success` with `steps: 0`, and 502s, while the run is complete and its log intact
  (`gh run view --log` then labels every line `UNKNOWN STEP`). A refused job is `failure` + 0 steps +
  ~3 s; a real one with missing metadata is `success` + 0 steps + minutes.
- **A local full `pnpm test` is not the verdict.** 213 files against one PostgreSQL contend, and every
  clean-environment run gives a different failure set — twice on 2026-10-14 the failures were in files a
  `packages/db` transaction cannot touch, and each passed alone. Cap local full suites at
  `--maxWorkers=3`, compare the *same* suite with and without a change before blaming it, and let the
  clean runner decide.
- **`packages/billing-stripe` left behind by a checkout of #104/#105 breaks `scripts/verification/gate.test.ts`
  on branches that do not have that package**, with ENOENT on a directory holding only `node_modules`.
  Remove it; it is not a code defect.
