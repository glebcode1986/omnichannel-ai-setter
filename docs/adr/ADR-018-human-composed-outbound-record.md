# ADR-018: Where a human-composed reply lives before it is sent

**Status:** Proposed by Claude on 2026-09-30 while implementing P5-03 (#29). Not decided. The composer is
the one required scope item of that task that is not built, because building it either way changes
something CLAUDE.md reserves for an ADR.

## Context

P5-03 requires "conversation composer using shared send/delivery path". The shared path is the delivery
coordinator: a `DeliveryJobRecord` is created, the worker claims it atomically, revalidates every gate
immediately before sending, and only then calls the transport. That is the only route to a customer, and
the contract's hard invariant is that the composer must not become a second one.

The obstacle is where the text lives. `DeliveryJobRecord.draft_id` is `NOT NULL` and the sender reads the
wording from `AiDraft.text`. So a delivery cannot currently exist without an `AiDraft` row.

When a person edits a pending draft and sends it, there is no problem: that is the existing `EDIT` action,
the row already exists, and the person's wording replaces the model's. The gap is a person replying when
there is **no** pending draft — mode `OFF`, a dismissed draft, or simply a conversation nobody asked the
assistant about. That is the ordinary case for an operator, not an edge case.

## The two ways to close it

**A. Write the human's message as an `AiDraft`.** No migration. But `ai_drafts` is the record of what a
*model* produced: `confidence`, `model_provider`, `model_name`, `prompt_version`, `schema_version` and
`model_suggests_send` are all `NOT NULL`, and a human reply has honest values for none of them. Whatever
is invented for those columns then flows into everything that reads the table —
`readReliabilitySnapshot`, `countUnusableGenerations` and the evals all count `ai_drafts` rows — so every
operator reply would shift metrics that exist to tell us how the model is behaving. It is the cheaper
option and the one that corrupts quietly.

**B. Let a delivery carry a human's wording directly.** Make `draft_id` nullable, add the text and a
source discriminator to the delivery record (or a small `outbound_messages` table the delivery points at),
and add a CHECK so exactly one of the two is present. Nothing in the model's record changes meaning; the
delivery record gains an honest second origin. The cost is a migration touching the delivery table, a
`NOT NULL` becoming nullable, and every reader of `job.draft` needing to handle the other case.

## Why this is not mine to decide

CLAUDE.md reserves "changing core entity semantics" for an ADR or a task update. Option A changes what a
row in `ai_drafts` means. Option B changes what a `DeliveryJobRecord` requires. There is no third option
that leaves both alone, and the difference is visible in production: A silently degrades the numbers the
reliability and evaluation work exists to produce.

## Recommendation

**B.** The model's record should keep describing the model. A delivery having two possible origins is a
fact about the product — automation and people both reply — and making that explicit in the schema is
cheaper to live with than a column called `confidence` that sometimes means nothing. It also keeps the
audit trail honest without a join: the delivery says on its face whether a machine or a person wrote what
went out.

If A is preferred anyway, the follow-up work is not optional: every aggregate over `ai_drafts` needs a
predicate excluding human-composed rows, and the evals need the same, or the first operator reply makes
those numbers wrong.

## What is built in the meantime

Everything else in P5-03: the Review queue with reason and provenance, approve / edit-and-send /
reject / take-over, takeover pause and resume, pending-send display and cancellation, the distinct
Instagram human-assisted and WhatsApp template-review states, and stale-action recovery. Editing a pending
draft and sending it works today, because that path needs no new record. Composing a reply where no draft
exists is the piece waiting on this decision.
