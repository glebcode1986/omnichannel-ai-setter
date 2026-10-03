# ADR-018: Where a human-composed reply lives before it is sent

**Status:** **Accepted** by the product owner on 2026-09-30 (PR #76), Option B. Implemented in migration
`20260930230000_human_composed_delivery` on `feat/p5-03-review-conversation-ops`.

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

## Decision

**B**, accepted. The model's record keeps describing the model.

### The invariant, as implemented

A `delivery_jobs` row has **exactly one** content origin, enforced by CHECK rather than by convention:

- `(draft_id IS NOT NULL) <> (human_text IS NOT NULL)` — one origin, never none and never both;
- `(human_text IS NOT NULL) = (composed_by_user_id IS NOT NULL)` — a person's words name their author,
  and an AI draft has no author to name;
- `(human_text IS NOT NULL) = (conversation_id IS NOT NULL)` — a human-composed delivery names its
  conversation directly, because it has no draft to derive it from; an AI one does not duplicate the fact;
- `human_text IS NULL OR btrim(human_text) <> ''` — empty wording would ask the transport to send nothing;
- `human_text IS NULL OR authority = 'HUMAN_APPROVED'` — automation did not write these words, and the
  human-support transport path depends on the difference (ADR-014).

`ai_drafts` is unchanged and stays semantically model-only. No human-composed reply appears in
`readReliabilitySnapshot`, `countUnusableGenerations` or the evals, and there is a test asserting that
composing creates no draft row at all.

### What did not change

The delivery coordinator is still the only path to a customer. A human-composed delivery is claimed
atomically, revalidated immediately before the transport call, and subject to the same policy, window,
account-health, kill-switch and takeover gates as an automated one. It carries `selectedDelayMs = 0`
because a person has already decided, and its idempotency is the same decision digest `resolveApproval`
uses — a second submit of the same wording is answered with the send the first one made, and a different
message while one is still queued is refused rather than queued behind it.

### Rationale kept for the record

The model's record should keep describing the model. A delivery having two possible origins is a
fact about the product — automation and people both reply — and making that explicit in the schema is
cheaper to live with than a column called `confidence` that sometimes means nothing. It also keeps the
audit trail honest without a join: the delivery says on its face whether a machine or a person wrote what
went out.

If A is preferred anyway, the follow-up work is not optional: every aggregate over `ai_drafts` needs a
predicate excluding human-composed rows, and the evals need the same, or the first operator reply makes
those numbers wrong.

## Consequences accepted with this

- `delivery_jobs.draft_id` is nullable, so every reader of `job.draft` handles the other origin. The
  delivery store, the reconciliation store and the worker's resume path were each updated; none of them
  gained a branch that sends differently.
- The delivery queue payload's `draftId` is optional. `operationId` and `deliveryJobId` already identify
  the work, and a job carrying an invented draft id would have the worker reconcile against a row that
  does not exist.
- An outbound message produced by a human-composed delivery is recorded with `source = HUMAN` and the
  composer's user id. Recording a person's words as `AI` would make the thread's own source distinction a
  lie.
