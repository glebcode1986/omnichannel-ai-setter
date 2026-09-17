# Human Delay Engine — v0.3

## Objective

Avoid robotic instant replies while preventing stale answers, violating channel policy, or sacrificing reliability.

## Provider-policy precedence

Channel/provider timing requirements are authoritative hard bounds.

Product-level “human-like” timing is a fallback preference only. If a provider defines a stricter response deadline or timing rule, the delivery plan must be clamped to that provider rule. A Business Profile setting may make delivery faster inside an allowed provider window, but may not extend delivery beyond the provider cap.

The application/delivery coordinator owns this policy. Adapters expose current capability/policy facts; the model never chooses or overrides the timing rule.

## Instagram automated response profile

Current Meta verification for the Instagram Messaging path used by this product records a policy expectation that experiences classified as automated respond to user-initiated input within 30 seconds.

For Instagram AUTOPILOT:

- treat the current provider response deadline as an absolute cap for the reply cycle;
- use the latest triggering inbound/customer input as the timing anchor;
- target dispatch with an internal safety margin before the provider cap (initial operational target: no later than about 25 seconds after the anchor while the verified Meta cap is 30 seconds);
- debounce and post-draft delay are dynamic parts of the same total budget, not additive fixed waits;
- if drafting/retrieval/policy work consumes most of the budget, reduce or eliminate artificial post-draft delay;
- if the compliant provider deadline has already been missed, do not knowingly send the message as normal Instagram AUTOPILOT merely to preserve the old delay behavior; hold/review/re-evaluate according to policy;
- re-verify Meta policy during onboarding/App Review and before production launch. If Meta changes the cap, provider policy/configuration changes without changing domain semantics.

This replaces the old assumption that Instagram should always use both a 7–12 second debounce and a 30–120 second post-draft delay.

## Stage A — inbound debounce

For channels without a stricter provider timing cap, the initial configurable fallback target remains 7–12 seconds after the latest inbound message in a burst.

If another inbound arrives before firing, the prior debounce job becomes stale/superseded. The newest message owns the reply cycle and draft context includes the recent burst.

For a channel with a provider response deadline, debounce must fit inside the remaining provider budget and may be shortened.

## Stage B — post-draft delivery delay

For channels without a stricter provider timing cap, after generation and initial gates schedule delivery with an initial configurable fallback range of 30–120 seconds.

Do not sleep in a request/worker thread; persist/schedule a durable job.

For channels with a provider deadline, post-draft delay is clamped to the remaining budget and may be zero. A randomized “natural” delay is never more important than provider compliance.

The production distribution should not look uniformly mechanical where the provider allows freedom. Exact distribution parameters are configuration, not hardcoded business logic.

## Final pre-send gate

Immediately before adapter send verify all of the following:

- job/draft still owns the current reply cycle;
- no newer inbound superseded anchor context;
- no verified human reply/takeover;
- conversation/account mode still allows automation;
- draft was not dismissed/edited/replaced;
- channel service/policy window still allows this message type;
- provider timing/deadline still permits the intended automated send;
- account credentials/connection remain valid enough to attempt send;
- idempotency guard confirms this outbound operation has not completed.

Failure cancels/holds/rebuilds according to reason; stale or provider-ineligible content is never sent merely because a timer expired.

## Delivery concurrency

A delivery job must atomically claim the send operation. Only one worker can own a draft send. After claim, record attempt/correlation/operation ID before or atomically with outbound state transition as architecture permits.

## Ambiguous outcome

If transport times out after a request may have reached Meta and delivery status is unknown, mark `HELD_AMBIGUOUS` and reconcile. Do not automatically resend and risk duplicate customer messages.

## Human takeover race

Queue cancellation is best-effort only. Final DB-backed takeover/revision checks are authoritative, so an already-running worker still cannot send after a human reply.

## Human Agent timing

Instagram Human Agent remains a separate explicitly-human path. AUTOPILOT/background workers never attach `HUMAN_AGENT` simply to escape automated timing/window rules. Human Agent eligibility and current Meta policy are revalidated at the explicit human send action.

## Configuration

Workspace/Business Profile may configure debounce, delay range, quiet-hours policy and takeover duration within product safety and provider bounds. Per-conversation override is allowed where defined by policy.

Provider-specific limits always win over looser product configuration.
