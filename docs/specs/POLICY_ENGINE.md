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
