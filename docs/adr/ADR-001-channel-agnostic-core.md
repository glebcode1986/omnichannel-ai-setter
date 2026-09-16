# ADR-001: Channel-Agnostic Core

**Status:** Accepted

## Decision

Conversation, AI, safety, memory and delivery scheduling layers are channel-neutral. Instagram and WhatsApp implement a shared `ChannelAdapter` contract.

## Why

The product is intended to be omnichannel. Baking Instagram semantics into persistence/orchestration would make WhatsApp a bolt-on and force expensive rewrites.

## Consequences

- platform features are capability-gated;
- normalized models retain enough raw metadata for debugging;
- channel policy rules live behind adapter/policy abstractions;
- core tests must run without Meta SDK/API dependencies.
