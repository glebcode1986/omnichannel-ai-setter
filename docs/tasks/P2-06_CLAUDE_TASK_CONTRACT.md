# Task Contract — P2-06 Claude

**Issue:** #13 `[P2-06] Implement delivery coordinator and final revalidation`  
**Branch:** `feat/p2-06-delivery-coordinator`  
**Depends on:** #5 queue primitives, #8 Instagram adapter, #12 policy engine.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `DELIVERY_COORDINATOR.md`, `DELAY_ENGINE.md`, ADR-003/012/013/014, `CHANNEL_CONTRACTS.md`, Issue #13.

## Objective
Create the single outbound delivery coordinator used by AUTOPILOT and human-approved drafts. No other path may send AI/customer replies directly through a channel adapter.

## Required behavior
- choose/persist a provider-aware timing plan rather than blindly applying one global delay profile;
- for channels without a stricter provider cap, preserve the current fallback natural-delay target (initial 30–120s post-draft, with the debounce policy defined in `DELAY_ENGINE.md`);
- for Instagram automated replies, obey the currently verified Meta automated-response deadline: the entire debounce + generation + post-draft scheduling plan must fit the provider budget; while the current verified cap is 30s, target dispatch with an internal safety margin (initially about 25s from the latest triggering inbound), shortening/eliminating artificial delay as necessary;
- if the provider-compliant deadline is already missed, do not knowingly send as ordinary Instagram AUTOPILOT merely to preserve the old delay behavior; hold/review/re-evaluate safely;
- immediately before send re-evaluate reply-cycle ownership, newer inbound, human takeover, mode, draft status, account health, channel window/policy, provider timing eligibility and idempotency;
- atomically claim the logical delivery;
- use stable operation IDs/correlation IDs;
- map `ACCEPTED`, definite `REJECTED` and `AMBIGUOUS` correctly;
- retry only explicitly retryable definite failures;
- quarantine ambiguous/network-midflight results with no blind resend;
- recover stale `SENDING` after process restart into a safe reconciliation/hold state;
- newer inbound, manual human activity or changed policy cancels/stales pending delivery.

## Human Agent boundary
Keep Human Agent as an Instagram-specific explicitly-human capability/path rather than widening the shared automated `ChannelAdapter` send contract.

Automated delayed-delivery jobs must not silently add `HUMAN_AGENT`. An explicitly human-approved extended-window action may enter this coordinator carrying audited human actor/action context and must still revalidate eligibility immediately before send.

Human Agent may not be used to bypass the automated-response timing policy for an AUTOPILOT send.

## Provider-policy precedence
Provider/channel limits are hard bounds. Product “human-like” timing is a preference inside those bounds. Business Profile configuration may shorten an allowed delay but may not extend an automated send beyond the provider limit.

Provider policy/version facts must be re-verifiable/configurable so a Meta policy change does not require changing domain semantics.

## Tests
Two workers racing one delivery, duplicate jobs, retryable rejection, non-retryable rejection, timeout ambiguity, stale claim/restart, newer-message supersession, human takeover during delay, policy/window change during delay, human-assisted extended-window eligibility expiry, Instagram deadline clamping, near-deadline zero-artificial-delay behavior, missed-deadline hold/review behavior, and proof that Human Agent is never attached by background AUTOPILOT.

## PR requirements
Document atomic claim transaction/constraint strategy, provider timing-plan calculation and ambiguous-outcome recovery. Run concurrency/integration/root tests. Re-verify the current Instagram timing policy during implementation/App Review; if the verified Meta limit differs from the present 30s baseline, update the provider policy/configuration and evidence rather than hardcoding stale assumptions. Do not merge.
