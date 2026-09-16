# Human Handoff & Takeover Specification — v0.3

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

## Native-app takeover during AUTOPILOT

AUTOPILOT may run continuously while the workspace owner has no dashboard/browser session open.

When the connected provider/capability exposes outbound echoes or equivalent evidence of a manual send from the native Instagram/WhatsApp business app:

- an outbound message correlated to our own delivery operation remains AI/system-owned and does not pause automation;
- an unmatched manual/native-app outbound is treated as human activity and moves that conversation to `HUMAN_ACTIVE`;
- any pending delayed AI send for that conversation must fail final revalidation after the manual activity is observed;
- the takeover is conversation-scoped unless product policy explicitly applies a broader pause;
- the owner does not need to open our dashboard first in order to take over when provider capabilities expose the manual native-app event.

Provider capability differences matter: if a channel/account configuration does not expose reliable native-app outbound echoes, the product must not claim automatic takeover detection from that native app. The unified Inbox remains the reliable manual-control surface in that case.

## Resume

Support explicit resume. Optional timed auto-resume may occur only when configured and only if there has been no newer human activity, no pending review and the channel remains eligible. A new manual outbound extends/restarts takeover.

## Human approvals/edits

- approve unchanged normal-window draft: send through the same delivery coordinator/atomic send path;
- edit then send: persist final human-edited text, mark source HUMAN, and optionally create a `HUMAN_EDITED_DRAFT` style example;
- for Instagram `HUMAN_ASSISTED_EXTENDED`, a deliberate human click/edit/send may use the Human Agent transport path if eligibility/approval still passes immediately before send;
- human text is not automatically added to factual knowledge.

## Native-app activity

When Meta exposes outbound echoes, unmatched external/manual messages are treated as human takeover even if sent from the Instagram/WhatsApp native app rather than our dashboard.

## Review queue UX requirements

Expose why the AI held the conversation, relevant factual sources, draft, confidence/reason codes and clear actions: edit/send, send as written, dismiss, claim conversation, resume AI. For Human Agent reviews, additionally display standard-window expiry, extended eligibility expiry/status and a visible statement that the final send is a human action.
