# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Material state — 2026-09-29

**This section is the live instruction. Everything under "Historical launch plan" below is kept for the
record and is not a current task.**

Everything implemented so far is one stacked chain of unmerged PRs, each branch based on its parent and
each awaiting independent review in dependency order:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`
` -> #73 -> #74 -> #75 -> #76 -> #77 -> #78 -> #79 -> #80 -> #81 -> #82`

**The chain is two segments, and the ancestry is not what the PR numbers suggest.** Segment two
(`#83 -> #84 -> ... -> #105`) forked from an **older** #82 at `c098c18290bb88ea749a8b4d708912870044df89`,
which was also the two segments' merge base. So #83 reported `feat/p3-02-goals-followups` as its base
while not containing the accepted #82 head at all — GitHub compared them as 20 ahead / 20 behind. #83 is
joined to the accepted #82 by an **ordinary non-rebase merge**, recorded below. A repository-wide change
needs both segments; measure the graph with `git merge-base --is-ancestor` rather than inferring it from
numbering.

Nothing is merged to `main`.

### Current work — the accepted #83, propagated into #84 and nowhere else

**PR #83 / P5-08 is accepted.** Gemini (Google Antigravity) published a formal exact-head GitHub review on
2026-10-14T12:07:55Z — state `APPROVED`, commit `c7b02267e183b58a54814c0b4663ee69d5608612`, carrying
`ANTIGRAVITY_REVIEW: PASS head=c7b02267e183b58a54814c0b4663ee69d5608612`. That SHA is the accepted head
and the only one the acceptance covers.

**Reviewer routing is unchanged:** Gemini/Antigravity temporary **primary**, Astra **secondary and
advisory-only** until it has its own working PostgreSQL/Redis/Linux runner and the owner re-routes. Claude
remains the sole author; the readiness marker keeps its `CLAUDE_READY_FOR_ASTRA` spelling for parser
compatibility.

**#84 / P5-09 is now the sole propagation and review gate, and #85 onwards are frozen** — no Phase 4
propagation, no Stage E, no new feature work until #84 has its own genuine exact-head independent PASS.

**The ancestry repair, measured rather than assumed.** #84 named #83 as its base while its live base SHA
was the *pre-acceptance* #83 head `8f84deebf92c1ee204cacb80654a9a228759db07`, which was also the two
branches' merge base — GitHub compared them as 16 ahead / 21 behind, so #84 contained none of the accepted
#83 work. Joined by an **ordinary non-rebase merge**; `git merge-base --is-ancestor c7b02267… HEAD` now
succeeds. This is the second link of the same shape as #82→#83, and it was probed in advance: the probe
predicted zero conflicts and three typecheck errors in one file, and that is exactly what happened.

**Zero merge conflicts. Three pieces of integration fallout, all in `operator-journey.integration.test.ts`:**

- `savePolicy` requires `expectedVersion` from the accepted parent, so the journey reads the profile
  default's live version and posts it back — the same thing the real screen does.
- `listPolicyAudits` answers a `PolicyAuditPage` rather than an array from the accepted parent onwards, so
  `audits[0]` became `audits.entries[0]`. The history is paged because the spec wants old and new values
  kept rather than capped.
- The journey no longer creates the profile default by hand. `createBusinessProfile` writes it alongside
  the profile from `profileDefaultPolicyWrite()`, so creating one again violated
  `automation_policies_profile_default_key` — the same fallout #83's audit suite had, in a second place.

**Accepted #83 behaviour preserved and re-verified on this head:** the native human takeover still retains
both the `TAKEOVER_STARTED` audit row and `cancelPendingFollowUps` in one transaction, the policy
`expectedVersion` concurrency enforcement and default-policy creation are intact, and the analytics/audit
tenant-isolation, append-only and sensitive-event invariants pass in full.

### Superseded — the accepted #82, propagated into #83 and nowhere else

