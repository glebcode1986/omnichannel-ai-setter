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

### Correction — what is true on 2026-10-19, superseding the dated statements below

This file is append-only, so older sections state the position on the day they were written. Three claims
repeated in them are **no longer true**, and are corrected here rather than deleted, because the record of
what was believed when is worth keeping:

1. **"#83 and everything below is frozen, still carrying the pre-repair #79" is false.** Every link from
   #80 to #94 now carries the #79 repairs and everything after them. The chain was propagated link by
   link on 2026-10-19, fifteen heads, each with its own green exact-head Actions run.
2. **The two-live-segments description is spent.** It was measured on 2026-10-13 and was true then. Every
   link now contains its parent, checked with `git merge-base --is-ancestor` at each step rather than
   inferred from the PR base field.
3. **The accepted SHAs named below are superseded.** #80 is accepted at `55e368d` and #81 at `d3ad503`,
   both by formal exact-head review on 2026-10-19; the older `bd1c039` and `d9a34ff` verdicts belong to
   heads that have since moved. #94 is accepted at `852f855871ca48ad88c3799f8c0dd05636dfd700`, by formal exact-head review on
   2026-10-20; the earlier `df77cd7` verdict belongs to a head that has since moved. **#95 is accepted
   at `1c23f1b107a7c20a3c2d03b4f43e0316cfc91b67`**, also by formal exact-head review, on 2026-10-20, and
   **#96 at `8ce410252269fb6dd5af0737df3f310290e49542`** on the same day, and **#97 at
   `2aaf661574a9f2b72dbb6243111bef2e5afb0499`** on 2026-10-21, and **#98 at
   `28ff22f963da6786941c654831a5e053a57185e4`** the same day, and **#99 at
   `9b3823f2776eb0d221c10f2cf1df8c43c947543d`** on 2026-10-21, and **#100 at
   `27baa3d918001443080c534380a7b44acdf498d5`** the same day — the latter after **four** Astra rounds,
   three of them `CHANGES_REQUESTED`.

