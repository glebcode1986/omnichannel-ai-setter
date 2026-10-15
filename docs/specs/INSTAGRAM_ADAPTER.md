# Instagram Adapter Specification — v0.3

## Scope

Official Instagram messaging for professional Business/Creator accounts using the Instagram API with Instagram Login.

## Verified baseline (2026-09-17)

- Instagram Login does not require a linked Facebook Page for this API path.
- Required MVP scopes include `instagram_business_basic` and `instagram_business_manage_messages`.
- The recipient must have messaged the professional account first; official API automation does not create arbitrary cold conversations.
- Meta's current Instagram API collection includes a `HUMAN_AGENT` send capability for approved human-support use outside the standard automated window.
- Current Phase 2 Meta verification records an automated-response timing requirement/expectation of response within 30 seconds for experiences classified as automated. This must be re-verified during App Review and before production traffic.

Re-verified during P2-01/P2-02 (2026-09-17): Graph API **v26.0** on `graph.instagram.com`, both scopes unchanged, the standard window is 24 hours, Human Agent is 7 days sent as a **top-level `tag` field with no `messaging_type`**, and the login flow spans three hosts (`www.instagram.com` authorize, `api.instagram.com` exchange, `graph.instagram.com` for everything else). Six divergences from this baseline — no delivery webhook, no policy-enforcement field, no deletion event, no per-event identifier, no `app_id` on echoes, and the new `message_edit` field — are recorded in `docs/research/META_INSTAGRAM_PHASE2_VERIFICATION.md`, together with the OAuth and token-lifecycle facts.

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

The budget is counted from a triggering inbound message, so a send that has none does not have one. A scheduled follow-up (#55) is the case: it chases a silence, its anchor is hours or days old by design, and a deadline measured from that anchor is always already spent. Such a send is marked proactive and carries no dispatch deadline; the 24-hour standard messaging window is unaffected, still counted from the customer's own last message, and still refuses a proactive send made outside it. See `GOALS_FOLLOWUPS.md`.

## Adapter responsibilities

Implement the frozen `ChannelAdapter` contract in `packages/channel-instagram`:

- raw-body webhook verification / challenge handling as required by Meta;
- normalize inbound message, outbound echo, read/reaction/postback events. Instagram delivers no delivery-status and no policy-enforcement webhook on this API path, so those two normalized variants have no Instagram source (verification doc, divergences 1–2);
- retain stable source/provider IDs and platform timestamps;
- expose text-first capabilities;
- evaluate current automated messaging eligibility and, separately, current human-agent eligibility;
- send standard text via the official Send API;
- support a separate human-initiated send command/path that may attach `HUMAN_AGENT` only after explicit user action and approval checks;
- map provider responses into `ACCEPTED | REJECTED | AMBIGUOUS` without hiding ambiguity;
- expose enough provider policy/capability information for application timing decisions without moving product scheduling logic into the adapter. Implemented as `instagramTimingPolicy()`: the adapter reports the verified provider budget and a safety target as configurable data, and the delivery coordinator (P2-06) decides what to do with the remaining time.

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
- AUDIO/IMAGE/VIDEO/DOCUMENT without a supported interpretation pipeline -> persist and mark the reply cycle review-required or ask a safe text clarification according to policy. The adapter's part is only to report the message kind and media metadata; persistence is ingestion's and the review decision is the policy engine's (P2-05);
- never fabricate interpretation of unseen media.

## Credentials and account state

Store provider secrets/tokens through the encrypted credential abstraction referenced by `ChannelAccount`, not plaintext business fields. Persist connection state such as CONNECTED / NEEDS_REAUTH / DISCONNECTED and fail closed when credentials are invalid.

Implemented in P2-02: tokens are AES-256-GCM ciphertext in `channel_credentials`, with the key held outside the database and identified by `key_id` so it can be rotated. The ciphertext's additional authenticated data binds it to its Workspace, its credential row and its purpose, so a row copied into another tenant fails to decrypt rather than working. Connect state for an in-flight login is a single-use, short-lived `channel_connect_states` row paired with a `__Host-` cookie nonce whose hash is stored on the row; neither half alone completes a connection. A reconnect revives the account's own row so conversation history survives; disconnect marks it DISCONNECTED, frees the live-account slots (a profile can then connect a different account) and destroys the stored secret while keeping the row for audit.

### Keeping a connection alive

A long-lived Instagram token lasts 60 days and must be exchanged before it expires; Meta refuses to
refresh one that is already expired, or one younger than 24 hours. That makes the lifecycle a background
duty rather than a request-time one, and the worker owns it (`apps/worker/src/instagram-token-sweeper.ts`,
`instagram-token-refresh.ts`).

Four rules, each of which is a different wrong answer somebody could give:

1. **Refresh before expiry, not after.** The sweep asks for connections whose token expires inside a
   14-day horizon, oldest first, and runs every six hours — around fifty attempts per term, so a long
   database or Meta outage still leaves many tries.
2. **An expired token is a re-authorization, not a retry.** The account becomes `NEEDS_REAUTH` and no
   request is made: Meta's answer is already known and only a person can change it.
3. **An outage says nothing about the credential.** A timeout or a transient provider error leaves the
   account `CONNECTED` and the token untouched. Treating silence as revocation would take a working
   connection offline until somebody re-authorized it by hand.
4. **A rotation that lost a race is dropped.** Writes are conditional on the mint time they were computed
   from, so a token minted for a connection that has since been disconnected or re-authorized is
   discarded rather than forced.

The send path carries the other half. Meta's code 190 — an expired, revoked or invalidated token — is
already final for the message (`NON_RETRYABLE_CODES`), and it now also marks the connection
`NEEDS_REAUTH`, under the same mint-time guard. That covers the case no refresh can anticipate: a person
revoking access at Meta. Without it, `channel_accounts.status` stayed `CONNECTED` while every reply
failed, so the Inbox, the setup checklist and the health probe all reported a channel that could not send.

The worker reports which background loops are running in its `worker.started` log, because the first
version of this lifecycle was implemented, tested and called by nothing.

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
