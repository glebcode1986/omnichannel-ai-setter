# AI Action Permissions & Approval Matrix

## Principle

`OFF`, `DRAFT`, and `AUTOPILOT` do not by themselves define what the AI is allowed to do. Action authorization is a separate deterministic layer.

The model may propose structured intent/action data. The application layer authorizes or rejects the action based on policy, role, Business Profile scope, channel capability, entitlement, human-takeover state, current provider state, and current conversation anchor.

Core invariant:

**LLM proposes. Application authorizes. Infrastructure executes.**

## Action risk classes

Use at least four action classes:

- `READ_ONLY` — no external mutation, e.g. read Knowledge, inspect CRM fact, check calendar availability.
- `LOW_RISK_WRITE` — ordinary reversible operational write, e.g. normal customer reply, CRM note, non-terminal lead field update.
- `REVIEW_REQUIRED` — action may be prepared but needs human approval, e.g. exception discount, sensitive complaint response, booking exception.
- `HUMAN_ONLY` — model may explain/suggest but cannot complete the action, e.g. refund, ownership/security changes, destructive deletion.

Risk class is only one input. Final execution also depends on Business Profile policy, AI mode, channel/provider state, entitlement, role authorization and conversation state.

## Messaging

- `OFF`: no AI-generated customer send.
- `DRAFT`: AI may prepare text; authorized human sends.
- `AUTOPILOT`: normal supported reply may send automatically only when all deterministic checks pass.

Checks include trusted factual support where required, no unresolved Review blocker, no human takeover, current channel eligibility, current entitlement and a fresh conversation anchor.

Bulk approval of customer-facing AI sends is not supported initially.

## Discounts and commercial exceptions

Discount autonomy must be bounded by explicit Business Profile policy.

Example: if policy allows AI discounts up to 10%, an offer of 5% may be autonomous when otherwise eligible. A proposed 15% discount becomes Review. The model never expands the configured ceiling based on subjective judgment.

Custom commercial terms, unusual exceptions and policy overrides require Review or human-only handling according to configuration.

## Booking

Normal booking into an eligible authoritative slot may be autonomous only when the appointment type and Business Profile policy allow it.

Exceptions require Review, including after-hours requests, missing required deposit, cancellation/reschedule exception, resource conflict, policy exception or ambiguous provider state.

## CRM actions

Potential autonomous CRM actions may include:
- create/update contact;
- add note;
- write qualification facts;
- update explicitly allowed non-terminal pipeline fields.

Destructive deletes, broad pipeline mutation and policy-sensitive terminal changes are not automatically allowed.

Terminal states such as `WON` / `LOST` are Business-Profile-configurable. They may be derived from deterministic confirmed events where appropriate, otherwise human confirmation is required.

## Customer Memory

AI may propose memory candidates.

Obvious low-risk explicit customer facts may be auto-saved where policy permits. Sensitive, ambiguous or inferred facts require human confirmation or must not be durably stored.

Do not create durable profiling such as `wealthy`, `lonely`, `insecure`, `easy to influence` or similar psychological/commercial manipulation traits.

## Knowledge and Style

Knowledge is business truth and cannot be silently mutated by the AI. The AI may propose `Add to Knowledge`, but an authorized human must confirm trusted business facts.

Style may receive suggestions based on repeated human edits, but persistent Style configuration changes require explicit approval.

## Payments

Distinguish at least:

- `CREATE_PAYMENT_LINK` — may be autonomous where amount/product/terms are deterministic and policy allows it.
- `CONFIRM_PAYMENT_RECEIVED` — customer-facing confirmation may be automatic only after authoritative provider/server confirmation.
- `REFUND`, `VOID`, `MANUAL_PRICE_ADJUSTMENT` — Review or human-only; refunds are human-only by default.

A redirect, customer statement or LLM judgment is never payment confirmation.

## Cancellation / reschedule

Standard cancellation/reschedule within configured policy may be autonomous for allowed appointment types.

Actions with money impact, cutoff exceptions, penalties, custom waiver or ambiguous provider state require Review/human approval.

## Destructive, security and account actions

The following are never AUTOPILOT actions:

- delete Contact / Business Profile / Workspace;
- transfer ownership;
- change member role/access;
- revoke member;
- rotate or expose secrets;
- disconnect a channel;
- alter platform billing/security policy.

AI may explain the process and guide an authorized human to the relevant action surface.

## Review UX

A Review item should explain the exact proposed action and the policy reason for the hold.

Examples:

- `Proposed action: Offer 15% discount` / `Policy allows up to 10%`.
- `Proposed action: Cancel paid appointment` / `Cancellation fee may apply`.

Review must be actionable and specific, not only `AI uncertain`.

## Human role approval

Human approval is also authorization-bound.

An AGENT may be allowed to send a normal message but not approve a large discount or refund. OWNER/ADMIN permissions and optional fine-grained permissions determine who may approve each action.

Final authorization therefore combines:

**AI action policy + human role permission + Business Profile scope**.

## Structured model proposal

Model output may include fields such as:

- `reply`;
- `intent`;
- `suggested_action`;
- `action_arguments`;
- `confidence`;
- `needs_review`;
- `reason_codes`.

These fields are advisory. They never directly execute an external side effect.

## Final revalidation

Immediately before any external side effect, revalidate the current state.

At minimum check:
- latest customer/human message anchor;
- takeover/Review state;
- current AI mode;
- action policy and role permission;
- entitlement;
- channel/provider capability;
- provider-side object state where relevant;
- deduplication/idempotency state.

Approval is bound to a specific action and state anchor. If material state changes after approval, the approval becomes stale and must not execute blindly.

## Business Profile settings UX

Expose understandable action-policy groups rather than an enormous technical matrix, for example:

- Replies — AUTOPILOT allowed;
- Booking — AUTOPILOT allowed;
- Discounts — up to configured limit;
- CRM updates — allowed;
- Terminal lead stages — human confirmation;
- Payment links — allowed;
- Refunds — always human;
- Knowledge changes — always human;
- Sensitive complaints — Review;
- Data deletion — human only.

## Audit

Audit material action-policy decisions and changes, including:
- action-policy configuration change;
- proposed action held for Review;
- human approval/rejection;
- stale approval invalidation;
- autonomous external action execution;
- actor/source and relevant policy reason;
- provider/correlation reference without secrets.

## Product question model

For every supported action, the product should be able to answer:

1. Can AI suggest it?
2. Can AUTOPILOT execute it?
3. Does it require Review?
4. Which human role may approve it?
5. What must be revalidated immediately before execution?