4. **The independent reviewer changed on 2026-10-21.** The owner made **Codex/Astra primary and paused
   Gemini/AntiGravity** (Issue #7, comment 6308798183). Earlier Gemini PASSes at their exact heads — #96
   through #99 and predecessors — remain accepted and are not to be repeated. New gates route to Astra
   alone, with **no fallback**. **Corrected the same day** (Issue #7, comment 6309185847): it is
   **Gemini** whose weekly quota is exhausted, replenishing in about three days, while **Astra has usage
   available** — so no `WAIT_ASTRA_QUOTA` hold is authorized. The first routing comment named the two
   models the wrong way round and this file repeated it; a routing or availability claim is a claim, and
   this one was superseded within the hour.

**One heading in this file says "Current work" and it is the next one.** Earlier sections that once held
that heading have been renamed to what they actually are, because four of them claiming to be current at
once is how the stale statements above went unnoticed.

### Current work — remediating Astra's two findings on P6-09 / PR #101

`CHANGES_REQUESTED` at `46e734b`, two blocking correctness findings, both real and both fixed on this same
branch. No propagation this round: #102+ stays untouched, nothing goes to `main`, and no reviewer is
assigned or invoked by me.

**[P1] An acceptance was not bound to the offer displayed.** The form carried no identity for the
commercial terms, and a globally-required document applies to every seller, so document ids could not bind
the selling entity. The store now computes an opaque digest of exactly what the summary renders — seller,
jurisdiction, settlement model, tax remitter, arrangement, interval, base price — the page posts it as one
hidden field, and the opening transaction compares it against its own fresh resolution. Mismatch is a new
`OFFER_CHANGED` refusal, placed before the document checks so the sentence is "the terms moved" rather
than "you did not tick a box".

**[P2] One language spelled two ways was two languages.** `en-US` and `en-us` each became version 1 of one
document, both current, neither superseding the other. Fixed at every place the identity is used:
publication canonicalizes and refuses an unparseable tag; version allocation matches by canonical
equality; the TypeScript grouping keys on the canonical language and *computes* the winner from
specificity, `effectiveFrom` and `version`; and in SQL `current_legal_documents()` groups case- and
separator-folded, a CHECK refuses the separator form no canonical tag has, and a folded unique index makes
two rows of one kind and one language sharing a version unreachable.

**Two things worth carrying forward.** The pre-fix winner was decided by the database's *collation*, since
locale negotiation returns the first matching candidate and candidates arrive in `locale ASC` order — so
both publication orders are needed and neither is sufficient alone. And reverting the entire SQL change
left all 100 tests green, because the coverage trigger matches by kind and the store refuses in TypeScript
before the acceptance trigger is ever reached; the suite now writes an acceptance by raw statement and
requires the database to raise on its own. Five mutations, one per part of the fix, are each caught.

**Then a hole in my own P1 fix, found before anybody claimed the head.** `offeredDigest` was optional, so a
submission that left the field out skipped the comparison and restored the defect in full — a guard the
untrusted client can switch off is not a guard. It is now required on `OpenCheckoutInput`, an absent form
field arrives as `""` which no digest can equal, and the refusal happens in the ordinary comparison with no
`undefined` branch. Cost: 16 test call sites had to start supplying a correct digest, because the digest
check runs before the document checks and they would otherwise have been handed `OFFER_CHANGED` instead of
the refusal they assert. `tsc` enumerated every one once `Request` dropped the field.

Gates at this head: no drift; `pnpm verify` under `env -i` exit 0 (208 files, 2041 passed / 1350 skipped);
PostgreSQL 48 files 1086/1086; Redis 55/55; E2E 103 files 1189/1189.

### Earlier — propagating the accepted #100 into P6-09 / PR #101

#100 was accepted at `27baa3d918001443080c534380a7b44acdf498d5`, so this branch is the next link. Ordinary
non-rebase merge, one branch only — no rebase, no force-push, nothing to `main`, #102+ untouched. #101 was
**81 commits behind** while carrying 19 of its own.

**Two conflicts, and the one that mattered was in the file four review rounds had just rewritten.** #101
added 354 lines to `billing-routing-store.ts` while the accepted parent carried every round of the P6-08
remediation, so git conflicted on one import line and auto-merged the rest. Resolved as the union the
calls actually require: `billingProviderRegistered` is #101's and is called at `checkoutReady`;
`snapshotVerifiedBillingEvent` is the parent's trust boundary and is called at the entry point;
`assertVerifiedBillingEvent` has **no caller left** and was dropped rather than carried for symmetry.

The second was `apps/web/src/ui/outcome-notice.tsx`, where each side appended its own refusal codes —
#101's three checkout refusals and the parent's seven. Both sets kept.

**Every invariant the four rounds established was then checked by name in the merged file**, because the
rest of a 354-line divergence merged silently: the snapshot at the boundary, `laterOf`,
`extendSubscription`, the `billingEvent.count` attribution, `appliedTermEndsAt`, and the comment recording
why `providerReference` cannot serve as charge identity. All present. The worker registry is still 9 loops
/ 9 closes / prose "nine", 69 models match 69 `CREATE TABLE` statements, the barrel has no duplicate name,
and there is no drift.

### Task definition — P6-09 / Issue #47, terms acceptance before the redirect

**Branch `feat/p6-09-terms-acceptance-ux`**, based on `feat/p6-08-billing-routing-seller-profiles`.

**The screen exists because of one sentence in the spec:** acceptance of the Public Offer and the Terms is
evidenced by an explicit control **before** the redirect, not by the later act of payment. A product that
inferred consent from a completed charge would have no record of what anybody agreed to and no way to
answer the only question a dispute asks — *which version, in which language, by whom, and when.*

So the checkout step shows four things a person must be able to read before committing: **who is selling
to them** (the legal entity, not the product's brand), **what it costs**, **who remits the tax** — because
on a Merchant-of-Record route the invoice is the provider's and its own terms additionally apply at its
hosted checkout — and **the exact document versions** being accepted, each as its own tick, **none
pre-ticked**.

**Nothing on the screen decides anything.** The server refuses a submission with a box unticked whatever
was rendered, refuses a superseded version, and refuses a route whose provider cannot settle. The screen
decides only what somebody is *shown*, and like `billing-screen.ts` it is assembled away from the
authenticated request path so a test can drive it.

**The migration closes two places where #46 left the store and the database disagreeing about "accepted".**
The applicability trigger now requires each acceptance to name the **current** version of its kind and
locale, and the coverage trigger reads the requirement from the current version rather than from any
effective row — which also closes the opposite hole, where an old version marked required went on
demanding an acceptance after a newer version had stopped. Previously a caller reaching the tables
directly could satisfy the trigger with a superseded version.

**And the locale disagreement was worse than a mismatch.** `readLegalDocumentOffers` filtered by an exact
locale while the trigger filtered by none, so a workspace whose interface language the offer had not been
translated into was offered **no documents at all** and then had its checkout killed by the trigger with a
raw exception. The product half of the fix is locale negotiation in the store; the evidence half is
`legal_acceptances.locale`, which records the language of the page somebody actually accepted on.
`REFUND_POLICY` joins the document kinds so the policy is linkable rather than implied.

### Earlier — P6-08 / PR #100, round three: what an authenticated payload can actually prove

Astra confirmed the snapshot fix closed the asynchronous mutation, and confirmed the historical-reversal
and reordered-renewal behaviour. Two findings remained, both about reversal attribution, and together they
say something sharper than either alone: **I kept reaching for evidence the payload does not contain.**

**P1 — a subscription reference is not proof of a payment.** `NormalizedBillingEvent.providerReference` is
documented as "the provider's own subscription **or** charge object", so on a recurring arrangement two
separately paid terms legitimately carry the same value. My comparison treated a match as identity, so a
refund of the first charge — arriving with the shared subscription id — matched the current row and
revoked the second term. Astra reproduced it with `providerReference='sub-shared'`.

**P1 — "the most recent grant" is not the payment that bought the term in force.** Selecting
`orderBy occurredAt desc` picks by event *time*, while the monotonic renewal rule I added in round one
deliberately lets a **delayed** event buy a term reaching *farther* than one already applied. So a refund
of the shorter, later-raised grant ended the longer term a delayed renewal had bought. The two fixes were
individually right and contradicted each other — which is the shape worth remembering.

**The repair is to stop guessing.** A reversal on an arrangement with more than one grant now revokes only
when it *states* a period reaching the term in force; that is the one proof the payload carries. The
reference comparison is gone, with the reason written down so nobody restores it, and the latest-grant
selection is gone with it — the ledger is only *counted* now. A single grant still revokes unconditionally,
because there is no other term it could concern. Anything else is recorded with `effect: NONE`, audited,
and left to `reconcileProviderState`, which reads the provider instead of inferring from a field that
cannot answer.

The cost is explicit and is stated in the code: a disputed term stays live until that read. The
alternative deletes a term somebody paid for on the strength of a guess, which is worse and, from inside
this transaction, irreversible.

**Attribution is now persisted rather than inferred**, as the review asked: `writeEvent` records the
`appliedTermEndsAt` the grant actually put in force — read back from the arrangement inside the same
transaction — so computed fallback terms are attributable too, not only the ones a provider chose to
state.

**And one of my own controls had to go.** "Revokes the current term when the reversal names the charge
that bought it" encoded exactly the reference-matching Astra rejected. It is replaced by a control that
proves the same intent with evidence that holds: a reversal stating the period the current term covers.
Three new regressions join it — both reversal kinds sharing a subscription reference, and a refund of the
shorter grant against a longer term bought by a delayed renewal.

Mutation-checked against the exact code reviewed: those three fail, and the replaced control passes in
both states because it rests on a proof that was always honoured.

### Earlier — P6-08 / PR #100, round two: both remediations had holes

Astra re-reviewed `a5efdf9` and returned `CHANGES_REQUESTED` again, with two findings — **both of them
against my own fixes rather than against the original code.** Both were right, and neither was something
the first round's tests could have caught, because I wrote those tests to the shape of my fix rather than
to the shape of the problem.

**P1 — I correlated a reversal by the wrong fact.** The ledger check compared the granting payment's
`occurredAt` with the *reversal's* `occurredAt`. But a reversal's `occurredAt` is when the reversal was
**raised**, not when the charge it reverses was made — `NormalizedBillingEvent` says exactly that — so a
refund issued today for last month's invoice is legitimately *newer* than today's renewal and sailed
straight through the guard. My own regression had hidden it: I gave the reversal the old payment's
timestamp, which covers an old reversal **delivered late** and not a new reversal **of an old charge**.

Time cannot answer the question, so identity does. The reversal now attributes in three steps: a stated
period earlier than what is paid for names an earlier term; a stated period reaching the current term
names *that* one and revokes it; and with no stated period the ledger is asked how many payments have
granted a term on this arrangement at all. One means there is nothing to confuse — the money being
returned bought the access, and that is the ordinary refund. More than one means only the provider's own
charge reference can say, and `writeEvent` now retains that reference on every event row for exactly this.
Unmatched or absent, a term somebody paid for is not deleted on a maybe.

**P2 — the tamper check guarded the wrong moment.** Asserting at the entry point answers a question about
one instant, and the store then awaits a route lookup, a transaction and several queries. A caller still
holding the object it passed in can move a `Date` inside it while any of those are pending; Astra
demonstrated a renewal minted for January, mutated to 2099 during a gated lookup, granting service until
2099. Re-asserting after each await does not close it, because there is always another await.

So the boundary now takes a **private snapshot**: `snapshotVerifiedBillingEvent` authenticates and returns
a frozen deep copy, and `recordVerifiedBillingEvent` reads that copy for all nineteen of its subsequent
`event.` accesses. The caller's object is never read again — the parameter is renamed `delivered` so that
is visible at the signature.

**Five more regressions, including the one that is hard to write.** Both reversal kinds raised *after* the
renewal with no stated period; two controls that keep the identity check from degenerating into "a
reversal naming nothing never does anything" — an ordinary refund of the only payment ever made still
revokes, and a reversal naming the charge that bought the current term still revokes; and an
**asynchronous** store-level case that gates the real route lookup against the real database, mutates the
caller-held event while it is pending, releases it, and proves the altered year reaches neither a row nor
the audit detail.

Mutation-checked against the exact code Astra reviewed: the three new behavioural regressions fail, and
both new controls pass.

**The lesson, recorded because it is the second time this round:** I wrote the first round's tests to the
shape of my fix. A regression written from the fix can only confirm the fix; the one worth writing comes
from the shape of the *defect*, which is why Astra's "reversal raised after the renewal" and "mutate
during an await" cases found what mine could not.

### Earlier — remediating Astra's three blocking findings on P6-08 / PR #100

Astra returned `CHANGES_REQUESTED` on `55fbf98` — the first blocking verdict of this chain, and the first
review by Astra since the route changed. Three findings, all of them real, all of them in code I wrote.
Verified each by reading the code before changing anything.

**P1 — an older-term reversal revoked a newer paid term on the *same* arrangement.**
`billing-routing-store.ts`'s `END` branch asked only whether the arrangement was still live, then wrote
`INACTIVE`. So a February chargeback took away access paid for through April. The superseded-arrangement
case already covered was a *different* shape: there the two terms are two rows and the guard was
structural. Here one arrangement holds two consecutive terms and nothing but attribution distinguishes
them. The asymmetry was visible in the file all along — `SUBSCRIPTION_CANCELED` preserved a future
`paidThrough`, a reversal did not.

Fixed with two questions, because a reversal can be identified two ways and the ordinary case has neither
field missing nor a puzzle to solve: a stated `periodEndsAt` earlier than what is already paid names an
earlier term outright; and where the provider states no period, the retained event ledger answers it —
if the event that granted the term in force occurred *later* than the payment being taken back, that term
was bought separately. `writeEvent` now retains a stated period on every event row so the ledger can
answer this afterwards too.

**A first attempt at that fix was wrong and an existing test caught it.** Treating every unstated period
as "ambiguous, change nothing" broke the ordinary case — refunding the only payment ever made *is* the
current term and must still revoke it. The qualifier in the finding is "a **separately paid** current
term", and separateness is a fact about the ledger, not about a missing field.

**P1 — a delayed renewal moved the paid-through date backwards.** The maximum the code computed guarded
only the fallback used when a provider states no period of its own, so a provider that *does* state one —
the normal case — wrote its value straight into the subscription. Event-id idempotency cannot help: a
reordered delivery is a different event, legitimately processed, carrying an older term.

**And the fix for it was itself incomplete, which the concurrency test Astra asked for is what found.** A
read-then-write comparison is not concurrency-safe: two renewals with different event ids are two
transactions, both read the same `paidThrough`, both decide they extend it, and the one that commits
second wins — so a renewal buying *less* time still overwrote one buying more. The write now carries the
comparison (`extendSubscription` does a conditional `updateMany`), which is the same reasoning this file
already applies to `billing_arrangements_one_live_key`: a decision an application makes before a write is
a decision another writer can invalidate.

**P2 — a verified event was not actually immutable.** `Object.freeze` is shallow and the spread feeding it
was shallow too, so a minted event shared its `settled` object and its `Date`s with the adapter that
produced them. The adapter could raise the amount afterwards, anybody holding the event could call
`periodEndsAt.setUTCFullYear`, and a `WeakSet` membership test could see neither — while the function's own
comment promised exactly that it could not happen.

Fixed in three steps because each closes a different hole: the mint **snapshots** nested money and dates
so the adapter's references are severed; the freeze still stops a field being replaced outright; and the
`WeakSet` becomes a `WeakMap` of the authenticated facts, so `assertVerifiedBillingEvent` recomputes them
and an event altered after minting is no longer the event that was verified. A `Date` cannot be made
immutable, so the answer is not to try — it is to make the edit detectable.

**Regressions, with their controls.** Seven new cases: both reversal kinds naming the first term, an
unstated-period reversal, a reordered renewal, a concurrent renewal race, and the two positive controls
that stop the whole thing collapsing into "reversals and renewals do nothing" — a reversal of the payment
that bought the term in force still revokes, and a renewal that genuinely buys more time still extends.
Seven more in a new infrastructure-free `billing-events.test.ts`, which performs the mutations rather than
asserting shapes, because a test checking `Object.isFrozen` would have passed against the defect.

Mutation-checked: against the pre-fix store exactly the five new regressions fail and both controls pass;
against the pre-fix event module four of the seven unit cases fail, the three that pass being ones that
were already true.

### Earlier — propagating the accepted #99 into P6-08 / PR #100

#99 was accepted at `9b3823f2776eb0d221c10f2cf1df8c43c947543d`, so this branch is the next link. Ordinary
merge commit, one branch only — no rebase, no force-push, nothing to `main`, #101+ untouched. #100 was
**77 commits behind** while carrying **19** of its own, the largest own contribution of the chain.

**Zero textual conflicts, and this is the link where that was most misleading.** The merge produced three
defects in `apps/worker/src/main.ts` and its test, none of which any gate would have caught, and all of
the same shape: **neither side was wrong on its own.**

| what the merge produced | where it came from |
|---|---|
| 9 loops and 9 `close()` calls under prose reading *"eight independent closes"* | the ninth loop (`checkout_expiry`, from `startBillingSweeper`) is this branch's; the word "eight" is the accepted parent's |
| the comment enumerating the unconditional loops named three of four | same split |
| the sibling test case pinned `follow_ups`, `retention`, `usage_reservations` but **not** `checkout_expiry` | this branch had no positive assertions there at all; the parent contributed exactly three |

All three are corrected on this commit, and the correction was then mutation-checked rather than trusted:
dropping any one loop from the report fails **2** of the 10 lifecycle cases, while reverting the new
sibling pin and dropping `checkout_expiry` fails only **1**. So the added assertion covers the
no-credential-key configuration that the whole-list case never reaches — the same measurement that
justified the equivalent edit on #96.

Everything else was checked and clean: **69 models against 69 `CREATE TABLE` statements**, no duplicate
name in the barrel, no drift, 0 TypeScript errors on the merged tree.

**The capacity-lock record is carried forward unchanged**: accepted as architecturally sound, the direct
`createBusinessProfile` observer test **still absent**, gap **not** closed.

### Task definition — P6-08 / Issue #46, seller profiles and billing routing

**Branch `feat/p6-08-billing-routing-seller-profiles`**, based on `feat/p6-05-billing-settings-ui`;
ADR-019. Recorded here now; neither canonical document named it.

**The payment provider and the selling legal entity are two different choices**, because the market treats
them as two. A direct processor leaves us the seller of record; a Merchant of Record *is* the seller to
the customer and remits the tax. The same provider can serve two seller entities and the same entity can
sell through two providers, so a `SellerProfile` and a `BillingRoute` are separate rows and a route names
one of each. Settlement models: `DIRECT_PSP`, `MERCHANT_OF_RECORD`, `CRYPTO_PROCESSOR`.

**Providers differ, and pretending otherwise is how a product ships a lie.** A route *declares* its
capabilities; nothing assumes recurring subscriptions, proration, invoices or tax remittance. Tax
**calculation** and tax **remittance** are deliberately two capabilities — a processor that can work out
VAT is not thereby the Merchant of Record for it.

**Two payment models normalize into one entitlement layer.** `RECURRING` and `PREPAID_TERM` both grant
service; the difference is whether a renewal may be *assumed*, and a prepaid term therefore always
carries an explicit end.

**Money is never a float and a quote is never a price change.** Amounts are whole minor units of a named
currency or asset. The catalogue may price a plan in EUR while a crypto route quotes the same plan in an
asset for fifteen minutes; the quote records what was asked and settles or does not, and the plan's
meaning is untouched either way.

**The client never names a route, a provider account or a selling entity.** `openCheckoutContract` takes
a plan version, an interval, an arrangement kind and a currency — the product facts a customer is
entitled to choose — and the route is selected from operator configuration the customer cannot write.
**There is no parameter in which a forged identifier could arrive, which is a stronger statement than
validating one would be.**

**A checkout is written before the customer is sent anywhere, and never edited after.** It records what
was offered, by which seller entity, at what price, and which terms were accepted; a trigger freezes it,
and a deferred constraint trigger refuses to let it commit without its acceptances.

**Only a verified provider event or an authoritative reconciliation activates anything.** The type
`VerifiedBillingEvent` cannot be constructed outside `billing-events.ts`, so a success-page handler has
no way to reach the activation path even by mistake — `ACTIVATION_SOURCES` is exactly
`VERIFIED_EVENT` and `RECONCILIATION`. **A browser redirect cannot activate paid entitlement.**

**One live charge path per workspace**, enforced by a partial unique index rather than an application
check, because the race it prevents — two checkouts completing at once — is the one an application check
loses. A provider switch ends the old arrangement and opens the new one in a single transaction.

Its route producer is `scripts/billing/publish-routes.ts` with its own 8-case suite; no production route,
provider account or identifier was registered, and no Merchant of Record, jurisdiction, tax position or
financial term was chosen — those stay owner-gated.

### Earlier — propagating the accepted #98 into P6-05 / PR #99

#98 was accepted at `28ff22f963da6786941c654831a5e053a57185e4`, so this branch is the next link. Ordinary
merge commit, one branch only — no rebase, no force-push, nothing to `main`, #100+ untouched. #99 was
**76 commits behind** while carrying 12 of its own.

**Zero conflicts and zero application-code edits, for the second link running.** The merged tree was
typechecked before anything else — 0 TypeScript errors — because two links before that merged clean and
then did not compile. Same cause as #98: this branch had been tracking its parent, so its callers were
already adapted.

Checked rather than trusted: 62 models against 62 `CREATE TABLE` statements, no duplicate name in the
barrel, no drift, and the worker loop registry still 8 loops / 8 `close()` calls / prose saying "eight",
counted by bracket depth.

**The guard this link mattered most for is the provider boundary**, because P6-05 is the first UI that
displays money. `billing-screen.integration.test.ts` holds it directly: *"hands no provider identifier to
the page"* serialises the whole screen and asserts it contains no `providerPriceId`. It passes, along with
the three `apps/web/src/i18n` gates that fail a build rather than a test.

**The capacity-lock record is carried forward unchanged**, per the directive's point 5: Gemini accepted
the implementation as architecturally sound, the direct `createBusinessProfile` observer/interleaving test
**remains absent**, and that gap is **not** closed here.

### Task definition — P6-05 / Issue #42, the billing and usage settings screen

**Branch `feat/p6-05-billing-settings-ui`**, based on `feat/p6-06-commercial-catalog`. Recorded here now;
neither canonical document named it.

**The browser is never the authority.** A checkout return parameter is read, and all it decides is which
*sentence* to show. The plan, the state and the dates are the server's answer at `at`, so a page reached
with `?checkout=success` after a payment no webhook has confirmed shows the subscription as it actually is
and says a confirmation is pending — rather than claiming an upgrade the system has not seen.

**A downgrade is explained before it is offered.** The accepted behaviour is that nothing is deleted and
the person is shown *which* of their resources exceed the new plan, so every offer carries its own
consequences instead of a yes-or-no. `planChangeConsequences` therefore names the excess: *"you are over"*
is not something anybody can act on, *"these three Business Profiles are over"* is.

**The arithmetic lives in the domain, not in a component.** `packages/domain/src/plan-change.ts` holds
both the change consequences and `ALLOWANCE_HEALTHS` (`OK` / `WARNING` / `EXHAUSTED`), on the stated
ground that a number a business is about to make a decision on should not be computed somewhere nothing
can test it.

**`CHECKOUT_AVAILABLE` is one named constant, deliberately `false`.** It stays false until a billing
provider is chosen and its adapter exists (#41), stated once rather than as scattered conditionals, so the
screen says "not available here" in one voice and there is a single place to change when the adapter
lands.

**No provider identifier reaches the page.** The read model copies an amount and a currency and drops the
provider's own price object; the guard serialises the screen and asserts the absence. Mutations are
OWNER-only with authorization re-resolved from the database on every call.

**The screen is assembled away from the authenticated request path**, exactly as `style-screen.ts` is:
`billing-page.ts` adds authorization and the translator and cannot be imported under Vitest, because
Auth.js reaches for Next's server runtime. Everything a test needs lives on the other side of that line —
which is why there is a 14-case integration suite over a screen at all.

### Earlier — propagating the accepted #97 into P6-06 / PR #98

#97 was accepted at `2aaf661574a9f2b72dbb6243111bef2e5afb0499`, so this branch is the next link. Ordinary
merge commit, one branch only — no rebase, no force-push, nothing to `main`, #99+ untouched. #98 was **75
commits behind** while carrying 12 of its own.

**Zero conflicts, and this time that was the truth rather than a warning.** The two links before it both
merged clean in files that then failed to compile, so the tree was typechecked before anything else:
**0 TypeScript errors**. The reason is visible in #98's own history — it had already merged #97's earlier
states four times, including `c32b9fb` "Merge the capacity-lock correction", so its callers were adapted
to the required `PolicyInput.commercial` and to `createBusinessProfile`'s `DbClient` signature before this
propagation arrived. A branch that tracks its parent pays the cost in instalments.

Checked rather than trusted anyway: **62 models against 62 `CREATE TABLE` statements**, no duplicate name
across the barrel's 53 export lines, no drift, and the worker's loop registry still reports **8 loops with
8 `close()` calls and prose that says "eight"** — counted by bracket depth, because a first count with a
line-anchored pattern said seven by missing the conditional spread.

**The capacity-lock record is carried forward unchanged, per the directive.** Gemini accepted the
implementation as architecturally sound; the direct `createBusinessProfile` observer test **remains
absent** and that gap is **not** closed. It is also not this link's to close.

### Task definition — P6-06 / Issue #43, the accepted commercial catalogue

**Branch `feat/p6-06-commercial-catalog`**, based on `feat/p6-03-entitlement-enforcement`. Recorded here
now; neither canonical document named it.

**The price book is data, in one file, read through the ordinary catalogue store.** The spec requires that
public pricing come from the plan catalogue and not from duplicated constants, so a pricing page reads it
through `readCatalog` — which means a price shown to a customer and a price they are charged **cannot
drift apart, because there is only one of them**. Starter / Growth / Scale, in EUR, with versions that are
immutable: re-pricing or re-packaging publishes a new version, and triggers refuse an edit or a delete on
either table.

**Add-ons are two kinds, and the kinds matter.** `RECURRING_CAPACITY` raises a limit for as long as it is
held — one more Business Profile, one more seat. `ONE_TIME_ALLOWANCE` tops up a metered allowance once —
the 500, 2,000 and 5,000 voice-minute packs.

**Two things are deliberately absent, and both are load-bearing.** There is **no AI-reply quota**: core
generation is customer-facing `UNMETERED` on every paid tier, so no `AI_GENERATION_CYCLES` entry exists to
find. The ledger still counts generations internally, which is a different thing and must never be shown
as a billable allowance. And there are **no provider price identifiers**: those are references a billing
adapter fills once a provider is chosen (#41), and the catalogue is interpretable without them, because a
plan's entitlements come from its own grants and never from a provider's price object.

**`pnpm catalog:publish` is the producer, and its absence was not a small gap.**
`publishAcceptedCatalog` had been reachable only from tests, so a deployed database held no plan versions
and no prices at all — which does not fail loudly. It fails quietly in three places at once: the first
Business Profile connects and `ensureWorkspaceTrial` finds no trial plan so silently returns
`{ started: false }`; `readCheckoutOffer` has nothing to quote and refuses with `NO_PRICE`; and the
billing screen reads an empty catalogue, so a pricing page shows nothing to buy. Each of those reads like
a product decision rather than a missing deployment step, which is why it survived review — the same shape
as the release tables before `pnpm release:record` existed.

**Publishing is deliberately not idempotent, and the script says so rather than pretending.**
`publishPlanVersion` cuts version N+1 every time it is asked, so a repeat is "wasteful rather than wrong":
a second identical version goes on sale and `readCatalog` still answers with one plan per code. The script
therefore **declines by default** once anything is published and reports what it found; `--republish` cuts
a new version deliberately, which is what a changed price needs, and `--dry-run` writes nothing and
reports the decision.

Its test lives at `scripts/catalog/publish.test.ts` and **does run in `pnpm verify`** — the root vitest
config declares a third project, `tooling`, over `scripts/**/*.test.ts`. Verified by arithmetic rather
than by assumption: 170 `.test.ts` plus 23 `.test.tsx` under `apps/` and `packages/`, plus 3 under
`scripts/`, is exactly the 196 files `verify` reports.

### Earlier — propagating the accepted #96 into P6-03 / PR #97

#96 was accepted at `8ce410252269fb6dd5af0737df3f310290e49542`, so this branch is the next link. Ordinary
merge commit, one branch only — no rebase, no force-push, nothing to `main`, and #98+ untouched. #97 was
**74 commits behind** while carrying 11 of its own.

**Three files conflicted, and none of the three was the expensive part.** `apps/web/src/server/simulation.ts`
and `packages/db/src/testing/fixtures.ts` were both the shape where each side appends its own thing: an
import line, and a pair of helper functions sharing one doc-comment opener. Resolved as unions, and each
imported name was then checked to be *used* — an import union that leaves one unused fails
`eslint --max-warnings=0`, so the union has to be measured rather than assumed. Both halves of
`fixtures.ts` have live callers: `setProfileDefaultPolicy` in five suites, `createPaidWorkspace` in five
more, so dropping either side would have broken real tests rather than dead code.

**`packages/db/src/repositories/workspaces.ts` was a genuine semantic collision in `createBusinessProfile`.**
This branch wraps the create in its own transaction with the capacity lock and `PlanLimitError`; the
accepted parent writes the profile's default automation policy as a nested create in the same statement.
Each side's version of the `create` call lacked the other's contribution, so **either side taken whole
loses a feature**: the capacity ceiling, or the policy every new profile is born with. The union keeps
both, with the nested policy write inside the transaction the capacity check already holds.

**Two defects merged clean and only the typechecker and the suites found them** — both of the shape where
one side changes a contract and the other side's callers never conflicted with it:

1. `policy-store.integration.test.ts` called `createBusinessProfile(tx, …)`, written when the signature
   was `DbExecutor`. This branch takes a `DbClient` and opens its own transaction. **A cast would have
   been worse than the type error:** Prisma would open a second, independent transaction, so the test's
   outer rollback would never reach it and the case would assert a guarantee nobody provides. The case is
   removed with a note saying where its property is still covered, and what is not.
2. `simulation-inputs.test.ts` built a `PolicyInput` without `commercial`, which this branch made
   **required** precisely so the compiler names every caller. Supplied as fully permitted, with the reason
   written down: a restrictive value there would have the billing gate refuse every case and the suite
   would pass while proving nothing about the inputs it compares.

And one defect that compiled and failed at runtime: `followup-slice.integration.test.ts` built its
workspace with `createWorkspaceWithOwner`, so with no subscription it resolved to `INACTIVE` and three
follow-ups stayed `PENDING`. The suite had silently become a test of the billing gate — which is the exact
failure `apps/worker/src/testing/paid-workspace.ts` exists to prevent, and which its four sibling slice
suites already avoid by using it. Converted.

### Task definition — P6-03 / Issue #40, enforcing entitlements where the money is spent

**Branch `feat/p6-03-entitlement-enforcement`**, based on `feat/p6-02-usage-ledger`. Recorded here now;
the work was on the branch and neither canonical document named it.

**The commercial fact is three booleans and it is required, not optional.** `CommercialAccess` carries
`paidWorkAllowed`, `aiDrafts` and `autopilot`, and `PolicyInput.commercial` is a required field. Its own
comment states why: an optional commercial fact would default to "allowed" at every site that forgot it,
which is the one direction a billing boundary must never fail in. Required, the compiler names every
caller that has to decide, and a caller with no snapshot says so with `NO_COMMERCIAL_ACCESS` rather than
by omission. This propagation produced one such caller, and the compiler duly named it.

**Three refusal codes rather than one, because they call for three different actions.**
`BILLING_INACTIVE` is answered by paying and is deliberately not a claim about the plan's contents — a
workspace on the best plan carries it the day after its card fails. `BILLING_FEATURE_OFF` is answered by
changing plan, and the server decides it, so a business that set AUTOPILOT on a plan that does not sell it
gets replies held for a person however the screen looked. `BILLING_LIMIT` is answered by waiting for the
cycle or topping up, and never by inventing the thing that could not be paid for. Core AI replies cannot
produce `BILLING_LIMIT` at all, because the initial plans do not meter them.

**An approval answers these gates.** The manual path stays open while automation is held, so a workspace
whose billing lapsed remains usable and its conversations answerable.

**The `aiDrafts` check is kept at the decision even though generation refuses earlier**, where the
provider call is paid for. Its comment gives the rule: a gate that trusts an upstream layer to have
already checked is not a gate. It is reached by a draft generated before a downgrade.

**Capacity is serialized where it is counted.** `createBusinessProfile` holds an advisory lock across its
count-and-insert inside its own transaction, because a count followed by an insert is not atomic and no
index caps a count. See the disclosure on PR #97 about what that lock's test does and does not prove.

### Earlier — propagating the accepted #95 into P6-02 / PR #96

#95 was accepted at `1c23f1b107a7c20a3c2d03b4f43e0316cfc91b67`, so this branch is the next link: that
head is merged in by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to
`main`, and nothing into #97 or below, which stay untouched.

#96 was **73 commits behind** while carrying 9 of its own, the same shape as the link before it.

**The conflict was `apps/worker/src/main.ts` and its test, which is the most consequential resolution in
this whole propagation, and the markers showed two of the six edits it needed.** Both sides add a
background loop the other lacks: this branch starts the usage-reservation sweeper, the accepted parent
starts the follow-up sweeper. Keeping either side would silently stop a loop that is wired and running —
the Issue #9 defect arriving through a merge rather than through code. The six places:

1. the loops the report names — a union of three, in the order `main.ts` prints them;
2. the comment above it, which enumerated the unconditional loops and had to gain `usage_reservations`;
3. **the count stated in prose** — "seven independent closes" over what is now eight, which conflicted
   with nothing and would have merged clean and wrong;
4. the expected list in `main.test.ts`, asserted as the *whole* list on purpose;
5. that test's explanatory comment, same reason as 2;
6. **the sibling case** that checks the unconditional loops when the token refresh cannot start, which
   pinned `follow_ups` and `retention` but not `usage_reservations` — and whose own comment says a loop
   checked only in the fully-configured case is one it would not notice losing. It conflicted with
   nothing either.

Git merged the declarations and the eight `close()` calls correctly on its own; the array was counted by
bracket depth rather than by eye, because a first attempt to count it with a line range ran past the end
and reported eleven.

`packages/db/prisma/schema.prisma`, `packages/db/src/index.ts` and `apps/web/src/server/simulation.ts`
merged **clean**, and were checked rather than trusted: 56 models against 56 `CREATE TABLE` statements,
no duplicate name across the barrel's 51 export lines, and no drift.

### Task definition — P6-02 / Issue #39, the usage ledger and quota reservations

**Branch `feat/p6-02-usage-ledger`**, based on `feat/p6-01-plan-entitlements`. Recorded here now: the
work was implemented and reviewed-ready on the branch but neither canonical document named it, which is
an omission in the record rather than in the code.

**Two kinds of counting, kept apart deliberately.** An *internal metric* exists for unit economics,
fair-use, anomaly alerting and capacity planning and **can never refuse work**; a *customer-facing quota*
is an allowance a plan sells, and exhausting it stops the thing it pays for. Core AI replies are included
and unmetered in the initial plans, and `AI_GENERATION_CYCLES` being internal is how the code *states*
that rather than merely documenting it: `reserve` against an internal metric is refused outright with
`NOT_A_QUOTA`, in the store and again by a CHECK, so no path exists by which an exhausted allowance could
hold a reply.

**One logical operation is counted once, enforced by the database and not by care.** Every write names a
`usageOperationId` derived from facts fixed before the work began, and `usage_ledger_operation_key` is
unique on `(workspace, metric, operation, kind)`. A duplicate worker, a provider retry and a requeued job
cannot double-count — not because a caller checked first, which a second worker can lose a race against,
but because the second insert is refused.

**The last unit of an allowance cannot be sold twice.** `reserveUsage` locks the counter row, resolves the
entitlement and decides *inside* that lock, so the read, the judgement and the write describe one instant.
Settlement is `commitReservation` or `releaseReservation`, and `d5c563d` races two settlements of one hold
specifically to prove the lock does what the prose claims.

**Ingestion never calls it.** Nothing in this file can stop an inbound message being persisted.

The domain half holds no clock, database or provider: a cycle boundary (`usageCycleFor`,
`nextUsageCycle`) and a reservation decision are arithmetic, testable in isolation. Stale holds expire
through `expireStaleReservations`, swept by the worker's `usage_reservations` loop with a 30-minute TTL.

### Earlier — propagating the accepted #94 into P6-01 / PR #95

The P5-07 lead-board propagation finished and was **accepted** at #94
(`852f855871ca48ad88c3799f8c0dd05636dfd700`, formal exact-head review on 2026-10-20). This branch is the
next link: that accepted head is merged in by ordinary merge commit, **one branch only** — no rebase, no
force-push, nothing to `main`, and nothing into the links below this one. #96+ remain held.

This link is far larger than the fifteen before it. #95 was **72 commits behind** the accepted parent
while carrying 10 of its own, so the merge brings the whole #80→#94 security and WhatsApp chain into a
branch that had seen none of it: **86 files under `apps/` and `packages/` merged cleanly**, against the
two documentation files a late propagation link usually carries.

**Exactly one file conflicted — this one — and the textual conflict is the least of the work.**
`packages/db/prisma/schema.prisma`, `packages/db/src/index.ts` and `apps/web/src/i18n/catalogue.ts` all
merged *clean*, and those are the three shapes that break silently: an interleaved migration order that
drifts, a barrel that re-exports two things under one name, and a localization catalogue whose missing
key fails the web build rather than a test. Each was verified rather than assumed.


### Earlier — propagating the P5-07 lead-board authorization fix into P3-04 / PR #94

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

This is the **last** link of that propagation: it began at the fix's origin on #80 and moved one branch
per directive, fifteen heads in all. The merge carries **nothing** under `apps/` or `packages/` — every
code change the fix needed had already arrived at #93 and was verified there, so this link carries only
the record. That emptiness was measured against the merge base, not presumed from the absence of a
conflict, and both live segments were then re-checked file by file and contract by contract.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

**Thirty-three dangling headings were removed from this file in the same commit, and one of them was
created by this very merge.** A `### ` heading with an empty body renders as a title owning nothing, and
they had been accumulating one or two per link: a conflict region that covers only the heading line —
which is what happens when both sides' bodies are identical and git matches them — resolves to *two*
headings and *one* body, and renaming a heading to "Earlier" left the old line behind as well. Twelve
had collected in a single consecutive run. The removal was verified not to lose anything: every
non-blank line that is not a `### ` heading is byte-identical to before, all twenty `#### ` headings
survive, and each removed title still names a section that exists elsewhere **with** a body. The two
remaining body-less headings are `## First task — HISTORICAL` and `## Second task — HISTORICAL`, which
are genuine parents of the `### ` sections beneath them and were left alone.

### Earlier — propagating the P5-07 lead-board authorization fix into P4-07 / PR #93

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P4-06 / PR #92

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P4-05 / PR #91

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P4-04 / PR #90

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P4-03 / PR #89

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P4-02 / PR #88

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P4-01 / PR #87

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into the dead suspension resolver fix / PR #86

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into the Instagram token lifecycle fix / PR #85

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P5-09 / PR #84

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P5-08 / PR #83

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P3-02 / PR #82

PR #80 moved: `saveStageDisplays` had let an AGENT holding one Business Profile rename, reorder and
hide the lead stages on the board every profile in the Workspace reads, because `lead_stage_displays`
has no `business_profile_id` column and no layer applied a role check. That fix is merged into this
branch by ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`,
and nothing into the links below this one.

The merge conflicted only on this document, where both branches append their own section. Resolved as
a union rather than a choice, and checked rather than assumed: every line either side added since the
merge base is present below, apart from headings deliberately renamed to keep one "Current work".

### Earlier — propagating the P5-07 lead-board authorization fix into P3-01 / PR #81

PR #80 moved: a role check was added to `saveStageDisplays`, which had let an AGENT holding one
Business Profile reconfigure the lead board every profile reads. That fix is merged into this branch by
ordinary merge commit, **one branch only** — no rebase, no force-push, nothing to `main`, nothing into
#82 or later. The merge touched only the two canonical documents, which both branches append to; the
three code files came across unchanged.

**#80's earlier `ANTIGRAVITY_REVIEW: PASS head=bd1c039…` no longer covers its new head**, so the verdict
this branch inherited has moved too. The fix and its evidence are described in the section below, which
came across with it.

### The fix this branch inherited — the shared lead board had no role check (2026-10-19)

`lead_stage_displays` has **no `business_profile_id` column** — keyed `(workspace_id, stage)` and read by
Workspace alone — so it is the board every Business Profile sees. `saveStageDisplays` deleted and
recreated every row for `context.workspaceId` from a single-profile context with no role check at any
layer, so **an AGENT with one profile could rename, reorder and hide the lead stages on every other
profile's board**. It also never called `profileScopeOf`, so the branded-context validation never ran
there.

Fixed by requiring `WORKSPACE_ADMIN_ROLES` **before** the input validation, restoring `profileScopeOf` in
both stage functions, and gating the `StageConfig` render on `canConfigure` the way the channels and setup
screens already do. Four cases, each refusal reading the rows back; mutations caught 3 / 2 / 1 (guard
deleted, guard after the commit, guard after validation).

**This head moves, so #80's `ANTIGRAVITY_REVIEW: PASS head=bd1c039…` no longer covers it** — the branch
needs a fresh verdict, and the fix has to be merged down the chain one link at a time. Found while
bounding a different authorization class on #94 and traced here, to `3c666dd`, as its origin; the owner
directed it to this branch rather than downstream.

### Completed — PR #94, round two: the refusal tests were vacuous, and are not now

The remediation was right in the source and **proved nothing in the tests**, found by adversarially
re-checking my own work. Every refusal asserted only that `WorkspacePermissionError` was thrown; nothing
read the row back. `archiveKnowledge` and `saveStyleProfile` are **not transactional**, so a guard moved
*below* its write throws the same error while the write commits — measured at **52/52 and 50/50 passing**
with an AGENT actually archiving a shared knowledge source and rewriting the Workspace voice. Both
mutations now fail.

Also fixed: five bundled assertions in one `it` (the first failure ended the case, so later guards were
pinned only while earlier ones held — removing all three knowledge guards reported *one* failure); the
fact that `publishKnowledge` **is** `restoreKnowledge`, so three of those assertions shared one guard;
controls that used a *second* user while claiming "the same agent"; `approvedByUserId` asserted nowhere
although provenance is the central argument; and a `restoreStyleExample` doc comment asserting the
opposite of what `decide` implements.

**The lesson, since it generalises:** guard *sensitivity* — remove the guard, does a test fail — is not the
same question as "does a refusal change nothing", and only the second is the behaviour. Assert the effect.

**A live instance of the same class, upstream.** `saveStageDisplays` (`lead-store.ts:76`) wipes and
recreates every `LeadStageDisplay` row in the workspace from a single-profile context with no role check
at any layer, so an AGENT with one profile can rename, reorder and hide the lead stages on every other
profile's board. Introduced by `3c666dd` = **#80 / P5-07, upstream of #94** — it belongs at #80 and then
merged down, as its own directive, not here. The earlier "class bounded" claim missed it because the bound
grepped the `{ OR: [{ businessProfileId: null }, …] }` idiom, which cannot see a model that has **no**
`businessProfileId` column.

### Completed — PR #94 `CHANGES_REQUESTED`, remediated on this branch

**PR #94 / P3-04 received a formal `CHANGES_REQUESTED`** (Gemini/Antigravity review `5563757640`) at exact
head `5da1213cce104bf21ff0d697021db97867da7c58`. The reviewer independently reproduced the authorization
finding this branch had disclosed and named three scenarios — Knowledge Hijack, Knowledge Denial of
Service, Style Governance Bypass — then specified remediation matching the patch already prepared locally.
The owner's `CLAUDE_FIX_DIRECTIVE_FROM_PR94_CHANGES_REQUESTED` directed that patch onto the branch.

**Routing unchanged.** **#94 / P3-04 remains the sole gate; #95 onwards are frozen.** No rebase,
force-push, squash, merge to `main`, or propagation into #95+.

**What was unguarded.** `createKnowledge` and `createStyleExample` each require `WORKSPACE_ADMIN_ROLES` to
*make* a Workspace-scoped row. Changing or retiring one required nothing beyond access to any single
Business Profile, because every lifecycle call resolved its row through `scopeFilter(undefined, …)` /
`exampleScopeFilter(undefined, …)` — whose `null` branch **is** the Workspace-scoped row — and applied no
role check. Five call sites, one shape of mistake.

| path | act | now |
|---|---|---|
| `editKnowledge` | rewrite the facts every profile answers from | `requireRole` when the row is Workspace-scoped |
| `archiveKnowledge` | retire it from every profile's retrieval | ownership read added, then `requireRole` |
| `restoreKnowledge` / `publishKnowledge` | put it back into every profile's retrieval | `requireRole` above the act check |
| `decide` (approve / reject / archive / restore) | decide a shared style example, **stamping the approver** | one guard covering all four |
| `saveStyleProfile` | rewrite the voice every profile replies in | fixed earlier, at `5da1213` |

`archiveKnowledge` needed more than a line: it wrote through a blind `updateMany` and never read the row,
so there was nothing to check the scope against. The guard sits above the `act` check in the publish path
deliberately — a refusal that depended on `act` would leave whichever screen omitted it unguarded.

**The approver stamp is why this is not only an integrity question.** Approve and restore both record
`approvedByUserId`. A CHECK requires that name for anything `ACTIVE`, which is the database insisting a
human verified it. Unguarded, an agent could supply that provenance for content every profile's voice
draws on.

**Tests, and the control each one needs.** Fifteen cases across the two integration suites: an `AGENT`
refused for every listed Workspace-scoped mutation, the **same agent still performing the corresponding
profile-scoped operation** as the control, and an `ADMIN` allowed for each act the agent was refused.
Without that last row the refusals would also pass if the lifecycle were simply broken for everyone.

Each guard was then removed one at a time and the suite rerun — the honest check, since a refusal test
that passes with the guard gone is theatre. All five are individually pinned; no removal was silent.

**Reachability, stated rather than implied.** Approve and reject start from `SUGGESTED`, and **no writer in
this repository produces a Workspace-scoped suggestion**: `suggestStyleExample`, the composer's learning
write and `recordEditedDraft` all stamp `profileScopeOf(context).businessProfileId`, while
`createStyleExample` lands a Workspace example straight in `ACTIVE`. Those two rows are therefore inserted
directly in the tests, and the guard on those two transitions is defensive. Archive, restore, publish and
the knowledge paths are all reachable through ordinary product screens.

**Still open, and deliberately not taken here.** The ADMIN + `SELECTED`-scope half — wiring
`requireWorkspaceWideWrite` through three web actions that would each need a `WorkspaceContext` — is
outside this directive's scope by its own step 4. The gap it leaves is unchanged: an ADMIN holding only
`SELECTED` profiles can still create Workspace-scoped knowledge or style examples that profiles they were
never granted will read.

### Earlier — the accepted #93, propagated into #94 and nowhere else

**PR #93 / P4-07 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-18T12:59:07Z, commit `f3243dea3674d28242a812c8feb49013282d5cdf`, carrying
`ANTIGRAVITY_REVIEW: PASS head=f3243dea3674d28242a812c8feb49013282d5cdf` (review `5563083113`). **Phase 4 is
complete**: #87 through #93 each carry their own exact-head verdict.

**Routing unchanged.** **#94 / P3-04 is now the sole gate; #95 onwards are frozen.**

**The ancestry.** Both segments fork from `e439f39ab2a402707978f5c9cd58bbf16c9ff1e1`: the accepted #93
segment ran 38 commits ahead of it, #94's own authored segment 10 — genuinely `diverged`, 10 ahead / 38
behind. Ordinary non-rebase merge at `449696ba9271cab97c76c0cda261b0e8d25db363`; `--is-ancestor` succeeds
for the accepted #93 head and the prior #94 head `4bdc0daf8ebea00e03280d150e7e38305abed549` alike.

#### The worker lifecycle: two conflicts, and a third place that conflicted with nothing

Both conflicts were measured in advance from the #93 gate with `git merge-tree`, and reported before this
directive existed. The directive's step 3 states the required outcome — seven loop entries, seven close
calls, prose saying "seven" — and that is what the merge produced, but only the first two were conflicts.

**`apps/worker/src/main.ts`** conflicted on the `loops` array alone: #94 had added `"retention"` to a list
that did not yet contain `"follow_ups"`, and the accepted #93 head had `"follow_ups"` in a reformatted
multi-line list. Resolved as the union, seven entries, with #93's explanatory comment widened to cover both
unconditional sweepers.

**The close block conflicted with nothing, and that is where the defect was.** Git merged both additions
cleanly, so the shutdown list correctly gained `retention.close()` alongside `followUpSweeper.close()` —
seven calls — while the comment above it still read **"six independent closes"**. #94's own diff had bumped
that word from "five" to "six" because its base lacked the follow-up sweeper, and the accepted side also
said "six", so git had no reason to stop. Nothing typechecks a number in a comment and no test reads one.
Corrected to "seven", and the three counts are now checked against each other rather than asserted: seven
`close()` calls, seven loop entries, the word "seven".

**`apps/worker/src/main.test.ts`** conflicted on the whole-list assertion, resolved to the seven-entry list
in the order `main.ts` reports them.

**And its sibling case needed a change that was not a conflict either.** The case that boots without the
credential key asserts `not.toContain("instagram_tokens")` and then `toContain("follow_ups")`, with a
comment calling that "the unconditional loop" — singular, and true when `follow_ups` was the only one.
`retention` is unconditional too, so it is now asserted there as well: a loop checked only in the
fully-configured case above is a loop this case would not notice losing.

#### Step 4 — deletion and export reachability, re-measured and resolved

Re-measured on the merged head, with bare re-exports and migration comments excluded as the directive
requires. **`requestDeletion`, `requestProfileDeletion`, `executeDeletion`, `listDeletionRequests` and
`exportContact` have no real caller.** The single remaining hit is `executeDeletion` named in a migration
comment. The branch's own retention sweeper calls only `deleteExpiredConnectStates`, and no file under
`apps/web` references any of the five.

**Reconciled against the live issue, the intended scope is store-only**, and the evidence is on the record
rather than inferred:

- **Issue #57 is titled "Implement security/privacy, export, retention and deletion *foundations*".**
- Its *Required behavior* enumerates capabilities, authorization rules and durable workflow states —
  `REQUESTED -> PROCESSING -> COMPLETED | PARTIAL_FAILURE` — and never a screen, a route or an operator
  action in a UI.
- Its *Tests* section lists cross-BP authorization attacks, member revocation, export permission, redaction,
  the deletion workflow, partial external-system failure and memory/search cleanup. No interface test.
- Its *Acceptance criteria* are that "MVP deletion/export **flows** are durable and auditable; unauthorized
  data is non-discoverable; derived data is not left available for future AI/search after successful
  deletion" — every one of which the store layer and its suites satisfy.
- Two of the four specs Issue #57 names, `MVP_RELEASE_SCOPE.md` and `TEAM_ROLES_UX.md`, **do not exist
  anywhere under `docs/`** — and those are precisely the documents that would define an operator surface and
  the role UX for one.
- `PRIVACY_RETENTION_DELETION.md` describes *who may* perform these actions ("Admin or owner only"), which
  is the authorization model the store enforces, and it demonstrably knows how to record a missing surface
  when it means one: it says of a different flag that "there is no notification surface in this product …
  The flag belongs with the first surface that would honour it." It says nothing of the kind about deletion
  or export.

So the capability is complete and correct at the layer this task owns, and nothing about that is left
ambiguous. What was ambiguous — and is the reason this section exists — is **who owns the surface**.

#### The owning follow-up task, named rather than implied

**It is not P7-01.** Issue #59 builds a *platform operator* console and states the separation itself: "Keep
internal SUPPORT / BILLING / OPERATIONS / PLATFORM_ADMIN permissions separate from customer OWNER / ADMIN /
AGENT roles." Deletion and export are **customer** admin-or-owner actions per the privacy spec, so putting
them in the platform console would violate that issue's own role boundary. Its MVP surface list does not
include them, and neither the P7-01 nor the P7-02 branch references any of the five functions.

The customer-facing UI line is Phase 5, which runs P5-01 through P5-10 and is complete without a privacy
screen. **So no existing task owns this, and the next free customer-facing designation is P5-11.**

**Proposed task — P5-11, "Customer-facing privacy surface: deletion requests and contact export".** Scope:
an OWNER/ADMIN-only screen under workspace settings that creates a deletion request at one of the four
specified scopes, lists requests with their durable state, and exports a contact's data; every action
tenant-scoped through the existing authorization context and written to the customer audit; no new store
capability, because all four functions and `exportContact` already exist, are tested, and are exported.
Acceptance: an AGENT cannot reach it, a deletion request appears with its scope and state, a `PARTIAL_FAILURE`
is shown as terminal rather than retryable, and an export is audited and carries no secret.

**Creating the GitHub issue is the owner's action, not mine** — this entry is the record the directive asks
for, and the designation should be confirmed when that issue is opened.

#### A missing authorization check on a cross-profile write, found and fixed in this cycle

Checking that the merge preserved the tenancy invariants step 2 names, rather than assuming a clean merge
had, turned up something this propagation did not introduce and should not have carried forward silently.

#94 adds `requireWorkspaceWideWrite` to `tenancy.ts`, and its doc comment states the rule exactly: a write
every Business Profile reads needs an admin or owner **and** `ALL` scope, because "somebody granted two
profiles out of five has not been given the authority to change what the other three read." **It is called
from nowhere**, and is not re-exported from the package index.

Tracing where that rule is actually applied found three workspace-scoped writes and one of them
unprotected:

| write | role checked | `ALL` scope checked |
|---|---|---|
| `createKnowledge` with `scope: "WORKSPACE"` | yes | no — delegated in a comment to "the caller that holds a Workspace context" |
| `createStyleExample` with `scope: "WORKSPACE"` | yes | no — same delegation |
| **`saveStyleProfile` with `scopeLevel: "WORKSPACE"`** | **no** | no |

`saveStyleProfile` writes the base voice every Business Profile inherits. It authorized only that the caller
may act on *that* profile and then wrote the row with `businessProfileId = null`, with no role check at all —
so **a member granted a single profile, including an `AGENT`, could rewrite the voice every profile replies
in**, from that profile's Style page. No test covered it. This is not the deliberate delegation its siblings
document: they enforce the role half and delegate only the scope half, and
`PRIVACY_RETENTION_DELETION.md` assigns "writing a Workspace-scoped knowledge source or style example" to an
admin or owner.

**Fixed here, mirroring the sibling twenty lines below it** — the same
`requireRole(context, WORKSPACE_ADMIN_ROLES, …)` for the `WORKSPACE` case. Judged to be inside step 5's
carve-out rather than new scope, because Issue #57's first required behaviour is that "authorization is
Workspace + role + BP-scope + action specific", and a workspace-wide write with no role check does not meet
it. Three cases pin it: an `AGENT` is refused, the **same agent still writes their own profile's layer**
(the control — the guard is about the workspace layer, not about agents), and an `ADMIN` is allowed.
Removing the guard fails the agent case alone.

**Not fixed, and proposed instead:** the `ALL`-scope half. Wiring `requireWorkspaceWideWrite` means the three
web actions obtaining a `WorkspaceContext` — `requireWorkspaceContext` already exists for that — and it
reaches into a layer this propagation never touched, so it is a scope call rather than mine. The gap it
leaves open: `addWorkspaceMember`'s own comment confirms "an ADMIN with SELECTED scope" is a supported
state, and such an admin can today create a Workspace-scoped knowledge source or style example that
profiles they were never granted will read. Recommended as the first item of whatever cycle follows, or as
an amendment to this one on a word.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7, `--maxWorkers=2` throughout, focused
packages run separately with their own labels, `db:generate` before typecheck. Per the directive, any
unexplained skip is treated as a failure — with the service variables present, nothing skipped.

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 585 source files, 0 cycles |
| `@omnichannel/domain` | **138 passed** (6 files) |
| `@omnichannel/application` | **294 passed** (14 files) |
| `@omnichannel/channel-whatsapp` | **166 passed** (9 files) |
| `apps/worker` lifecycle `main.test.ts` | **10 passed** (1 file) |
| `pnpm test:db` | **836 passed** (41 files), 0 failures, 0 skips |
| `pnpm test:redis` | **55 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1103 passed** (96 files), no skips |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1844 passed, 1073 skipped |

**Disclosed.** No retries, no reruns, no flakes, nothing skipped to make a gate pass. The new
`startRetentionSweeper` has no dedicated test file — its startup is covered through the worker lifecycle
case that now asserts the `retention` loop — which matches `backlog-guard` and `reconciliation-sweeper`
while the follow-up, outbox and Instagram-token sweepers each have one.

### Superseded — the accepted #92, propagated into #93 and nowhere else

**PR #92 / P4-06 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-17T17:21:42Z, commit `fddf0a2f0154135fce7c3d62cbc91c67e0651fe0`, carrying
`ANTIGRAVITY_REVIEW: PASS head=fddf0a2f0154135fce7c3d62cbc91c67e0651fe0` (review `5559051465`).

**Routing unchanged.** **#93 / P4-07 is now the sole gate; #94 onwards are frozen.**

**The ancestry.** Both segments fork from `ce7fe8f536709872b25f4d155a6fbf388c4adb4c`: the accepted #92
segment ran 36 commits ahead of it, #93's own authored segment 8 — genuinely `diverged`, 8 ahead / 36
behind. Ordinary non-rebase merge at `1c36c19501c4bed44a849f02e07b4fe639667a1c`; `--is-ancestor` succeeds
for the accepted #92 head and the prior #93 head `e439f39ab2a402707978f5c9cd58bbf16c9ff1e1` alike.

#### One conflict, and both sides were excluding the same budget for different reasons

`apps/worker/src/draft-disposition.ts`, the computation of `remainingMs` — how much of the provider's
automated-response budget is left. Each segment had added its own reason the budget does **not** apply, and
each reason had already cost this product a working feature once:

- **#93:** the budget is Instagram's and only Instagram's. WhatsApp publishes no such deadline, so measuring
  one against a WhatsApp send would shorten or abandon the human-like delay for a rule that platform does
  not impose.
- **The accepted #92 segment:** the budget must not apply to a planned follow-up. Its anchor is the
  customer's last message, and a follow-up exists precisely because they stopped writing, so the budget is
  always already spent. Applying it anyway sent **every** follow-up to `DEADLINE_MISSED` — its own docstring
  says the feature "could be wired up correctly end to end and still never send anything".

Keeping either side alone reintroduces a defect that was already found and accepted as fixed: #93's version
alone sends every Instagram follow-up back to `DEADLINE_MISSED`, and #92's version alone subjects WhatsApp
to an Instagram-only deadline while the comment directly above it — which merged cleanly — says the
opposite. The union is therefore all three conditions: a budget is computed only when there is a
`lastInboundAt`, **and** the channel is Instagram, **and** the draft is not a follow-up. The docstring
carries both reasons and records that each has already cost a feature.

The comment above `timing` was trimmed rather than left to restate the first reason, because two statements
of one rule drift apart — the same hazard `defaultAutomationSettings` and `profileDefaultPolicyWrite` are
written to avoid.

**Both halves are pinned, which took two passes to establish.** Dropping the follow-up exclusion fails two
cases. Dropping the channel exclusion appeared to fail **nothing** — and that conclusion was wrong, because
the run that produced it had #93's own slice suite not executing (below). With that suite running, dropping
the channel exclusion fails `schedules through the shared disposition, with a delay the delay engine chose`.
A mutation result is only as good as the suite that ran.

#### The branch's flagship suite was not running, and reported as skipped

`apps/worker/src/whatsapp-slice.integration.test.ts` — thirteen end-to-end cases, the whole point of P4-07 —
failed in `beforeAll` on `automation_policies_profile_default_key`, because the fixture hand-wrote a profile
default that `createBusinessProfile` has written since the accepted P3-02 head. Vitest then reports the
file's cases as **skipped**, so a batched run reads `1090 passed | 13 skipped` and looks green; only a
single-file run prints the `FAIL`. Fixed the same way as the identical fallout on #91: edit the existing
default instead of creating a second one. 13/13 now pass.

**The rule this leaves:** in an infrastructure run with `TEST_DATABASE_URL` and `TEST_REDIS_URL` set, a
non-zero skip count is a failure until explained — the suites are gated on exactly those variables, so
nothing should skip.

#### Step 3's other named re-checks

- **Positional handler signatures** — `createHandlers` unchanged at six parameters; #93 adds no queue
  family, so the arity fallout that hit two earlier links did not recur, and typecheck confirms the
  follow-up slice test still matches.
- **Worker lifecycle wiring** — the `loops` list is unchanged.
- **Outbound ownership correlation and takeover/follow-up cancellation** — the accepted #92 behaviour is
  intact: the echo reaches `process-event.ts`'s `case "OUTBOUND_ECHO"`, and `ingestion-store.ts` sets
  `takeover_reason = 'UNMATCHED_OUTBOUND_ECHO'` only when the state is not already `HUMAN_ACTIVE`.
- **Canonical phone comparison and self-message refusal** — #92's refusal with `sameNumber` survives the
  merge untouched; the WhatsApp suite's 30 normalization cases still pass.
- **No migration** — #93 adds none, and drift is clean.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7, `--maxWorkers=2` throughout, focused
packages run separately with their own labels, `db:generate` before typecheck.

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 578 source files, 0 cycles |
| `@omnichannel/domain` | **138 passed** (6 files) |
| `@omnichannel/application` | **294 passed** (14 files) |
| `@omnichannel/channel-whatsapp` | **166 passed** (9 files) |
| `pnpm test:db` | **804 passed** (39 files), 0 failures, 0 skips |
| `pnpm test:redis` | **55 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1103 passed** (96 files), **no skips** |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1844 passed, 1041 skipped |

**Disclosed.** The slice suite failed on the first run of this head and is reported as fixed, not as green
first time. No other retries or flakes, and nothing skipped to make a gate pass. With the services present
nothing skips; the 1041 skips in the no-infrastructure run are the DB and Redis suites declining to start,
which is what CI relies on.

### Superseded — the accepted #91, propagated into #92 and nowhere else

**PR #91 / P4-05 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-17T15:19:11Z, commit `550100cae7d6f18f78a341543ec2feb194f1797e`, carrying
`ANTIGRAVITY_REVIEW: PASS head=550100cae7d6f18f78a341543ec2feb194f1797e` (review `5558442119`).

**Routing unchanged.** **#92 / P4-06 is now the sole gate; #93 onwards are frozen.**

**The ancestry.** Both segments fork from `f0d89c6e3b9cc5a8a5d413d1bf2d5a00b37b22b0`: the accepted #91
segment ran 34 commits ahead of it, #92's own authored segment 7 — genuinely `diverged`, 7 ahead / 34
behind. Ordinary non-rebase merge at `7fe737e0855457aa6f3f6f125c0bdd005a51ed88`; `--is-ancestor` succeeds
for the accepted #91 head and the prior #92 head `ce7fe8f536709872b25f4d155a6fbf388c4adb4c` alike.

#### The collision this link was measured for, and why the union is stronger than either side

Three conflicts, all of them predicted: `git merge-tree` was run against #92 from the #91 head before any
directive existed, and it named `normalize.ts`, its test, and the research note. The code one is the
substantive link in the whole chain so far, because **both segments had independently reached the same
conclusion and each had only half of the answer**.

#92 replaced the old "classify a `messages` entry from our own number as an echo" branch with a **refusal**
— `whatsapp.message_from_self`, return `undefined` — and its comment gives both reasons: the branch was not
where Meta publishes native sends, so it never fired on a real one, and when it failed to fire *because the
two fields are formatted differently*, the business's own message became an inbound message from a
"customer" who is the business, starting a reply cycle answering ourselves. #92 also added the real
mechanism: `HANDLED_FIELDS = {"messages", "smb_message_echoes"}` and `normalizeEcho` over
`value.message_echoes[]`.

#91 had fixed the comparison — canonical, digits-only `sameNumber`, refusing to call two spellings with no
digits equal — but was still classifying.

**So #92 had the right semantics with the comparison that caused the problem it describes, and #91 had the
right comparison with the wrong semantics.** The resolution keeps #92's refusal, its comment and its
warning, and calls `sameNumber` in the condition, with one paragraph added saying why the comparison must
be canonical: a refusal keyed on raw equality misses in exactly the cases the spellings differ, which would
leave the phantom-inbound behaviour its own comment describes still reachable.

**Mutation-proven, and the proof is the interesting part.** `envelope` puts the digits-only spelling in
`metadata.display_phone_number` (#91's fixture split) while `BUSINESS_DISPLAY_NUMBER` is the punctuated
Graph spelling, so **#92's own refusal case now compares two different spellings of one number**. On #92's
branch both sides were the same constant and that case could not fail. After the merge:

- restoring raw `===` fails **#92's own case**, `refuses a \`messages\` entry that claims to come from the
  business itself` — it passes only because the comparison is canonical;
- deleting the empty-digits guard fails `does not treat two spellings that carry no digits as the same
  number` — that guard now prevents a *false refusal* rather than a false classification.

The test file keeps #92's suite verbatim — it tests the real mechanism and is correct — and adds a focused
block for what that suite cannot cover: the plain spelling refused, and the two ways a canonical comparison
could refuse something it must not (an absent display number, two spellings with no digits). #91's
`OUTBOUND_ECHO` assertions were not kept, because the behaviour they asserted no longer exists; their
*value* is kept, re-aimed at refusal.

**A stale comment corrected rather than carried.** `sameNumber`'s docstring still described the pre-merge
world — "echo detection", "belt-and-braces", and `smb_message_echoes` as something "a later task in this
chain consumes". The branch refuses now and `normalizeEcho` is in this file, so the comment was rewritten to
match. A doc comment that disagrees with its code is the same defect class this chain hit at #89.

#### The disclosed coverage gap, folded forward

The #91 verdict judged the missing `decodeProposal` presence cases "a coverage gap rather than an
implementation bug … can be addressed during future polish without destabilizing the current verified
HEAD". This is that next head, so the four cases are here: presence survives the round trip, an
unrecognised mode is dropped, and a lead that is negative or past `MAX_PRESENCE_TYPING_LEAD_MS` is dropped.

They have power, checked both ways: removing presence from `decodeProposal` fails the carry case alone, and
carrying it unvalidated fails all three validation cases. The first case states in its own comment why it
exists — the file's `toEqual(PROPOSAL)` round-trip assertion cannot show a field the fixture omits, which
is the one-fixture-on-both-sides shape that made the old echo case worthless.

#### Step 3's named re-checks

- **Phone-number normalization** — the union above.
- **Positional handler signatures** — `createHandlers` is unchanged at six parameters; #92 adds no queue
  family, so the arity fallout that hit the two previous links did not recur, and typecheck confirms the
  follow-up slice test still matches.
- **Worker lifecycle wiring** — the `loops` list is unchanged; coexistence is ingestion and normalization,
  not a sweep.
- **Native-echo cancellation and takeover ownership** — the echo reaches `process-event.ts`'s
  `case "OUTBOUND_ECHO"`, and `ingestion-store.ts:339` sets `takeover_reason = 'UNMATCHED_OUTBOUND_ECHO'`
  **only when the state is not already `HUMAN_ACTIVE`**, so an existing human takeover is preserved rather
  than overwritten. Authorship is correlated, never attributed, which is what the adapter's own comments
  promise.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7, `--maxWorkers=2` throughout, focused
packages run separately with their own labels, and `db:generate` before typecheck — the lesson from the
previous link, where a no-op install left a stale client that looked like a source defect.

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 576 source files, 0 cycles |
| `@omnichannel/domain` | **138 passed** (6 files) |
| `@omnichannel/application` | **294 passed** (14 files) |
| `@omnichannel/channel-whatsapp` | **166 passed** (9 files) |
| `pnpm test:db` | **804 passed** (39 files), 0 failures, 0 skips |
| `pnpm test:redis` | **55 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1090 passed** (95 files) |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1844 passed, 1028 skipped |

**Disclosed.** No retries, no reruns, no flakes, nothing skipped to make a gate pass.

### Superseded — the accepted #90, propagated into #91 and nowhere else

**PR #90 / P4-04 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-17T13:00:07Z, commit `07ce360c09999e83a6a882fdd79152df535865b6`, carrying
`ANTIGRAVITY_REVIEW: PASS head=07ce360c09999e83a6a882fdd79152df535865b6` (review `5557862173`).

**Routing unchanged.** **#91 / P4-05 is now the sole gate; #92 onwards are frozen.**

**The ancestry.** Both segments fork from `b3fe33e775c32f5654066a11edc04e7df1ab41d8`: the accepted #90
segment ran 31 commits ahead of it, #91's own authored segment 8 — genuinely `diverged`, 8 ahead / 31
behind. Ordinary non-rebase merge at `6b0613952cc01c85afc5dff7b61a579a25c371b7`; `--is-ancestor` succeeds
for the accepted #90 head and the prior #91 head `f0d89c6e3b9cc5a8a5d413d1bf2d5a00b37b22b0` alike.

#### Three conflicts, resolved as unions

**`packages/db/src/policy-store.ts` — four hunks, all the same shape.** #91 adds `presenceMode` and
`presenceTypingLeadMs`; the accepted segment adds `version`. Both sides appended at the same point in four
parallel structures: the `PolicyView` interface, the `policySelect`, the row type and the row mapping. All
three fields kept in all four places, presence grouped with the other channel-policy fields and `version`
with `updatedAt` as metadata.

**`apps/web/src/server/settings-actions.ts` — overlapping edits, not appends.** Four things had to survive
together, and two of them were only visible by reading the merged body: the accepted segment's `.trim()` on
`takeoverPauseHours` (a fix, not a style change), its `customSeconds`/`custom` pair — **already referenced
by the merged body between the two hunks**, so dropping it would not compile — its `expectedVersion` in the
proposal, and #91's two presence reads with their seconds-to-milliseconds conversion. All four kept.

**`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`** — a dated section from each side, both kept. The
file now holds six re-verification sections in chronological order, through P4-05 of 2026-10-05 and the
propagation re-verification of 2026-10-16.

#### Five pieces of fallout that produced no conflict at all

This link's real work was here, not in the conflicts. The directive asked specifically to re-check
positional handler signatures and lifecycle wiring, and that was the right place to look.

1. **A stale Prisma client, which looked like a source defect.** `apps/worker/src/draft-disposition.ts`
   failed typecheck claiming a policy row lacked `presenceMode`/`presenceTypingLeadMs` — but the row comes
   from an unselected `findMany`, so the columns are the schema's. The install had been a no-op
   (`Lockfile is up to date`, 19 ms), so `prisma generate` never ran and the generated client still
   described #90's schema. `db:generate` cleared the error with no source change. **The lesson is to
   regenerate before believing a merge produced a type error in working code.**
2. **`defaultAutomationSettings()` became incomplete.** `AutomationPolicySettings` is
   `Omit<AutomationPolicy, …>`, #91 widened `AutomationPolicy` with the two presence fields, and the
   accepted segment's default literal therefore no longer satisfied its own type. Filled from #91's own
   defaults — `"OFF"` and `DEFAULT_PRESENCE_TYPING_LEAD_MS` — which is not a guess: `domain.test.ts`
   asserts `defaultAutomationSettings()` **`toEqual`** the settings `createAutomationPolicy` produces, an
   exhaustive comparison that would fail on any other value. It passes.
3. **`createHandlers` arity, for the second consecutive link.** #91 inserted `announcePresence` as the
   **fifth** of six parameters, again ahead of `reconcile`, and the follow-up slice test — which the
   previous link had just corrected to five arguments — needed a sixth. Fixed, and the comment now states
   the whole order and says why types cannot check it: the rejecters take no arguments, so they satisfy
   every slot and the suite passes whichever order they are in. The order was read from `handlers.ts` and
   matched against the production call in `main.ts`.
4. **The settings page referred to a variable the accepted segment had replaced.** #91's presence inputs
   read `policy.presenceMode`; the accepted segment had refactored the page's defaults into a single `form`
   object built from `edited ?? stored`. Presence now comes from `form`, sourced from `stored` — see the
   disclosure below for why not from `edited`.
5. **A fixture hand-wrote a profile default that now already exists.**
   `apps/worker/src/presence-handler.integration.test.ts` created an `automationPolicy` with no channel
   account, which collides with the row `createBusinessProfile` has written since the accepted P3-02 head:
   `Unique constraint failed on … automation_policies_profile_default_key`, failing the whole suite and
   skipping its 15 tests. Changed to edit the existing default rather than invent a second one. The other
   four `automationPolicy.create` sites in the suites were checked and do not collide.

#### The sixth breakage: a disclosure that turned out to be a defect

Written up first as a design note — "presence is absent from the rejected-proposal round trip, which
discards nothing because #91 predates that mechanism" — and then checked against the save path before being
published. The claim was wrong, and the thing under it is a defect **this merge created**.

`saveSettingsAction` does not hand the form to the store. It builds a `PolicyProposal`, and `editFrom`
maps that to the store's `PolicyEdit` **field by field** — with no presence in the mapping. So the form
posted `presenceMode` and `presenceTypingLeadSeconds`, `proposalFrom` read both, `editFrom` rebuilt the
edit without them, and `savePolicy` never saw them: **#91's presence setting could not be saved from the
settings page.** On #91's own head there is no proposal indirection — the edit was built directly, presence
included — so routing #91's reads through the accepted segment's mapper is what broke it. That is the
"do not discard either segment" case exactly.

Nothing caught it. Typecheck cannot: presence enters through conditional spreads, which do not trigger
excess-property checking, so the proposal carried fields its own type never declared. And no test asserted
that presence reaches the store.

Proven before fixed, in that order: a new case asserting the mode and the lead arrive at `savePolicy`
failed on the merged head, passes with the fix, and fails again — alone — when the fix is removed. A second
case is the control: a form carrying neither value must send neither key, so an unrelated save cannot reset
a business's presence to `OFF`.

The fix completes the union inside the accepted segment's architecture: `PolicyProposal` declares both
fields, because the proposal is the one thing that travels between a refusal and a sealed confirmation;
`decodeProposal` re-validates both on the way in like every other field, since the parameter is
user-editable; `editFrom` carries them through; and the page's `form` prefers `edited ?? stored` for them,
consistent with every sibling field.

#### Disclosed, not fixed

- ~~Presence does not survive the rejected-proposal round trip, and that discards nothing.~~
  **Withdrawn — this was wrong, and what it was hiding is the sixth breakage, recorded above.** Tracing the
  save path before publishing the claim showed that `editFrom` dropped presence before `savePolicy`, so
  #91's setting could not be saved at all. Fixed, with a test that fails without the fix.
- **The two presence inputs carry no `disabled={!mayEdit}`** while every sibling input does. Checked
  against #91's own head: they did not have it there either, so the merge lost nothing. The server still
  refuses an AGENT, so this is a UI inconsistency rather than a permission hole.
- **`presenceSettingsOf`'s fallbacks are unreachable from its only caller.** It coerces a non-`PresenceMode`
  string to `"OFF"` and a non-finite or negative lead to the default, but `presence_mode` is a Prisma enum
  column and `presence_typing_lead_ms` is `Int NOT NULL`, and the one production caller passes a full row
  after checking it is not `undefined`. No test exercises the fallbacks. Not a defect — defensive code on
  an exported structural signature — but worth knowing it is unpinned.
- **`profileDefaultPolicyWrite()` does not map the presence columns.** Its own comment states the intent
  that "the columns are set from the domain's answer", and the domain's answer now includes presence. The
  written row is identical today because the schema defaults are the same two values, so nothing is wrong
  at runtime; the drift the comment warns about would only appear if the domain default changed later.
  Left alone because extending the accepted segment's reviewed writer is not what this directive asked for.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7, `--maxWorkers=2` throughout, each
focused package run separately with its own label.

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 571 source files, 0 cycles |
| `@omnichannel/domain` | **138 passed** (6 files) |
| `@omnichannel/application` | **294 passed** (14 files) |
| `@omnichannel/channel-whatsapp` | **152 passed** (8 files) |
| `pnpm test:db` | **793 passed** (38 files), 0 failures, 0 skips |
| `pnpm test:redis` | **55 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1086 passed** (95 files), 0 skips |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1826 passed, 1017 skipped |

**Disclosed.** The presence-handler suite failed on the first full run and is reported as fixed, not as
green first time: one failed file and 15 skipped tests on
`automation_policies_profile_default_key`, reproduced alone, fixed at the fixture, re-run to 95 files with no skips. No other retries or flakes. `db:migrate:deploy` reported "No pending migrations
to apply" — correct but not evidence, since `20261005160000_presence_timing` was applied to this local
database on 2026-10-05 (read from `_prisma_migrations`); the suites build a fresh database per run anyway.

### Superseded — the accepted #89, propagated into #90 and nowhere else

**PR #89 / P4-03 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-17T10:54:39Z, commit `cdba474caead94c87bdc5038500e8b32274a1507`, carrying
`ANTIGRAVITY_REVIEW: PASS head=cdba474caead94c87bdc5038500e8b32274a1507` (review `5557475655`).

**Routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#90 / P4-04 is now the sole gate;
#91 onwards are frozen.**

**The ancestry.** Both segments fork from `f257f0a6f73e55f98d5395abce46d9f72e0bb190`: the accepted #89
segment ran 29 commits ahead of it, #90's own authored segment 11, so #90 against accepted #89 was
genuinely `diverged` — 11 ahead / 29 behind. Ordinary non-rebase merge at
`3c2f00665ddb16426bfcfdf0b1170b775bad8988`; `--is-ancestor` now succeeds for the accepted #89 head and for
the prior #90 head `b3fe33e775c32f5654066a11edc04e7df1ab41d8` alike.

#### Three conflicts, and the one that was not a conflict at all

**`packages/db/src/ingestion-store.ts` — two different imports on one line.** #90 added
`createPendingTranscripts` from `./transcript-store`; the accepted #89 segment added
`cancelPendingFollowUps` from `./followup-store`. Both symbols are used in the merged body —
`cancelPendingFollowUps` twice, `createPendingTranscripts` once — so the union is not a judgement call but
a requirement: dropping either import deletes a feature and breaks the build. Both kept, in the file's
alphabetical order.

**`packages/db/src/ingestion.integration.test.ts` — two whole suites appended at one place.** #90's
`describe("a customer's voice note")` with eight cases, and #89's `describe("a webhook calls off a chase")`
with three. They test unrelated things, so both are kept. The splice needed care: the two sides shared a
single `/**` opener above the marker, so each side's prose continued the *same* comment. The resolution
gives the second suite its own opener rather than letting #89's paragraphs run on under #90's heading.

**`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md` — a dated section from each side.** Both kept. The
file now carries five re-verification sections in chronological order: P4-01, P4-02 and P4-03 of
2026-10-04, P4-04 of 2026-10-04/05, and the propagation re-verification of 2026-10-16.

#### The fallout that produced no conflict at all, and that only `tsc` could catch

`apps/worker/src/followup-slice.integration.test.ts` came in from the accepted #89 segment and called
`createHandlers` with four arguments. **#90 had inserted a fifth parameter — `transcribeMedia` — as the
fourth, ahead of `reconcile`.** Git merged both sides cleanly because neither had touched the other's lines.
The result: the test's `"no reconciliation is processed in this slice"` rejecter was landing in the
*transcription* slot, and `reconcile` had no argument at all.

Resolved as the union by passing both rejecters in the signature's order, with a comment saying why the
fourth exists. Two things are worth recording about how this was found:

- **Vitest could not have caught it.** All four non-draft handlers in that slice are rejecters, so a
  mis-ordered resolution still passes — the test only proves no other job runs, not which slot each
  rejecter occupies. Only the whole-repository `pnpm typecheck` saw the arity.
- It is the exact shape the chain keeps producing: a parameter added in the middle of a positional
  signature, merged against a caller that predates it, with no textual overlap to flag it.

#### The semantic union, checked rather than assumed

- **#89 intact:** `policy/template-route.ts`, `selectTemplate` still named in the resolved `evaluate.ts`
  comment, `cancelPendingFollowUps` still called from the ingestion path, and the chase suite present.
- **#90 intact:** `db/transcript-store.ts`, `createPendingTranscripts` still called from the ingestion
  path, the voice-note suite present, and `transcribeMedia` still wired in `apps/worker/src/main.ts`.
- **#88 intact:** `sameNumber` still defined and called at the coexistence echo branch.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7, every suite bounded to `--maxWorkers=2`.
Each focused package was run **separately with its own label**, after a labelling error on the previous link
that came from reading a multi-filter run's blocks in the order the filters were typed rather than in
pnpm's dependency order; that error was corrected publicly on #89.

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 561 source files, 0 cycles |
| `@omnichannel/application` | **271 passed** (13 files) |
| `@omnichannel/domain` | **138 passed** (6 files) |
| `@omnichannel/channel-whatsapp` | **152 passed** (8 files) |
| `apps/worker` follow-up slice (the adapted test) | **7 passed** (1 file) |
| `pnpm test:db` | **793 passed** (38 files), 0 failures, 0 skips |
| `pnpm test:redis` | **55 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1055 passed** (93 files) |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1801 passed, 988 skipped |

**Disclosed.** No retries, no reruns, no flakes, nothing skipped to make a gate pass. In the batched run the
drift line came back blank because the summary captured an empty trailing line; it was re-run on its own and
printed `No difference detected.` A blank line was not counted as a pass.

### Superseded — the accepted #88, propagated into #89 and nowhere else

**PR #88 / P4-02 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-16T16:53:26Z, commit `98c2b2696f670ccc82a32252a91fa0460d2dfffa`, carrying
`ANTIGRAVITY_REVIEW: PASS head=98c2b2696f670ccc82a32252a91fa0460d2dfffa` (review `5550962495`). The verdict
audited the echo canonicalization explicitly and recorded zero blocking defects.

**Routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#89 / P4-03 is now the sole gate;
#90 onwards are frozen.**

**The ancestry.** Both segments forked from `960f7174abaa732a183624defcc5c1104af262da`: the accepted #88
segment ran 27 commits ahead of it, #89's own authored segment 9, so #89 against accepted #88 was genuinely
`diverged` — 9 ahead / 27 behind. Joined by an **ordinary non-rebase merge** at
`3752ae2b11cfa8dc6b53365385e2e80845e23026`; `git merge-base --is-ancestor` now succeeds for the accepted
#88 head and the prior #89 head `f257f0a6f73e55f98d5395abce46d9f72e0bb190` alike.

#### Two conflicts, both resolved as the union, and one of them mattered

**`packages/application/src/policy/evaluate.ts` — a doc comment, about the one thing worth getting right.**
Both segments had rewritten the same block above `evaluateTemplateGate`, and they disagreed on *where the
allowlist is read*: #89's prose listed "Unattended sending needs the allowlist" among four conditions, while
#88's said the allowlist is **not** read here and arrives as two settled booleans computed where the
catalogue is. A comment is not a tiebreak you settle by preference, so it was settled against the code: the
gate reads `input.templateRoute.approvedTemplateAvailable` and `input.templateRoute.automatable` and touches
no catalogue — so #88's claim is the factual one. The resolution keeps **both**: #89's four operator-facing
conditions, #88's `undefined`-versus-empty-refusal-list distinction, and a final paragraph naming
`selectTemplate` as where the two booleans are decided. That last sentence is *more* true after the merge
than before it, because `selectTemplate` is #89's own new `policy/template-route.ts`.

**`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md` — both segments appended a dated section.** Kept
both, in chronological order: #89's "Re-verification for P4-03 / Issue #20 — templates and the window,
2026-10-04", then #88's "Re-verification 2026-10-16". Neither was discarded and neither was merged into the
other; a missing blank line before the second heading was added so the heading renders.

#### The semantic union, checked rather than assumed

- **#88's echo normalization is intact**: `sameNumber` is defined and still called at the echo branch, and
  `BUSINESS_WA_ID` / `BUSINESS_DISPLAY_NUMBER` remain separate constants across fixture and test.
- **#89's template work is intact**: `policy/template-route.ts` and its tests, `channel-whatsapp/templates.ts`,
  `db/whatsapp-template-store.ts`, `domain/message-template.ts`, the `reason-codes` additions, and the
  `20261004210000_whatsapp_template_shape` migration with both of its CHECKs.
- **The boundary the #87 review demanded still holds.** That review required that transport-owned template
  checks not claim the then-unbuilt #20 catalogue. #89 builds that catalogue, so the boundary was re-checked
  rather than presumed: `checkSendable` refuses only *shape* — a missing template name or language, an empty
  parameter — and never approval status, freshness or the allowlist. Eligibility lives in `selectTemplate`.
  No duplicated check, no contradiction.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7, every suite bounded to `--maxWorkers=2`:

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 545 source files, 0 cycles |
| `@omnichannel/application` | **138 passed** (6 files) |
| `@omnichannel/channel-whatsapp` | **123 passed** (7 files) |
| `@omnichannel/domain` | **266 passed** (13 files) |
| `pnpm test:db` | **753 passed** (37 files), 0 failures, 0 skips |
| `pnpm test:redis` | **53 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1010 passed** (89 files) |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1733 passed, 913 skipped |

**Disclosed.** No retries, no reruns, no flakes, nothing skipped to make a gate pass. `db:migrate:deploy`
reported "No pending migrations to apply" — correct but **not evidence**, because this long-lived local
database already had `20261004210000_whatsapp_template_shape` applied on 2026-10-05 from earlier work on
this branch, and `db:check-drift` compares the migrations directory to `schema.prisma` rather than consulting
the live database. The migration is demonstrated instead by the integration suites, which build a fresh
database per run and passed 753 tests. Local runs are macOS; the authoritative Linux evidence is the
exact-head GitHub Actions run.

### Superseded — the accepted #87, propagated into #88 and nowhere else

**PR #87 / P4-01 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-15T06:25:13Z, commit `c13d32dea988daf38a6a4a6b03a612553c26c72b`, carrying
`ANTIGRAVITY_REVIEW: PASS head=c13d32dea988daf38a6a4a6b03a612553c26c72b`
(review `5529023598`).

**Routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#88 / P4-02 is now the sole
gate; #89 onwards are frozen** — no broader Phase 4 propagation and no unrelated work until #88 has its
own exact-head PASS.

**The ancestry repair.** #88 named `feat/p4-01-whatsapp-adapter` as its base while its live merge base was
the pre-acceptance #87 head `48fd78a93d626ea56b2ada97c24a25ccd2595e14` — GitHub compared them as
`diverged`, 9 ahead / 25 behind. Joined by an **ordinary non-rebase merge** at
`6bac028d3c658ca4e2ea01fbaf4f74fa1acdb8cb`; `git merge-base --is-ancestor` of the accepted #87 head now
succeeds, and the prior #88 head `960f7174abaa732a183624defcc5c1104af262da` remains an ancestor too.

**Zero conflicts, and the union widening did not bite.** 77 files, 7,976 insertions against 311 deletions,
no conflict markers. The zero says little by itself: #88 widens a channel-account status union, which is
the shape that breaks exhaustive consumers *without* producing a conflict. Checked rather than assumed —
`pnpm install --frozen-lockfile` first because the branch moves the lockfile, then `pnpm typecheck` clean
across all 14 packages and `pnpm lint` + `lint:boundaries` clean at 535 package source files with no
dependency cycles.

#### The one authored change: coexistence echo detection compares numbers, not spellings

Carried under the directive's step 3, which scoped the post-review #87 risk this author disclosed on that
PR. Nothing else about P4-02 is touched.

`normalize.ts` recognised a coexistence echo with `message.from === value.metadata?.display_phone_number`.
Those are two different Meta surfaces: `from` is a `wa_id` (digits only) while `display_phone_number` is
the *display* field, which the Graph `/phone_numbers` edge spells `+1 631-555-5555` — a spelling this
product already stores at onboarding and already carries in its own fixtures as `"+1 555 0100"`. Meta's
webhook metadata happens to use the digits-only spelling, so **nothing was broken in production**; the
defect was that a missed match does not fall through to "ignored" but to `INBOUND_MESSAGE` with the
business's own number as sender — a phantom contact the draft path would answer.

- `sameNumber(left, right)` compares a canonical digits-only value and **refuses a match when either side
  reduces to no digits**, so missing or non-numeric metadata can never read as an echo.
- The old test was powerless: `from` and `metadata.display_phone_number` were drawn from the **same
  fixture constant**, so one value sat on both sides of the comparison. The fixture now declares
  `BUSINESS_WA_ID` (digits only, what `from` carries) and `BUSINESS_DISPLAY_NUMBER` (`+1 555-000-0001`,
  what the Graph edge returns) as **separate constants with different values**, and `envelope()` takes a
  `displayPhoneNumber` override so each case states both wire values independently.
- Five cases now cover it: the plain webhook spelling, the punctuated Graph spelling, a genuine non-match
  (a real customer), an absent display number, and two spellings carrying no digits.
- **Mutation-tested, each clause killed by exactly one case.** Restoring raw `===` fails only the
  punctuated-spelling case; deleting the empty-digits guard fails only the no-digits case; making
  `sameNumber` always return true fails the controls broadly. A guard no test kills is a guard that is not
  doing anything.
- Identity and idempotency were checked, not assumed: tenancy keys off `phone_number_id`, dedupe off
  `wamid`, and **no unique index includes `display_phone_number`**.

**Author-disclosed defect in this same change, found and fixed before pushing.** The first placement of the
new helper inserted it between `belongsToThisAsset`'s doc comment and its function, orphaning that comment
above the new one. Typecheck, lint and 102 passing tests all stayed green, because none of them read doc
comments. Helper moved below `belongsToThisAsset`; both comments now document the function beneath them.

**Meta re-verification 2026-10-15 / 2026-10-16** is recorded in full in
`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`, dated and sourced per the directive's step 4. The
short form: Embedded Signup **v4 remains latest** with expiry TBD and `onboarding.ts` already targets v4
only; the v2 deprecation date **passed with Meta's pages still in the future tense and no changelog entry
confirming the cutover**, so enforcement is announced-and-reached rather than observed; `v26.0` is still
the current Graph version and **no v27.0 exists**; the 30-second code TTL, the six-digit PIN, the
Allowed-Domains-**and**-Valid-OAuth-Redirect-URIs conjunction, and the 24-hour window with `131047` are all
confirmed unchanged.

Four documented risks were checked against this code and found **absent** — which is why this pass changed
no behaviour beyond the echo repair:

1. `sessionInfoVersion: 4` is **not** corroborated by Meta for v4; this repository sends no
   `sessionInfoVersion` at all.
2. `subscribed_apps` documents **no** per-field parameter; this repository sends no `subscribed_fields`.
3. `code_verification_status` and `quality_rating` carry **contradictory enumerations across sibling Meta
   pages**; both are typed as plain `string` end to end here, with one case-insensitive comparison, so no
   union or CHECK can fail on a value Meta itself documents elsewhere.
4. From Graph **v24.0** onward the `statuses` webhook drops the `conversation` object; this adapter reads
   neither `conversation` nor `pricing` from a status.

One finding that is **not** a defect but changes how the echo branch should be read: Meta documents a
coexistence business's app-sent and companion-device messages under a webhook field of their own,
`smb_message_echoes` → `value.message_echoes[]`, where **arrival under that field is itself the authorship
signal**. At this head the adapter skips every non-`messages` field with an `whatsapp.unhandled_field`
record, so a real echo is logged and dropped here and consuming that field belongs to the later
coexistence task in this chain. The repaired comparison is therefore the belt-and-braces path, and the
repair still earns its place because `message_echoes[].from` is documented as the business *display* phone
number — the same spelling trap, inherited by whatever consumes echoes next. The code comment now says so.

**Exact-head evidence**, real PostgreSQL 17 + pgvector and Redis 7 in Docker, every suite bounded to
`--maxWorkers=2`:

| Gate | Result |
|---|---|
| `db:check-drift` | `No difference detected.` |
| `pnpm typecheck` | exit 0, 14 packages |
| `pnpm lint` + `lint:boundaries` | exit 0; 13 packages, 535 source files, 0 cycles |
| `@omnichannel/channel-whatsapp` | **102 passed** (6 files) |
| `pnpm test:db` | **743 passed** (36 files), 0 failures, 0 skips |
| `pnpm test:redis` | **53 passed** (3 files) |
| `pnpm test:e2e` (worker + web) | **1002 passed** (88 files) |
| `pnpm evals` | **20/20**, 0 quality regressions |
| `pnpm build` | exit 0 |
| `pnpm verify` with **no** infrastructure (the CI path) | exit 0; 1661 passed, 903 skipped |

**Disclosed limitations.** The 903 skipped tests in the no-infrastructure run are the DB/Redis suites
declining to run without `TEST_DATABASE_URL` / `TEST_REDIS_URL`, which is the behaviour CI relies on; they
are the same suites reported green above with infrastructure present. No retries or reruns were needed, no
flakes were observed, and no test was skipped to make a gate pass. Local runs are macOS; the authoritative
Linux evidence is the exact-head GitHub Actions run and the reviewer's own container.

### Superseded — the accepted #86, propagated into #87 and nowhere else

**PR #86 is accepted.** Gemini/Antigravity formal GitHub review, `APPROVED`, 2026-10-14T18:50:34Z,
commit `3f6a7e48cda96417332c2f11e0918329e865b6de`, carrying
`ANTIGRAVITY_REVIEW: PASS head=3f6a7e48cda96417332c2f11e0918329e865b6de`.

**Routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#87 / P4-01 is the sole gate;
#88 onwards are frozen** — no broader Phase 4 propagation and no unrelated work until #87 has its own
exact-head PASS.

**The ancestry repair.** #87 named #86 as its base while its live base SHA was the pre-acceptance #86
head `67846521f682693d27b4fe5438b4898cb0821994`, also the merge base — GitHub compared them as 9 ahead /
24 behind. Ordinary non-rebase merge; `--is-ancestor` of the accepted head now succeeds.

**Zero conflicts and zero fixes.** #87 is additive — a new `packages/channel-whatsapp`, 2,560 insertions
against 7 deletions — and new files do not conflict, so the zero says little by itself. What was checked
instead: `pnpm lint:boundaries` (a fresh package is how a forbidden edge arrives), `pnpm install
--frozen-lockfile` first because the branch moves the lockfile, and the P4-01 contract item by item.

**The P4-01 invariants, verified in the merged code rather than inferred from a green run:** raw-body
HMAC-SHA256 with `timingSafeEqual` and a length pre-check, failing closed on an empty app secret and
refusing to normalize an unverified webhook; `display_phone_number` used **only** to recognise a
coexistence echo (ADR-013) and never as identity or idempotency — that is `sourceEventId(kind, …parts)`,
with a deterministic SHA-256 digest when the key would overflow; send outcomes confined to
`ACCEPTED | REJECTED | AMBIGUOUS`; and the accepted #86 invariants intact (dead suspension resolver still
deleted, guarded kill-switch path authoritative, `proactive`/`dispatchDeadline` present, both loops
starting, reporting and closing with the shutdown prose still saying six).

**Meta re-verification, 2026-10-15.** `v26.0` remains current — released 2026-07-29, expiration TBD, and
**no v27.0 exists** — so `DEFAULT_GRAPH_VERSION` is unchanged from the 2026-10-04 note. The signature
contract is confirmed as `X-Hub-Signature-256` with a `sha256=` prefix, keyed by the app secret. Meta's
own guidance notes that the signature is computed over the **escaped-unicode** payload rather than
decoded bytes, which breaks implementations that parse and re-serialize; this adapter is unaffected
because `readBody` passes `new Uint8Array(await request.arrayBuffer())` and the *same* bytes are both
hashed and parsed.

**Reported, not fixed:** `packages/channel-whatsapp/src/config.ts:103` illustrates the endpoint as
`…/v23.0/<phone_number_id>/messages` while the constant is `v26.0`. It is a doc comment only — the URL is
built from `config.graphVersion` — and it predates this merge, so correcting it would be the unrelated
cleanup these directives forbid.

### Superseded — the accepted #85, propagated into #86 and nowhere else

**PR #85 / FIX-ISSUE-9 is accepted.** Gemini/Antigravity formal GitHub review, state `APPROVED`,
2026-10-14T17:25:58Z, commit `5f56302f8101b1512f9d46a4263643b36f3bbce6`, carrying
`ANTIGRAVITY_REVIEW: PASS head=5f56302f8101b1512f9d46a4263643b36f3bbce6`.

**Reviewer routing unchanged:** Gemini/Antigravity primary, Astra advisory-only. **#86 /
FIX-DEAD-SUSPENSION-RESOLVER is the sole gate; #87 onwards are frozen.**

**The ancestry repair.** #86 named #85 as its base while its live base SHA was the pre-acceptance #85 head
`36314e2068e8fb3a7bc2cbdb4ba79e1bc014ac55`, also the merge base — GitHub compared them as 11 ahead / 23
behind. Joined by an ordinary non-rebase merge; `--is-ancestor` of the accepted head now succeeds.

**Zero conflicts, and zero fixes — the first costless link of the propagation.** That is the finding
rather than the absence of one: #86 changes exactly one file, `apps/worker/src/delivery-policy.ts`
(−42/+11, deleting the dead suspension resolver), and the accepted chain had modified **that same file**
to add the `proactive` handling. Git reporting no conflict means the edits did not overlap textually,
which is precisely the shape where a clean merge can still be wrong **in either direction** — the deletion
undone or the addition orphaned.

**Four behaviours verified individually rather than inferred from a green exit code**, as the directive
required:

- `createSuspensionResolver` and its wiring are **still deleted** — zero occurrences repository-wide.
- The guarded kill-switch path in `delivery-store.ts` remains authoritative: `activeSuspension` is read
  there and `suspensionLockKeysFor` still supplies the keys that protect the claim race.
- `proactive` and the `dispatchDeadline` branch it guards are **intact** in `delivery-policy.ts`.
- Both worker loops still start, report and close: the token refresh conditional on its runner's
  `running` state, `follow_ups` unconditional, both `.close()` calls present, and the shutdown prose still
  says six.

### Superseded — the accepted #84, propagated into #85 and nowhere else

**PR #84 / P5-09 is accepted.** Gemini/Antigravity published a formal exact-head GitHub review on
2026-10-14T13:27:18Z — state `APPROVED`, commit `ca86e7d7877b8ab2deb1fb280956d2306224e898`, carrying
`ANTIGRAVITY_REVIEW: PASS head=ca86e7d7877b8ab2deb1fb280956d2306224e898`.

**Reviewer routing unchanged:** Gemini/Antigravity temporary **primary**, Astra **advisory-only**. Claude
remains the sole author; the readiness marker keeps its legacy spelling for parser compatibility.

**#85 / FIX-ISSUE-9 is the sole propagation and review gate; #86 onwards are frozen** — no broader Phase 4
propagation, no Stage E, no unrelated feature work until #85 has its own exact-head PASS.

**The ancestry repair.** #85 named #84 as its base while its live base SHA was the pre-acceptance #84 head
`82f9f3fbe6cbc67966f8ba4d1a34569cff544501`, which was also the merge base — GitHub compared them as
12 ahead / 22 behind. Joined by an **ordinary non-rebase merge**;
`git merge-base --is-ancestor ca86e7d… HEAD` succeeds.

**One conflict, and it is the one worth describing: `apps/worker/src/main.ts`.** Both sides of it are a
fix for the same class of defect — *a loop nobody starts*. This branch adds the Instagram token refresh
(FIX #9, "every part of the token lifecycle is implemented and none of it runs"); the accepted parent adds
the follow-up sweeper (#55, "`dueFollowUps` and `claimFollowUp` had no caller at all"). Keeping either
side alone would silently re-create the defect the other was written to fix.

**It took five edits, and the two conflict markers showed two of them:**

1. both `const` declarations, token refresh then sweeper, in start order;
2. both `.close()` calls;
3. **the startup `loops` report** — merged cleanly and would have stopped naming the sweeper. `follow_ups`
   is added **unconditionally** and `instagram_tokens` stays conditional on the refresh runner's own
   `running` state: that difference is information, not an inconsistency, because the sweeper always
   starts and the refresh only runs where it is configured;
4. **the shutdown commentary's own count** — both sides read "five independent closes" above five entries;
   there are now six, and the sentence merged without a conflict and became wrong;
5. **`main.test.ts`'s expected loop list**, which a probe could not predict and the real run found: the
   case named "says which background loops are running, so a loop wired to nothing is visible (#9)"
   asserts the whole list, so it now names `follow_ups` too. Its sibling case — the one that proves the
   token refresh drops out without a credential key — now also asserts `follow_ups` is still present,
   which is what pins the unconditional half of the distinction above.

Items 3 and 4 fail no typecheck, lint or test. Item 5 is why the directive's instruction to inspect the
merged code rather than trust a probe was right.

### Superseded — the accepted #83, propagated into #84 and nowhere else

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

**#82 was the current gate on 2026-10-13, and #83 and everything below was frozen** and still carried
the pre-repair #79 *at that date*. Both facts have since changed — see the Correction at the top. #104 and #105 sit off the chain, based on #103, and are unaffected — their heads moved with the
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

**#82 was the current gate when this was written, and #83 and everything below was frozen**, still
carrying the pre-repair #79 *at that date*. See the Correction at the top.
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
#81 PASSED at `d9a34ffef120b7f0b171eb12f130d3848c9928cf` (Antigravity — a head that has since moved);
**#82 was the current gate at that date**, carrying that accepted parent and awaiting independent review,
and #83 and everything below was frozen and **not ready for review**, because they still contained the
pre-repair #79 *then*. See the Correction at the top.

**The concurrency barrier is state-based, not timed.** The regression proving `savePolicy`'s row lock waited
on `setTimeout(250)` and was intermittently wrong under the full suite; it now waits until a backend is
observably blocked on the holding transaction's own id. The review request issued against `ef8b0d4f…` is
superseded by this test-only head, and #79 remains the current gate.

**The #79 repairs are propagated exactly one step.** They exist on
`feat/p5-04-ai-settings-simulation` and on `feat/p5-07-leads-pipeline`, and nowhere else: the directive on
#80 permitted one branch, so at that date #81 and below still carried the pre-repair #79 and each needed
this merged down in turn once #80 passed. That propagation is now complete — see the Correction at the
top.

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
### Task definition — P6-01 / Issue #38, plan and entitlement primitives

**Branch `feat/p6-01-plan-entitlements`**, based on `feat/p3-04-privacy-deletion`. The first of Phase 6.

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

### Task definition — P3-04 / Issue #57, privacy, retention and deletion

**Branch `feat/p3-04-privacy-deletion`**, based on `feat/p4-07-whatsapp-slice`.

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

### Task definition — P4-07 / Issue #24, the WhatsApp vertical slice

**Branch `feat/p4-07-whatsapp-slice`**, based on `feat/p4-06-whatsapp-coexistence`.

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

### Task definition — P4-06 / Issue #23, coexistence and native-human takeover

**Branch `feat/p4-06-whatsapp-coexistence`**, based on `feat/p4-05-whatsapp-presence`.

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

### Task definition — P4-05 / Issue #22, read and typing presence timing

**Branch `feat/p4-05-whatsapp-presence`**, based on `feat/p4-04-whatsapp-media`. The timing half of
presence: the transport call already existed from P4-01, and what was missing was deciding *when* to make
it, and when to stay silent.

Meta's presence rules were re-verified from the live documentation on 2026-10-05
(`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`). One finding shaped the product rather than merely
being recorded: **the typing indicator cannot be sent without `status: "read"`** — both are required fields
of the one documented payload, and no typing-only request exists. So the setting is one three-valued mode
rather than two booleans, because two booleans would offer a combination no channel can perform.

**Presence never touches a reply.** It is scheduled after the delivery is persisted and enqueued, it fits
inside the delay the delay engine chose, a failure to enqueue it is swallowed, and the job allows exactly
one attempt — an announcement is worthless once the message has arrived.

**It re-decides with the coordinator's own judgement**, not a copy of it: `policyInputFor` is now shared,
and presence announces only on the same `SCHEDULE` answer that would let the reply go out.

**Two findings:**

- **A forged `workspaceId` loaded a real delivery.** `operation_id` is globally unique, so a lookup by it
  alone answers for whichever tenant owns it. The presence store now takes the workspace and refuses a
  mismatch. Mutation-checked.
- **Presence must not promise a reply this deployment cannot send.** WhatsApp still has no
  `DeliverySendPort` (that is P4-07), so `deliverableChannels(env)` comes from the same configuration that
  builds the sender and gates the scheduling.

Also fixed: the incident reporter never mapped the `media-transcription` queue to a component (left
unmapped by #21), and `DELAY_ENGINE.md`'s job table was missing that family.

### Task definition — P4-04 / Issue #21, media and voice-note transcription

**Branch `feat/p4-04-whatsapp-media`**, based on `feat/p4-03-whatsapp-templates`. Fetching a customer's
recording safely, reading it through an application-owned port, and keeping the reading apart from the
recording with provenance of its own.

Meta's media rules and OpenAI's transcription API were both re-verified from the live documentation on
2026-10-04/05 (`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`). The owner chose `gpt-transcribe` —
`whisper-1` is deprecated and removed from the API on 2027-02-26 — and chose **no transcoding**, so the
recording is sent as it arrived and the provider's own answer settles whether it can read an OGG/Opus
container.

**No confidence is invented.** There is no whole-response confidence in that API at all, so the adapter
asks for none, the port's field is optional, and a CHECK refuses a stored number that does not say where it
came from. A failed reading never carries words, which the database also enforces.

**Two defects the acceptance tests found**, both the same class as the P5-05 cycle — correct pieces with a
gap between them:

- **The reading was never dispatched inline.** `processEvent` returned only the debounce entry's id, so a
  voice note's reading waited for the 5-second sweeper while the draft job went out immediately. The draft
  that needed the words usually lost the race and held the reply for a person on a reading that had
  worked. `EventProcessingResult` now carries every entry the event wrote; the ingestion summary's two
  counters are renamed `outboxDispatched`/`outboxDeferred`, because the outbox now carries two kinds of
  work and a counter that meant only the debounce would report a voice note's dispatch as a deferral.
- **A disconnected number's media was still fetched.** The send path and the window calculation both
  refuse on `connectionState`; the media calls never read it. A stored token outlives the authorization it
  was granted under, so a business that removed the integration kept having its customers' recordings
  downloaded. All three media calls now refuse with `ACCOUNT_NOT_CONNECTED` before the token is decrypted.

**Also repaired:** `packages/channel-whatsapp` did not typecheck at the previous head — `media.test.ts`
passed an unresolved config where a resolved one was required, and `vitest` transpiles without
typechecking, so the suite was green while `pnpm -r typecheck` was not. Resolving the config the way
production does is what made the `connectionState` gap visible.

### Task definition — P4-03 / Issue #20, template catalogue and outside-window policy

**Branch `feat/p4-03-whatsapp-templates`**, based on `feat/p4-02-whatsapp-embedded-signup`. ADR-016's three
outside-window modes, the template catalogue they decide from, and the eligibility rules in between.

Meta's template and window rules were re-verified from the live documentation on 2026-10-04. One finding
fixed a defect rather than confirming anything: **`parameter_format` is `positional` or `named` and the two
do not serialize the same way** — a named template's values each need a `parameter_name` — so P4-01's
payload builder could not send a named template at all.

**Deliberately not in this task:** dispatching an outside-window template. The draft engine proposes no
template today, so the composing/delivery/record path would be unreachable code; the eligibility,
validation and policy pieces it needs are in place and tested. See the note in `WHATSAPP_ADAPTER.md`.

### Task definition — P4-02 / Issue #19, WhatsApp Embedded Signup

**Branch `feat/p4-02-whatsapp-embedded-signup`**, based on `feat/p4-01-whatsapp-adapter`. Multi-tenant
WhatsApp onboarding through Meta's official Embedded Signup, and the account lifecycle around it.

Meta's current process, scopes and deadlines were re-verified from the live documentation on 2026-10-04.
Two findings shaped the implementation rather than merely being recorded: **Embedded Signup v2 and v3 are
deprecated on 2026-10-15**, so this targets v4 only; and **`waba_id` now denotes the messaging-account ID**
as Meta splits the WhatsApp Business Account into a WhatsApp Account and a Messaging Account, which
vindicates keeping it a field of its own rather than deriving it.

What landed: the provider calls in `packages/channel-whatsapp/src/onboarding.ts`, a
`WhatsAppOnboardingStore` and two tables in `packages/db`, the state/CSRF-bound OWNER/ADMIN flow in
`apps/web/src/server/whatsapp-onboarding.ts`, three endpoints, and `DEGRADED` as a channel-account status
the onboarding spec requires.

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

### Task definition — Stage E, P4-01 / Issue #18, the WhatsApp Cloud API transport adapter

Started at the owner's word, with Stage D's chain still in review. `packages/channel-whatsapp` now
implements the shared `ChannelAdapter`: raw-body verification, deterministic normalization of text, media,
voice notes, replies, interactive replies and statuses, the four window states, free-form text and
approved-template sending, and the read/typing presence effect. 65 tests, fixture-driven.

Branched from the chain tip (`fix/dead-suspension-resolver`), so it carries every Stage D repair.

Meta's live docs were re-checked rather than trusted from the baseline, as Issue #18 requires: the current
Graph API version is v26.0, and the typing indicator's 25-second lifetime is why presence belongs near the
send rather than at scheduling time.

Next in Stage E: #19 Embedded Signup and account lifecycle, then #20 templates and outside-window policy.

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

### Task definition — Issue #9, the Instagram token lifecycle had no caller

Found while auditing the repository's open work after Stage D, and reported on Issue #9 before being
fixed, because the PR that owns the defect is accepted.

`refreshInstagramCredential` was correct, tested eight ways, and called by nothing — no route, no action,
no loop. The lifecycle the issue asked for was therefore implemented and unreachable: a 60-day token
expired with `channel_accounts.status` still `CONNECTED`, every reply failed with Meta's code 190, and no
part of the product said to reconnect.

Branched from the Stage D tip rather than from #64, which owns the defect and is PASSED — a commit there
would have moved the head that twenty-one accepted PRs stand on. The policy now lives in the worker beside
the other recovery loops, the send path marks a credential Meta refused, and `worker.started` lists the
loops that are actually running so a loop wired to nothing is visible as an absence rather than as silence.

### Task definition — P5-09 / Issue #35

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