**PR #82 / P3-02 is accepted.** Gemini (Google Antigravity) published a formal exact-head review on
2026-10-13T21:07:24Z — GitHub review state `APPROVED`, commit
`9040a2cfbd77c4373d97e1f9e5aec48cd25e11c5`, carrying
`ANTIGRAVITY_REVIEW: PASS head=9040a2cfbd77c4373d97e1f9e5aec48cd25e11c5`. That SHA is the accepted head
and the only one the acceptance covers.

**Reviewer routing, by owner decision of 2026-10-13T20:32:45Z.** Gemini/Antigravity is the **temporary
primary** independent reviewer for current and subsequent eligible PR+SHAs. **Astra is secondary and
advisory-only** until its own working PostgreSQL/Redis/Linux verification runner exists and the owner
changes routing — an owner-approved infrastructure exception, not quota exhaustion. Astra's `BLOCKED`
note on this same head was a report of its missing database and Redis runtime, not a verdict; its earlier
`CHANGES_REQUESTED` at `2e876c1d1d62ce9fabaf18ae8240784d4603eada` remains historical. Claude is still the
sole author. The readiness marker keeps its `CLAUDE_READY_FOR_ASTRA` spelling for parser compatibility
even though the reviewer is now Gemini.

**#83 / P5-08 is the sole current propagation and review gate, and #84 onwards are frozen.** No Stage E,
no P5-09, no broad downstream propagation, and nothing into #84+ until #83 has its own genuine
current-head PASS.

**What the merge had to reconcile.** Three conflicts, each resolved to keep both behaviours rather than
to pick a side:

- `packages/db/src/index.ts` — #82's three tenancy types added; the duplicate
  `usersWhoCanActOnBusinessProfile` export #83 already had was dropped.
- `packages/db/src/policy-store.ts` — #83's `MODE_CHANGED` / `POLICY_CHANGED` audit writes kept **and**
  #82's `profileDefaultPolicyWrite()`, its wider tenancy import and its note on the version nothing read.
- `packages/db/src/conversation-operations-store.ts` — the takeover now does both things in its one
  transaction: #83's `TAKEOVER_STARTED` audit row **and** #82's `cancelPendingFollowUps`. Dropping either
  would have been a real regression — no record of who took the conversation, or a human-held
  conversation with an automated chase still scheduled.

**Two pieces of integration fallout, both in #83's own audit suite.** `savePolicy` now requires
`expectedVersion`, deliberately, so no caller can decide not to care; the five call sites go through the
same `save` helper `policy-store.integration.test.ts` uses, and the transactional case reads the version
outside the transaction because it must write through `tx` itself. And the fixture no longer creates the
profile default by hand: the accepted head makes `createBusinessProfile` write it alongside the profile
from `profileDefaultPolicyWrite()`, so creating it again violated
`automation_policies_profile_default_key`. The fixture's old comment — "which onboarding creates in the
real flow" — is now literally true in code.

### Superseded — repairing PR #82 / P3-02 after CHANGES_REQUESTED

Two P1 blockers, both closed on `feat/p3-02-goals-followups`. No rebase, no force-push, nothing to `main`,
nothing into #83 or later, no Stage D. **The reviewer is Astra, temporarily, from 2026-10-13**; Antigravity
is paused; Claude remains the only authorized author; this side publishes only
`CLAUDE_READY_FOR_ASTRA head=<sha> task=P3-02` and emits no verdict marker.

**P1-1 — the follow-up feature had no executable path.** `dueFollowUps`, `claimFollowUp` and
`recordFollowUpSent` were correct, tested and called by nothing, so a planned follow-up sat in the table
for ever. `apps/worker/src/followup-sweeper.ts` is what makes one happen: a `startRecoveryLoop` that finds
due work and hands each `READY` claim to **the same AI-draft job an inbound message enqueues**. It decides
nothing — every gate is re-asked inside the claim, under the conversation lock. Carrying it: the
`FOLLOW_UP` draft trigger (its own migration, because PostgreSQL will not use an enum value added in the
same transaction), `followUpGenerationKey` exported from `application` so one key is derived one way, the
attempt inside the queue `jobId` so a re-enqueued attempt is one job and a second allowed attempt is two,
the tenant scope on `DueFollowUp`, and `recordFollowUpSent` called only on a disposition that actually
scheduled — a held attempt is settled by the next claim, in one place.

