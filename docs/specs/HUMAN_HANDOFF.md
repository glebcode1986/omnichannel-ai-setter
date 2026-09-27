# Human Handoff & Takeover Specification — v0.2

## Principle

Human activity always wins over automation.

## Separate concepts

Do not overload `AiMode` with handoff state. Mode controls account/conversation automation policy (OFF/DRAFT/AUTOPILOT); takeover state controls who currently owns the conversation.

Suggested takeover states:

- `NONE` — AI policy may operate;
- `REVIEW_REQUIRED` — AI draft/action waits for a human decision;
- `HUMAN_ACTIVE` — human has taken ownership; automated sending paused.

Persist reason, actor when known, timestamps and optional `paused_until`.

## Takeover triggers

- human sends from our unified inbox;
- platform outbound echo cannot be correlated to an app-originated operation/platform message ID;
- human explicitly claims/pauses a conversation;
- mandatory-review escalation may set `REVIEW_REQUIRED`;
- `HUMAN_ASSISTED_EXTENDED` Instagram after-window mode sets `REVIEW_REQUIRED` with Human Agent eligibility metadata; it does not pretend a human has already sent anything.

## Own-echo rule

A correlated echo from our API send must not trigger takeover. Correlation uses provider/platform message IDs and operation records, never message-text equality alone.

## Resume

Support explicit resume. Optional timed auto-resume may occur only when configured and only if there has been no newer human activity, no pending review and the channel remains eligible. A new manual outbound extends/restarts takeover.

## Human approvals/edits

- approve unchanged normal-window draft: send through the same delivery coordinator/atomic send path;
- edit then send: persist final human-edited text, mark source HUMAN, and optionally create a `HUMAN_EDITED_DRAFT` style example;
- for Instagram `HUMAN_ASSISTED_EXTENDED`, a deliberate human click/edit/send may use the Human Agent transport path if eligibility/approval still passes immediately before send;
- human text is not automatically added to factual knowledge.

### One decision, one write

Each decision a person makes — approve, edit-and-send, dismiss, claim — is **one transaction**: winning the
review item, the person's final wording, the authority they granted, the delivery, the draft's new status and
the conversation's ownership commit together or not at all. Claimed separately, a crash or a failed
dependency between the parts left a draft permanently `CLAIMED` with nothing done, and every retry was told
somebody had already resolved it.

A retry that finds the delivery already created is answered with the same operation rather than refused, so
reporting a decision and committing it cannot disagree.

Every decision also checks that the draft and the conversation named belong together, and fails closed on a
mismatch. The delivery path derives the recipient from the draft, so approving a draft from one conversation
while taking ownership of another would leave the authority and the reply describing two different actions.

Learning a style example from edited wording runs **after** the commit and is best effort in full: nothing it
can do — a slow store, a failed lookup — may stand between a person's click and the reply they asked for.

### The authority a decision grants

Approving or editing a draft **grants an authority**, and only a signed-in person can grant it. `SYSTEM` and
`NATIVE_APP` are actors in the takeover sense — a message sent from the Instagram app is a person acting —
but neither can look at a draft and decide it may go out, so an approval or edit from one is refused before
anything is claimed. The type carries a user id rather than an actor, and the table's CHECK constraint says
the same thing, so the invariant holds at the boundary as well as in the use case.

That authority is persisted with the delivery:
who approved it, when, and which send they authorized (an ordinary reply, or the provider's human-support
path). The send happens later and in another process, so an approval that lived only in the request that
granted it arrives there as automation — and then the very gates that exist to ask for a human hold the
reply a human already approved, while the human-support transport path cannot be reached at all.

The delivery coordinator reads that authority from the row, along with everything else it judges, and it is
re-asserted by the atomic claim. Nothing between the click and the adapter may construct an authority: a
queue job cannot acquire a human's approval it was never given, and cannot lose one that was.

**Scheduling the send and taking the conversation are one write.** Separately, a worker could pick the job
up after the delivery existed and before anyone owned the conversation, and judge a deliberate human action
as ordinary automation on the standard transport — the bypass ADR-014 forbids. Neither half is observable
without the other.

**What an approval answers, and what it cannot.** It answers the gates that exist to ask for a human: DRAFT
mode, a pending review claim, the approver's own ownership of the conversation, low confidence, a
mandatory-review category, an unreachable corpus, an unsupported citation, and quiet hours (which bound
automation, not the person). It answers nothing about what is possible or permitted: a newer inbound
message, `OFF` mode, AI disabled, an unhealthy account, content the channel cannot carry, and a closed
messaging window all still fail closed. A takeover by somebody **else** after the approval fails closed
too: they own the conversation now, and an approval from before that does not reach past them.

The human-support path is available only to an approval that named it, and only while eligibility still
passes at the claim. An approval of an ordinary reply is not agreement to a tagged send.

## Native-app activity

When Meta exposes outbound echoes, unmatched external/manual messages are treated as human takeover even if sent from the Instagram/WhatsApp native app rather than our dashboard.

## Review queue UX requirements

Expose why the AI held the conversation, relevant factual sources, draft, confidence/reason codes and clear actions: edit/send, send as written, dismiss, claim conversation, resume AI. For Human Agent reviews, additionally display standard-window expiry, extended eligibility expiry/status and a visible statement that the final send is a human action.
