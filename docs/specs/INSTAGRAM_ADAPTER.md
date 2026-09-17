# Instagram Adapter Specification — v0.3

## Scope

Official Instagram messaging for professional Business/Creator accounts using the Instagram API with Instagram Login.

## Verified baseline (2026-09-17)

- Instagram Login does not require a linked Facebook Page for this API path.
- Required MVP scopes include `instagram_business_basic` and `instagram_business_manage_messages`.
- The recipient must have messaged the professional account first; official API automation does not create arbitrary cold conversations.
- Meta's current Instagram API collection includes a `HUMAN_AGENT` send capability for approved human-support use outside the standard automated window.
- Current Phase 2 Meta verification records an automated-response timing requirement/expectation of response within 30 seconds for experiences classified as automated. This must be re-verified during App Review and before production traffic.

Implementation must re-check the current Meta API version, scopes, webhook fields, standard window, automated timing rule and Human Agent eligibility/approval requirements before merge; no version/window/timing duration is a permanent domain constant.

## Product-owner decisions

### Human Agent architecture

Keep Human Agent as an **Instagram-specific capability/path**, implemented by an Instagram-specific interface/capability extending the shared channel contract as needed.

Do **not** widen the generic `ChannelAdapter` automated-send semantics merely to expose the Instagram-only tag.

A background/AUTOPILOT worker must never attach `HUMAN_AGENT`. The tag is available only after an explicit authorized human action and fresh eligibility revalidation.

### Automated timing

Meta/provider timing policy wins over the product's generic “human-like” delay defaults.

For Instagram AUTOPILOT, the delivery coordinator must fit debounce + generation + any artificial post-draft delay inside the currently verified provider response budget. While the verified Meta cap is 30 seconds, the initial operational safety target is to dispatch no later than about 25 seconds after the latest triggering inbound where technically possible.

Artificial delay is shortened or removed when necessary. The old generic 30–120 second post-draft delay must not be applied to Instagram when it would violate the provider timing cap.

If the compliant automated-response deadline has already been missed, hold/review/re-evaluate rather than knowingly sending as ordinary AUTOPILOT under stale timing assumptions.

## Adapter responsibilities

Implement the frozen `ChannelAdapter` contract in `packages/channel-instagram`:

- raw-body webhook verification / challenge handling as required by Meta;
- normalize inbound message, outbound echo, delivery/read/reaction/postback/policy events where delivered by the selected API path;
- retain stable source/provider IDs and platform timestamps;
- expose text-first capabilities;
- evaluate current automated messaging eligibility and, separately, current human-agent eligibility;
- send standard text via the official Send API;
- support a separate human-initiated send command/path that may attach `HUMAN_AGENT` only after explicit user action and approval checks;
- map provider responses into `ACCEPTED | REJECTED | AMBIGUOUS` without hiding ambiguity;
- expose enough provider policy/capability information for application timing decisions without moving product scheduling logic into the adapter.

## Outbound-echo classification support

1. if an outbound platform message ID matches a send result stored by our delivery coordinator, it is our own app/API echo;
2. if an outbound echo cannot be correlated to an app send/operation, treat it as manual/native human activity and trigger takeover;
3. never rely only on message text equality.

## After-window policy

Workspace/account configuration:

- `STANDARD_ONLY`: normal automated-window eligibility only; after it closes, AI does not send.
- `HUMAN_ASSISTED_EXTENDED`: after the standard automated window closes, AI may create a draft and the application may expose a human review/send action if the account has the Human Agent feature and the extended human-support window is still eligible. No background worker may convert that draft to a HUMAN_AGENT send without explicit human action.

The exact extended-window duration and allowed use must be read from current Meta policy at implementation time. The current research baseline indicates up to 7 days and human-support-only usage, subject to App Review/business verification.

## Content policy for MVP

Automated AUTOPILOT: text only.

Human-assisted extended send: text initially; later media only after capability/policy verification.

Inbound:
- TEXT -> normal AI path;
- text caption/share metadata -> may contribute as untrusted context;
- AUDIO/IMAGE/VIDEO/DOCUMENT without a supported interpretation pipeline -> persist and mark the reply cycle review-required or ask a safe text clarification according to policy;
- never fabricate interpretation of unseen media.

## Credentials and account state

Store provider secrets/tokens through the encrypted credential abstraction referenced by `ChannelAccount`, not plaintext business fields. Persist connection state such as CONNECTED / NEEDS_REAUTH / DISCONNECTED and fail closed when credentials are invalid.

## Required fixture tests

- webhook challenge/verification success and failure;
- duplicate inbound webhook;
- inbound text;
- malformed/unknown message event;
- outbound echo correlated to our send;
- unmatched outbound echo (human takeover signal);
- accepted standard text send;
- definite Meta rejection;
- network timeout after request dispatch -> ambiguous;
- standard window closed under `STANDARD_ONLY`;
- standard window closed but human-agent eligible under `HUMAN_ASSISTED_EXTENDED` -> review required, no auto-send;
- explicit approved human send through HUMAN_AGENT path;
- extended human-agent window closed -> blocked;
- unsupported inbound media safe handling.