**P1-2 — a task could be assigned to somebody who cannot reach the Business Profile.** `createTask` and
`assignTask` checked Workspace membership and not the profile grant. Closed with
`canActOnBusinessProfile`, used by both paths through one refusal helper. The read side too, which the
directive asked for in the same breath — "including when users or grants change": `listTasks` resolves an
assignee's (and the completer's) identity through the grant **as it stands now**, on every read, in one
query per page, so a revoked grant and a row written before the gate both stop naming a stranger while
keeping the id an operator needs in order to take the task back. Reported and not fixed:
`lead-store.editLead` has the same asymmetry and belongs to #80.

**The recheck list's "window/template", which the claim did not ask.** `CHANNEL_INELIGIBLE` has always
been documented as "window closed, template required, account unhealthy" and only the last was asked. The
claim now asks an injected port, inside its transaction, with the facts read under the lock. The port
cannot permit a send — the engine still decides twice downstream — so it answers `false` only where there
is provably no route (outside the window on `STANDARD_ONLY`, or a conversation the customer never started)
and leaves `HUMAN_ASSISTED_EXTENDED`, and WhatsApp, to the engine.

**A third gap, found by the end-to-end test.** With all of the above correct, nothing could still be sent:
Meta's automated-response budget — "about 25 seconds after the latest **triggering inbound**" — was applied
to a send that answers nothing, and a follow-up's anchor is hours or days old by design. A proactive send
now carries no dispatch deadline at either gate that reads one; the 24-hour messaging window is untouched
and still refuses a follow-up outside it. Recorded in `GOALS_FOLLOWUPS.md` and `INSTAGRAM_ADAPTER.md`, and
flagged for the reviewer as the one send-path behaviour this repair changes.

**Two repairs landed the same day that belong to no feature, and one structural correction.**

**The chain is two live segments, not one.** `git merge-base --is-ancestor origin/feat/p3-02-goals-followups
origin/feat/p5-08-analytics-audit` answers **no**: #83 forks from `c098c18`, an older state of #82, and the
second segment carries neither the accepted #79/#80/#81 parents nor the P3-02 repair. A repo-wide fix must
therefore be applied in **both** segments. Its branch order is also not PR-number order — #85 is
`fix/instagram-token-lifecycle`, #86 is `fix/dead-suspension-resolver`. Measure the graph; PR numbers and
bases both lie about it.

**PR #90 had been red since 2026-10-08** — a fixture clock overtaken by the real one against
`channel_credentials_lifetime_check` — with the repair already present on #91 and below, applied downstream
and never returned to the branch that owns the test. Fixed at #90 and merged down its 15 descendants, every
link content-neutral.

