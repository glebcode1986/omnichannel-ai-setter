# Analytics metric definitions

**Status:** Implemented by P5-08 (Issue #34).

**Related:** `LEADS_ANALYTICS_UX.md`, `PHASE5_IMPLEMENTATION_PLAN.md`, ADR-012 (ambiguous sends).

The issue requires that "metric definitions must be documented and consistent". This is that document, and
it is the definition of record: `packages/db/src/analytics-store.ts` is the only implementation of any
metric here. A metric with two implementations has two values, and the day somebody notices is the day they
stop trusting the whole page.

## The distinction the whole document exists to protect

**What we decided is ours to state. What happened to the message is the provider's.**

| Ours | Theirs |
| --- | --- |
| scheduled, held for review, cancelled, **handed to the provider** | **delivered**, read, failed at the provider |
| `delivery_jobs.status` | `messages.delivery_status`, `delivered_at`, `read_at` |

`handedToProvider` means we called Meta's API and it accepted the request. `reportedDelivered` means Meta
told us the message reached the person. These are different claims with different evidence, and only the
second may ever be shown to a customer as "delivered".

`deliveryOutcomes` therefore returns two separate groups that are never summed, and the UI renders them as
two panels with two captions. Outbound messages the provider has not spoken about are counted as
**`awaitingReport`** — the honest name for them. The tempting alternative, counting them as delivered
because our send succeeded, is precisely the inference this separation exists to prevent.

## Time

**A day is not a fact without a timezone.** Every windowed metric takes an IANA zone and there is no
default in the store. The UI defaults to `UTC`, states which zone it used on every render, and lets the
reader change it.

The workspace's `quiet_hours_time_zone` is deliberately **not** reused. It says when we may message
customers; this says how to bucket a report. Borrowing one for the other is the same class of mistake as
coupling the dashboard locale to the customer's reply language (`LOCALIZATION.md`), and it would be
invisible until somebody compared two screens.

**`from` is inclusive, `to` is exclusive.** The only pair of conventions that lets adjacent ranges tile
without counting the boundary twice. A range preset covers whole *local* days: "last 7 days" is seven of
the reader's own days ending with today, not 168 hours ending at an arbitrary moment.

Days are bucketed with two conversions — `(occurred_at AT TIME ZONE 'UTC') AT TIME ZONE <zone>` — because
the column is `timestamp without time zone` holding UTC. A single conversion *interprets* the stored value
as local time and moves it away from UTC, wrong by exactly the offset.

## No denominator means no number

Where a metric has nothing to measure it reports **`null`**, never zero, and the UI renders "not measured"
with an explanation.

"0s median" for a week nobody wrote in would be the best-looking number on the page and a complete
fiction. A 0% missing-fact share reads as "our knowledge is complete" rather than "we did not ask".

## The metrics

### Inbound volume — `inboundVolume`
One row per local day. **Messages** counts inbound rows; **conversations** counts the distinct threads they
arrived in. Both, because ten messages from one person and one message from ten people are the same number
and not the same day.

### First-response time — `firstResponseTimes`
Median and 90th percentile of the gap between **the first inbound message of a reply cycle** and the next
outbound message in the same conversation.

- *First of a cycle* means an inbound with no earlier unanswered inbound: the conversation's first message,
  or one that follows an outbound. A customer who sends three messages in a row is waiting **once**, and
  counting each would flatter the median every time somebody types the way people actually type.
- A wait still unanswered at the end of the window **contributes nothing**. Its wait is not over, and
  treating "not yet answered" as a fast reply is the one direction this metric must never be wrong in.
- A wait that **began before the window** belongs to the window it began in. Otherwise one slow reply is
  reported twice, once in each adjacent range, or vanishes from both depending on which end is measured.

### Draft outcomes — `draftOutcomes`
Counted by the draft's own status and its delivery's authority, at the draft's creation time.

| Field | Meaning |
| --- | --- |
| `generated` | drafts the model produced |
| `autoSent` | sent with `AUTOMATED` authority — nobody read it first |
| `humanApprovedSent` | sent with `HUMAN_APPROVED` authority |
| `awaitingReview` | `PENDING` or `HELD` **and** `needs_review` |
| `heldAmbiguous` | outcome unknown (ADR-012) |
| `dismissed` / `superseded` / `failed` | rejected by a person / replaced by newer inbound / failed |

A draft that was approved and then failed at the provider counts as `humanApprovedSent` **and** appears in
the provider's failure count. Folding it into "failed" alone would make the review work invisible.

### Review reasons — `reviewReasons`
One row per reason code, counting **distinct drafts** carrying it.

A draft with three reasons is counted under all three, so **these do not sum to the draft count**. The
question this answers is "what is holding replies up", and attributing a draft to one of its reasons would
understate the other two. The UI says so on screen rather than leaving somebody to add the column up.

### Missing knowledge — `missingFactFrequency`
Drafts whose reasons include `MISSING_FACT`, and that count as a share of `generated`. `null` when nothing
was generated.

### Human takeover — `takeoverRate`
`takenOver / conversationsWithInbound`, where the denominator is conversations that **received an inbound
message in the window**. Measured against all conversations instead, the rate would fall every quiet week
and look like an improvement.

### Delivery outcomes — `deliveryOutcomes`
See the first section. `ambiguous.open` and `ambiguous.resolved` count `delivery_reconciliations` rows: "we
do not know" is its own answer, and folding it into either certainty would be a claim nobody can support.

### Lead movement — `leadMovement`
Counted from `lead_stage_transitions`, not from the conversation's current stage. A lead that reached
`QUALIFIED` and then went to `LOST` **was still qualified** in the window; reading only the current stage
would erase that and make a bad month look like an empty one.

`qualificationRate` is conversations that reached `QUALIFIED` over conversations that reached `ENGAGED`,
and `null` when nothing engaged.

### AI usage — `modelUsage`
Generations, input/output/cache tokens and median latency, per provider and model.

**Cost is deliberately not computed.** Prices change, differ per contract and are not in this database, so
a currency figure would be a guess rendered to two decimal places — the most convincing possible way to be
wrong. The issue asks for "usage/cost telemetry when available"; usage is what is available, and the page
says so where a cost column would otherwise be.

## Scope

Every metric takes a `WorkspaceContext` and is filtered to the Business Profiles that context may see,
which for a `SELECTED` grant is narrower than the workspace. A requested `businessProfileId` is
**intersected** with the grant rather than trusted: the id arrives from a query string, and a member who
edits it gets nothing rather than somebody else's numbers.

Filters — channel account, mode, lead stage, assignee — combine. Each narrows; none replaces another.

## The audit log

A separate, **append-only** record of material actions: `audit_events`, one table with a `kind` column
rather than nine tables, because the spec asks for a log that can be *searched* and nine tables cannot be
searched together without a union that grows every time somebody adds a tenth.

`policy_change_audits` is unchanged and still holds the typed before/after of a policy edit. An audit event
for a policy change **points at that row by id** rather than copying it: one truth, one pointer.

**Append-only is a trigger**, not a convention. `BEFORE UPDATE` and `BEFORE DELETE` raise. A CHECK cannot
see that a row already existed and application code cannot bind a `psql` session or a future migration.
Corrections are appended as new rows.

**Sensitivity is derived from the kind**, not passed by the caller. `MEMBER_CHANGED`,
`CHANNEL_CONNECTED` and `CHANNEL_DISCONNECTED` are always `sensitive`, which a CHECK enforces. A caller
that could choose would eventually file a role change as ordinary work, the CHECK would reject the insert,
and the actual change would go down with it.

**Admin-only means absent, not redacted.** An Agent's search is a narrower query, not a filtered result: a
row shown as `***` at 14:02 still discloses that somebody's access changed at 14:02, and fetching then
dropping the rows would return four for a page of ten, telling the reader exactly how many were hidden. The
result carries `restricted` so the UI can say that others see more.

### Kinds

| Kind | Written by |
| --- | --- |
| `TAKEOVER_STARTED` / `TAKEOVER_ENDED` | `conversation-operations-store` |
| `DRAFT_APPROVED` / `DRAFT_EDITED` / `DRAFT_REJECTED` | `review-store` |
| `REPLY_COMPOSED` | `composer-store` |
| `POLICY_CHANGED` / `MODE_CHANGED` / `TEMPLATE_POLICY_CHANGED` | `policy-store` |
| `KNOWLEDGE_VERSIONED` | `knowledge-store` |
| `STYLE_VERSIONED` | `style-store` |
| `MEMBER_CHANGED` | `repositories/workspaces` |
| `CHANNEL_CONNECTED` | `repositories/channel-accounts` |
| `CHANNEL_DISCONNECTED` | `onboarding-store` |
| `AMBIGUOUS_SEND_RESOLVED` | **nothing yet** — see below |

Approved and edited are separate kinds because they answer different questions. "Did anybody change what
the model wrote" is what somebody asks when a reply turns out to have been wrong, and folding both into
`DRAFT_APPROVED` makes it unanswerable.

A mode change writes **two** events — its own and the settings one — rather than one row with a more
important-sounding name. They are different facts: "what did somebody change" and "when did this profile
start replying unattended", and somebody searching for the second should not have to know it was buried in
a settings save.

Every write happens **inside the transaction that makes the change**. A write outside it would still pass a
"was it recorded" check while leaving the two able to disagree after a crash — a mode change nobody appears
to have made, or a record of one that never happened.

`AMBIGUOUS_SEND_RESOLVED` has no writer. `LEADS_ANALYTICS_UX.md` asks for ambiguous-send **manual**
resolution, and there is no manual resolution path in the product yet; the worker's automatic
reconciliation is not somebody's action and recording it as one would put a name against something nobody
did. The enum value exists so the log can record it the day that path is built.

### Where it lives

Under **Settings**, at `/settings/audit`, because `PRODUCT_UX.md` already places "security/audit" there and
the seven navigation sections it names are product structure. An eighth top-level section would be a
decision about the product rather than about this task.
