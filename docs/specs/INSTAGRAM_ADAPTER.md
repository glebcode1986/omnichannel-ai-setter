# Instagram Adapter Specification — v0.2

## Scope

Official Instagram messaging for professional Business/Creator accounts using the Instagram API with Instagram Login.

## Verified baseline (2026-09-16, re-verified 2026-09-17)

- Instagram Login does not require a linked Facebook Page for this API path.
- Required MVP scopes include `instagram_business_basic` and `instagram_business_manage_messages`.
- The recipient must have messaged the professional account first; official API automation does not create arbitrary cold conversations.
- Meta's current Instagram API collection includes a `HUMAN_AGENT` send capability for approved human-support use outside the standard automated window.

Re-verified during P2-01 (2026-09-17): Graph API **v26.0**, host `graph.instagram.com`, both scopes unchanged, the standard window is 24 hours, and Human Agent is 7 days sent as a **top-level `tag` field with no `messaging_type`**. Six divergences from this baseline — no delivery webhook, no policy-enforcement field, no deletion event, no per-event identifier, no `app_id` on echoes, and the new `message_edit` field — are recorded in `docs/research/META_INSTAGRAM_PHASE2_VERIFICATION.md`.

Implementation must re-check the current Meta API version, scopes, webhook fields, standard window and Human Agent eligibility/approval requirements before merge; no version/window duration is hard-coded in domain code.

## Adapter responsibilities

Implement the frozen `ChannelAdapter` contract in `packages/channel-instagram`:

- raw-body webhook verification / challenge handling as required by Meta;
- normalize inbound message, outbound echo, read/reaction/postback events. Instagram delivers no delivery-status and no policy-enforcement webhook on this API path, so those two normalized variants have no Instagram source (verification doc, divergences 1–2);
- retain stable source/provider IDs and platform timestamps;
- expose text-first capabilities;
- evaluate current automated messaging eligibility and, separately, current human-agent eligibility;
- send standard text via the official Send API;
- support a separate human-initiated send command/path that may attach `HUMAN_AGENT` only after explicit user action and approval checks;
- map provider responses into `ACCEPTED | REJECTED | AMBIGUOUS` without hiding ambiguity.

## Outbound-echo classification support

1. if an outbound platform message ID matches a send result stored by our delivery coordinator, it is our own app/API echo;
2. if an outbound echo cannot be correlated to an app send/operation, treat it as manual/native human activity and trigger takeover;
3. never rely only on message text equality.

## After-window policy

Workspace/account configuration:

- `STANDARD_ONLY`: normal automated-window eligibility only; after it closes, AI does not send.
- `HUMAN_ASSISTED_EXTENDED`: after the standard automated window closes, AI may create a draft and the application may expose a human review/send action if the account has the Human Agent feature and the extended human-support window is still eligible. No background worker may convert that draft to a HUMAN_AGENT send without explicit human action.

The exact extended-window duration and allowed use must be read from current Meta policy at implementation time. The 2026-09-16 research baseline indicates up to 7 days and human-support-only usage, subject to App Review/business verification.

## Content policy for MVP

Automated AUTOPILOT: text only.

Human-assisted extended send: text initially; later media only after capability/policy verification.

Inbound:
- TEXT -> normal AI path;
- text caption/share metadata -> may contribute as untrusted context;
- AUDIO/IMAGE/VIDEO/DOCUMENT without a supported interpretation pipeline -> persist and mark the reply cycle review-required or ask a safe text clarification according to policy. The adapter's part is only to report the message kind and media metadata; persistence is ingestion's and the review decision is the policy engine's (P2-05);
- never fabricate interpretation of unseen media.

## Credentials and account state

Store provider secrets/tokens through the encrypted credential abstraction referenced by `ChannelAccount`, not plaintext business fields. Persist connection state such as CONNECTED / NEEDS_REAUTH / DISCONNECTED and fail closed when credentials are invalid.

## Required fixture tests

- webhook challenge/verification success and failure;
- duplicate inbound webhook (asserted at the adapter as `sourceEventId` determinism: deduplication itself happens in ingestion's source-event claim, and the adapter is stateless);
- inbound text;
- malformed/unknown message event;
- outbound echo correlated to our send;
- unmatched outbound echo (human takeover signal);
- accepted standard text send;
- definite Meta rejection;
- network timeout after request dispatch -> ambiguous;
- standard window closed under `STANDARD_ONLY`;
- standard window closed but human-agent eligible: the adapter reports `NOT_ELIGIBLE` for automation while human-agent eligibility is still open, and the automated send path never attaches a tag. The review-required state itself belongs to the policy engine (P2-05);
- explicit approved human send through HUMAN_AGENT path;
- extended human-agent window closed -> blocked;
- unsupported inbound media safe handling.