**Then nine more fuses of the same class**, the earliest due 2026-11-09. Six went to the branch that owns
them (#85, #88, #89, #90, #91, #93); four belong to PASSed #64/#71 and went to the earliest *live* branch
instead (#82 and #83, byte-identically), as a recorded exception because a PASSed branch is terminal and its
CI never re-runs. All 24 heads green afterwards.

**Actions was unavailable for ~45 minutes** that day: every run failed in 3 seconds with zero steps, which
is the private repo's allowance rather than anything in the code. It cleared on making the repository
public. Judge a run by its `steps` count, not only its conclusion. Sixteen heads were verified locally
while it lasted, and every result matched the later CI run.

**#82 is still the current gate. #83 and everything below stays frozen**, still carrying the pre-repair
#79. #104 and #105 sit off the chain, based on #103, and are unaffected — their heads moved with the
repairs and their markers were re-published at the new SHAs.

**#26 and #49 have no workflow run and never had one:** `.github/workflows/verify.yml` first appears on
#50, so they predate CI. Both were verified locally at their exact PASSed heads instead — `pnpm verify`
green, 148 and 213 tests — and the evidence posted on each. Giving them real CI needs a `verify`-only
workflow, because the `infrastructure suites` job runs `test:db`/`test:redis`/`test:e2e`, scripts those
branches do not have; and it needs a credential with the `workflow` scope, which this one lacks.

### Earlier — propagating the accepted P3-01 parent into P3-02 / PR #82

`ANTIGRAVITY_REVIEW: PASS head=d9a34ffef120b7f0b171eb12f130d3848c9928cf` accepted PR #81, with a formal
approving review. The directive on #82 merges that exact parent into `feat/p3-02-goals-followups`, **one
branch only**: no rebase, no force-push, nothing to `main`, nothing into #83 or later, no Stage D.

No conflicts. Four files were touched by both branches — both canonical documents, `schema.prisma` and
`packages/db/src/index.ts` — and all four auto-merged. Verified rather than trusted: every line either
side added since the merge base is present, every P3-01 and P5-07 file is byte-identical to the accepted
parent, and P3-02's own goal, follow-up and human-task stores are untouched.

**The reviewer is Astra again, temporarily, from 2026-10-13**, while the owner diagnoses the local
Antigravity watcher. The two verdicts Antigravity already gave stand and are not to be re-reviewed to
change a name; never launch both reviewer systems for one PR and SHA. **Claude remains the only
authorized author.** This side keeps publishing `CLAUDE_READY_FOR_ASTRA head=<sha> task=<task>` and emits
no verdict marker of its own.

**A provenance note:** the owner's own workstation holds a local-only #82 merge commit
(`2abb64117c2274adfbe6fc85ae7d552e23faf4b9`) from local reviewer activity. It is not in this repository
and not a GitHub head; the propagation recorded here was performed from the remote heads in the
programmer's environment, which is where the pushed SHA comes from.

**#82 is now the current gate. #83 and everything below is frozen** and still carries the pre-repair #79.
#104 and #105 sit off the chain, based on #103, and are unaffected.

### Earlier — propagating the accepted P5-07 parent into P3-01 / PR #81

`ANTIGRAVITY_REVIEW: PASS head=bd1c039998fb41fe339af97ae2dc5e515810aa6c` accepted PR #80. The directive on
#81 merges that exact parent into `feat/p3-01-customer-identity-memory`, **one branch only**: no rebase,
no force-push, nothing to `main`, nothing into #82 or later, and no P3-02/P5-08/Stage D work.

**The independent reviewer is temporarily Antigravity (Gemini 3.8 Flash)**, at the owner's direction of
2026-10-12. Prior Astra verdicts stand; the contracts are unchanged; the verdict marker is
`ANTIGRAVITY_REVIEW: …`. This side keeps publishing `CLAUDE_READY_FOR_ASTRA head=<sha> task=<task>`, which
the owner accepted for backward compatibility, and emits neither reviewer's marker itself.

No conflicts. Five files were touched by both branches — both canonical documents, `schema.prisma`,
`packages/db/src/index.ts` and `constraints.integration.test.ts` — and all five auto-merged. Verified
rather than trusted: every line either side added since the merge base is present in the result, and
every P5-04 settings/policy and P5-07 leads file is byte-identical to the accepted parent.

**#81 PASSED** at `d9a34ffef120b7f0b171eb12f130d3848c9928cf`, by Antigravity.

### Earlier — propagating the accepted P5-04 parent into P5-07 / PR #80

`ASTRA_REVIEW: PASS head=a1b46cb7789091f7782f039fdbf148631a77e3ea` accepted PR #79. The directive on #80
propagates that exact parent into `feat/p5-07-leads-pipeline` by ordinary merge commit, **one branch
only**: no rebase, no force-push, nothing to `main`, nothing into #81 or later, and Stage D not started.

One conflict, additive: both branches appended to `OUTCOMES` in `apps/web/src/ui/outcome-notice.tsx`, and
the resolution keeps both sides. `catalogue.ts`, `schema.prisma` and `packages/db/src/index.ts` were the
other three files both branches touched; all three auto-merged, and every line either side added is
present in the result. Every P5-04 settings, policy and simulation file is byte-identical to the accepted
head. `presenceMode`/`presenceTypingLeadMs`, which the directive named, do not exist at #80 — they arrive
with P4-05 (`6ac04a3`), below #80 in the chain, so that collision is a later branch's problem and is
recorded as such.

**#80 PASSED** at `bd1c039998fb41fe339af97ae2dc5e515810aa6c`, by Antigravity under the owner's temporary
reviewer route.

### Completed — P5-04 / Issue #30, the blockers on PR #79

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

**Closed — Astra's two R5-final blockers at `c4ebadb0…`.**

8. **Widening an already-enabled allowlist is material.** With `TEMPLATE_AUTOPILOT` already stored, adding
   a template used to emit `impacts: []`: no effect summary, no sealed acknowledgement, an audit row
   claiming nothing material happened. `TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED` is now its own impact code
   in both catalogues, compared as a **set** — empty→non-empty and any addition are material, removal and
   reorder are not, a repeated name is not a change, a one-for-one swap is — and it sits in an `else if`
   beside the enablement arm, so enabling the mode and filling the list in one edit gets one warning
   rather than the same consequence twice. The action needed no change: the gate already refuses any
   proposal with impacts and no server-minted seal, and the store already recomputes impacts for the audit
   inside the write's transaction.
9. **A normally created Business Profile now has settings to render.** `createBusinessProfile` writes the
   conservative default **in the same statement** as the profile, so the two rows arrive together or
   neither does; the test-only `ensureDefault` that had been masking its absence is gone. Values come from
   the domain's `defaultAutomationSettings`, not from the column defaults, and a domain test asserts the
   two agree field by field. Migration `20261011090000_profile_default_policy` backfills older profiles
   idempotently by `NOT EXISTS`. The regression starts at profile creation
   (`apps/web/src/server/settings-screen.integration.test.ts`) and asks the page's own predicate,
   `profileDefaultOf`, whether there is a form; the database side proves a rolled-back creating
   transaction leaves neither row, that concurrent creations get exactly one default each, and that no
   Business Profile exists without one.

**The acknowledgement is a sealed one.** The refusal mints an HMAC over the exact proposal, its version
and the impacts shown; the save accepts an acknowledgement only with a seal it minted. Comparing public
impact codes is not proof, because the codes are in the URL, the page and the catalogue.

**Review gate, in one place:** #78 PASSED at `8692d8f35d16256beb819488da9ae5a263a1a3e1`; #79 PASSED at
`a1b46cb7789091f7782f039fdbf148631a77e3ea` after CHANGES_REQUESTED at `0b62c9e…` (seven blockers), at
`d67da89…` (four closed, three kept) and at `c4ebadb…` (two contract blockers: allowlist widening, and the
missing default policy); #80 PASSED at `bd1c039998fb41fe339af97ae2dc5e515810aa6c` (Antigravity);
#81 PASSED at `d9a34ffef120b7f0b171eb12f130d3848c9928cf` (Antigravity); **#82 is the current gate**,
carrying that accepted parent and awaiting independent review; #83 and everything below is frozen and
**not ready for review**, because they still contain the pre-repair #79.

**The concurrency barrier is state-based, not timed.** The regression proving `savePolicy`'s row lock waited
on `setTimeout(250)` and was intermittently wrong under the full suite; it now waits until a backend is
observably blocked on the holding transaction's own id. The review request issued against `ef8b0d4f…` is
superseded by this test-only head, and #79 remains the current gate.

**The #79 repairs are propagated exactly one step.** They exist on
`feat/p5-04-ai-settings-simulation` and on `feat/p5-07-leads-pipeline`, and nowhere else: the directive on
#80 permits one branch, so #81 and below still carry the pre-repair #79 and will each need this merged
down in turn once #80 passes.

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

### Current work — P3-01 / Issue #54
### Current work — P3-02 / Issue #55
### Blocker repair — P5-01 / Issue #27, propagated to every branch

Astra returned `CHANGES_REQUESTED` for PR #73 at `98895f4344ca3a0a2582ba69b497e9271dc263fc`:
**activation was permitted while the STYLE step was unfinished and had not been deliberately skipped.**
Fixed at #73 and merged down through #74–#83, ordinary merges only, each branch verified at its own head.

The gate is one rule in one place: `blockersFor()` takes the validated skip set and adds
`STYLE_NOT_CONFIGURED`. `activateBusinessProfile()` already re-reads through `readOnboarding()` inside its
row-locked transaction, so it enforces that rule rather than a second one that agrees until somebody edits
it.

**Two things worth carrying forward.** Three tests were written against the bug rather than the spec —
including one that quoted the sentence and asserted its opposite — which is how it survived to an
independent review. And a fixture valid at #73 was invalid from P5-06 onward, because
`style_examples_verified_check` requires an `ACTIVE` style example to name its approver; a test that only
runs green on the branch it was written on is not coverage for the chain.

### Current work — P5-09 / Issue #35

**Branch `feat/p5-09-product-ux-e2e`**, stacked on the repaired #83. Held back until the P5-01 blocker
repair reached #83 green, as that directive required, then brought onto it by an ordinary merge.

**`docs/specs/UX_VERIFICATION.md` is written by this task** and is as explicit about what the suite does
*not* prove as about what it does, because an unbounded coverage claim is the kind that gets cited in a
review and turns out hollow.

**There is no browser driver in this repository, and the contract says what it wants instead:** "E2E must
exercise server authorization and stale-state behavior, not only happy-path DOM interactions." So each
journey enters through `resolveBusinessProfileContext` and drives the same stores the server actions
drive, against a migrated database, with an authorization probe and a stale-state probe per scenario.

**Two things these tests found that nothing else had.** `--border-strong` failed WCAG SC 1.4.11 at 1.91:1
light and 1.86:1 dark against the surface a `.button` actually sits on — a button whose edge a reader with
low contrast sensitivity could not find. And P5-08 shipped the analytics and audit screens with **no CSS
at all**, so an eight-column table pushed the whole document sideways at 375px.

**What is not claimed.** jsdom evaluates no media queries and lays nothing out, so nothing here asserts a
page looks right at a given width; the responsive tests hold that the rules exist and still name what the
components render. Contrast is computed from tokens rather than sampled from pixels, which is strictly
more than a browser-based auditor gives in jsdom — it needs paint and would report nothing.

### Previous — P5-08 / Issue #34

**Branch `feat/p5-08-analytics-audit`**, stacked on P3-02. Operational analytics and a searchable,
append-only audit log. The owner's directive on PR #81 placed this after P3-02, and it was held back until
#82 was complete; the branch was then brought onto P3-02 by an ordinary merge rather than a rebase.

**`docs/specs/ANALYTICS_DEFINITIONS.md` is written by this task** and is the definition of record: the
store is the only implementation of any metric in it, because a metric with two implementations has two
values and the day somebody notices is the day they stop trusting the page.

**The hard invariant shapes the return type, not just the UI.** `deliveryOutcomes` has separate
`application` and `provider` groups that are never summed. Outbound messages the provider has not spoken
about are `awaitingReport`, which is the honest name for them — counting them as delivered because our own
send succeeded is exactly the inference the separation exists to prevent.

**`AMBIGUOUS_SEND_RESOLVED` has no writer, deliberately.** The spec asks for ambiguous-send *manual*
resolution and there is no manual resolution path in the product yet; the worker's automatic reconciliation
is not somebody's action, and recording it as one would put a name against something nobody did. The enum
value stays so the log can record it the day that path exists.

**Audit lives under Settings**, at `/settings/audit`, because `PRODUCT_UX.md` already places
"security/audit" there and the seven navigation sections it names are product structure. An eighth
top-level section would be a decision about the product rather than about this task.

### Previous — P3-02 / Issue #55

**Branch `feat/p3-02-goals-followups`**, based on P3-01's accepted head
`13212612bb0ac73b2468c1adc99b1c5e48008c16` (verified before branching, and `e15c809` — #76's human
composer — verified as an ancestor). Conversation goals, next actions, bounded follow-ups, human tasks and
customer opt-out. No UI.

**Issue #55 named two specs that did not exist**: `docs/specs/GOALS_FOLLOWUPS.md`, written as part of this
task, and `docs/specs/AI_ACTION_APPROVAL_MATRIX.md`, which is **not** written. A matrix for every AI action
across the product is a larger document than this work justifies; `GOALS_FOLLOWUPS.md` carries the matrix
for the actions this task introduces and says so. Same precedent as `MVP_RELEASE_SCOPE.md` for #58.

**One deliberate reuse.** `NextAction` is `conversations.next_action` / `next_action_at`, which the leads
work already added, rather than a new table. A lead's "what happens next" and a conversation's are the same
question, and a second place to answer it would give two answers depending on which screen an operator
opened. It also avoids changing core entity semantics, which needs an ADR.

**What the first review found, and what it changed.** The stores above were all correct and the feature was
unreachable: nothing called `dueFollowUps`, `claimFollowUp` or `recordFollowUpSent`, so the goal and
follow-up tables were a complete record of intentions nobody acted on. The repair is described under
"Current work" at the top of this file. Two details are worth carrying forward because they are general:

- **A store with no caller passes its own tests.** Every follow-up case here calls the store, so none of
  them could notice. The regressions added for the repair deliberately start from the worker and from the
  real event — the sweeper's pass, the ingestion store's `recordActivity` and `startHumanTakeover`, and
  `takeOver` — rather than from the helper. The first attempt hooked the inbound cancellation to
  `appendInboundMessage`, which has no production caller, so it ran in one test and nowhere else: the same
  defect one layer down, found by auditing for the class rather than by trusting the repair.
- **Correct pieces can still not meet.** The provider's automated-response budget was right, the follow-up
  path was right, and together they made a feature that could never send: the budget is counted from the
  message being answered, and a follow-up answers none.

**P5-08 / Issue #34 is next**, per the owner's directive on PR #81 — and not before. Its work is committed
on a local `feat/p5-08-analytics-audit` branch and deliberately unpushed.

### Previous — P3-01 / Issue #54

**Branch `feat/p3-01-customer-identity-memory`**, based on `feat/p5-07-leads-pipeline`. The MVP customer
identity, search and durable-memory primitives: contact points, external identities, duplicate candidates,
`CustomerFact`, `CustomerPreference` and an assistive-only `ConversationSummary`. No UI — the issue's
acceptance criteria ask for persisted, application-facing primitives.

**Issue #54 named `docs/specs/CUSTOMER_IDENTITY_SEARCH.md`, which did not exist.** The issue's own
Required behavior / Tests / Acceptance criteria were detailed enough to implement from, so this task writes
that spec as part of its output — the same precedent as `LOCALIZATION.md` for #58.

**One reading the issue left open, resolved as follows.** It lists message text among the searchable
fields "as supported by current storage", while P5-02's Inbox search deliberately never searches message
text. Both are honoured: `searchCustomers` searches it only when the caller passes
`includeMessageText: true`, and message hits rank after identity hits. A business searching its own
correspondence is ordinary, but it is a different question from *who is this*, so it is a decision at the
call site rather than something that happens to every customer's words whenever an operator types a name.

**One deliberate tightening.** The migration first gave the new tables `ON DELETE CASCADE` from the
contact. `constraints.integration.test.ts` — which predates this task — allows only login data and grants
to cascade, and that guard is right: every new foreign key is now `ON DELETE RESTRICT`, so `forgetCustomer`
is the only way memory goes away and a stray `contact.delete()` fails loudly.

### Previous — P5-10 / Issue #58 (Stage D)

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
