# Technical Specification — v0.2

## Webhook contract

Webhook endpoints perform only validation, normalization, dedupe/persistence and enqueueing, then return quickly. No LLM call and no intentional delay in request lifecycle.

## Normalized event model

```ts
type NormalizedChannelEvent =
  | InboundMessageEvent
  | OutboundEchoEvent
  | DeliveryStatusEvent
  | ReadStatusEvent
  | ReactionEvent
  | PostbackEvent
  | ConversationPolicyEvent;
```

Every event includes `workspaceId`, `channel`, `channelAccountId`, `sourceEventId`, `occurredAt` and retention-controlled `rawMeta`.

## State machines

Inbound: `RECEIVED -> PERSISTED -> ELIGIBILITY_CHECK -> DEBOUNCED -> DRAFTED | SKIPPED | HELD`.

Outbound AI draft: `PENDING -> HELD | SCHEDULED -> CLAIMED -> SENT | FAILED | HELD_AMBIGUOUS | CANCELLED_SUPERSEDED`.

## Idempotency

- unique webhook key `(channel_account_id, source_event_id)`;
- unique platform message ID when provided;
- one outbound AI action per `draft_id`;
- deterministic queue IDs for policy-critical delayed jobs.

## LLM port

```ts
interface ReplyModel {
  generate(input: ReplyGenerationInput): Promise<ReplyGenerationOutput>;
}
```

Validate output with a strict schema (e.g. Zod). Parse failure sets review/hold; never auto-send raw model text.

## Retrieval

Maintain separate factual-knowledge and style indexes. Retrieval query uses recent turns, not only the final short message. Style results cannot establish business facts.

## Manual takeover

Match known system/API outbound IDs/echoes so they do not count as human sends. A verified manual human send sets takeover state, cancels scheduled AI jobs where possible and is also enforced by final gate. Initial pause-duration candidate: 6h, configurable.

## Platform policy layer

WhatsApp: official Cloud API; track current customer-service window from qualifying inbound events; outside free-form window, approved templates are required where Meta policy says so.

Instagram: enforce current Meta messaging windows/capabilities in adapter/policy code, not in prompt prose.

## Secrets

Encrypt long-lived channel credentials at rest; never expose service-role/admin secrets to browser; revoke/rotate independently per channel account.

## Observability

For each AI attempt retain correlation ID, message references, model/provider/version, retrieved knowledge/style IDs, structured draft, confidence, gates/reasons, selected delay and final send/cancel/failure outcome. Avoid unnecessary sensitive plaintext in high-level logs.
