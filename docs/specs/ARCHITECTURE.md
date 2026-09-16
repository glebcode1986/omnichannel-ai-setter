# Target Architecture — v0.2

## High-level flow

```text
Meta Webhooks
  -> Channel Webhook Adapter
  -> Normalized Event Ingestion
  -> Conversation/Message Store
  -> Eligibility + Debounce Scheduler
  -> AI Draft Orchestrator
       -> factual knowledge retrieval
       -> style retrieval
       -> LLM provider
       -> structured-output validation
  -> Deterministic Safety/Policy Gates
  -> Draft or Delayed Delivery Queue
  -> Final Pre-send Revalidation
  -> ChannelAdapter.send()
       -> Instagram API / WhatsApp Cloud API
```

## Core boundaries

### Channel adapters

Responsibilities: verify webhook authenticity; normalize platform events; send supported message types; expose capabilities; interpret status/echo events; evaluate policy/service windows.

Conceptual contract:

```ts
interface ChannelAdapter {
  readonly channel: ChannelType;
  verifyWebhook(input: RawWebhook): Promise<VerificationResult>;
  normalizeWebhook(input: RawWebhook): Promise<NormalizedChannelEvent[]>;
  send(command: OutboundMessageCommand): Promise<SendResult>;
  getCapabilities(accountId: string): Promise<ChannelCapabilities>;
  evaluateWindow(ctx: ConversationPolicyContext): Promise<ChannelWindowState>;
}
```

### Conversation domain

Channel-neutral entities: Workspace, ChannelAccount, Contact, ContactIdentity, Conversation, Message, AutomationPolicy, HumanTakeoverState, AiDraft, DeliveryJob, LeadState.

### AI draft engine

Inputs: business/owner persona, goal, current inbound bundle, recent turns, factual knowledge hits, style examples, channel capability hints. Output is structured and schema-validated.

### Deterministic safety/policy engine

Gates: mode != OFF, model output valid, confidence threshold, no mandatory-review category, capability/length compliance, no newer inbound supersession, no human takeover, policy window valid, account connected, rate/quota allowed, delivery job still owns current reply cycle.

### Delay engine

Two durable stages: inbound burst debounce before generation, randomized delivery delay after draft. Neither blocks a webhook request.

### Unified inbox

Normalized conversation/message view with channel-specific badges and actions. Human manual sends update takeover state.

## Technology direction (not fully frozen)

- TypeScript;
- PostgreSQL;
- Redis + BullMQ is current leading queue candidate;
- Next.js/React dashboard;
- Prisma vs Drizzle pending ADR after reuse/migration-cost review;
- provider-agnostic LLM abstraction;
- deployment must separate stateless web/API from background workers.

## Scaling/reliability

- database is durable source of record;
- queue coordinates work but is not conversation memory;
- unique inbound source IDs and outbound operation IDs;
- atomic job claim before send;
- concurrent workers cannot double-send;
- ambiguous network/send outcomes go to `HELD_AMBIGUOUS` and reconciliation, not blind retry;
- per-channel/account rate limiting.
