# Deterministic Policy Engine Specification — v0.2

## Purpose

Pure deterministic decision layer between a validated AI draft and delivery scheduling/review.

## Decision output

```ts
type PolicyDecision =
  | { action: "SKIP"; reasons: ReasonCode[] }
  | { action: "HOLD_REVIEW"; reasons: ReasonCode[]; reviewMode?: "NORMAL" | "HUMAN_AGENT" }
  | { action: "SCHEDULE"; reasons: ReasonCode[] };
```

AUTOPILOT never calls the channel adapter directly from this layer. `SCHEDULE` creates delayed standard delivery work.

## Required gates

A draft can be scheduled for automatic delivery only when all required gates pass:

- mode is AUTOPILOT;
- conversation/account AI is enabled;
- draft schema is valid;
- confidence meets configured threshold;
- no mandatory-review category/reason is present;
- material factual claims have acceptable provenance/support;
- current channel policy/window allows automated free-form send;
- no active human takeover/review claim;
- account/credentials are healthy enough to send;
- content kind is supported for auto-send;
- quiet-hours policy permits a schedule that remains inside channel eligibility;
- current reply cycle is still owned by this draft.

DRAFT mode always results in `HOLD_REVIEW`; OFF never generates/schedules normal AI delivery.

## Instagram after-window behavior

Policy input includes `instagramAfterWindowPolicy`:

- `STANDARD_ONLY`: if the standard automated window is closed, return SKIP/HOLD according to UX policy; never schedule automatic delivery.
- `HUMAN_ASSISTED_EXTENDED`: if standard automated delivery is closed but the account is currently eligible for approved Human Agent support, return `HOLD_REVIEW` with `reviewMode: "HUMAN_AGENT"`. The AI may draft, but only a deliberate human action can initiate the tagged send.
- if neither standard nor human-agent eligibility exists, block send.

No policy result may schedule an automated background send using `HUMAN_AGENT`.

## Initial mandatory-review reasons

Payment/refund disputes beyond documented simple policy, legal/contract interpretation, medical/high-risk advice, credential/security requests, reputational complaints, unusual high-value commitments, unsupported discount/availability/outcome promises, materially missing facts and unsupported media interpretation.

## Test style

Implement as pure functions/value objects where possible. Table-driven tests must cover every gate individually plus conflicting combinations. LLM text cannot change or disable a gate.

## Product-owner decisions — 2026-09-18

### OFF and explicit human assistance
`OFF` remains terminal for background/normal AI generation and automatic delivery. An explicitly authorized human-requested draft is a separate manual-assist use case and may generate while OFF, but it can never be auto-scheduled or auto-sent because of that request.

### Closed Instagram standard window
Under Instagram `STANDARD_ONLY`, when the standard automated window is closed and no explicitly enabled human-assisted path applies, automatic work returns `SKIP` rather than creating a routine Review item. The Inbox must still show the customer message and an operational `window closed / AI could not send` state; incidents or explicit human actions may create separate actionable Review items.

### Quiet hours
Quiet hours should **defer** automated delivery when a compliant future send time exists inside the still-valid provider/channel window and timing budget.

If quiet-hours deferral would cross or violate the provider/channel eligibility deadline, do not schedule a late send. Return `HOLD_REVIEW` (or the channel-specific safe terminal result where no human action is possible). Never silently send during quiet hours and never blindly send after provider eligibility expires.

The policy/delivery contract may therefore carry a deterministic `notBefore/deferUntil` value or an equivalent scheduling result rather than treating quiet hours as a permanent block.

### Channel-specific after-window policy
Keep the evaluator channel-neutral by using a discriminated channel-policy input rather than a flat Instagram-only field. Instagram and WhatsApp after-window policies remain distinct variants; adding WhatsApp must not reinterpret Instagram semantics.
