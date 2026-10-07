# ADR-017: Provider-neutral billing and entitlement boundary

**Status:** Accepted

## Decision

Product access is controlled by normalized workspace subscription/entitlement state owned by the application/domain model. Payment/billing providers are adapters behind a billing port.

Provider customer/subscription/price/status objects must not become product enums or leak into generic UI/application logic.

## Dependency direction

- application owns billing/entitlement use cases and provider-neutral ports;
- billing provider adapter/infrastructure implements those ports;
- DB persists normalized subscription/plan/usage state plus opaque provider references;
- web/worker compose provider implementation;
- product feature code asks an entitlement service/policy, not Stripe/Paddle directly.

## Invariants

- server-side entitlement checks are authoritative;
- delayed automated sends revalidate current entitlement immediately before send;
- webhook ingestion/conversation persistence continues even when AI quota is exhausted;
- downgrade/cancellation never deletes customer data merely to satisfy a commercial limit;
- provider webhooks are authenticated, idempotent and safe under duplication/reordering;
- billing provider replacement must not require rewriting channel/AI/domain logic.

## Consequences

A future concrete billing provider can be selected/replaced without changing plan/feature semantics. Provider-specific SDKs/secrets remain in the billing adapter and composition roots.
