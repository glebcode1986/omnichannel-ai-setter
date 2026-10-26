# ADR-020: Billing provider adapters speak HTTP, and the port lives in `application`

**Status:** Accepted

**Context:** Issue #41, the product owner's decision of 2026-10-09 (`primary_provider=STRIPE`,
`additional_providers=WAYFORPAY,CRYPTOMUS`), ADR-017 (provider-neutral billing and entitlement boundary),
ADR-019 (multi-provider routing and seller profiles).

## Decision

**1. A billing provider adapter talks to its provider over HTTP, with `fetch` and `node:crypto`. It does
not take the provider's SDK as a dependency.**

**2. The provider-neutral billing port lives in `@omnichannel/application`.** The adapter interface, the
normalized event, the checkout hand-off, the reconciliation query and the registry that mints verified
events are declared there; `@omnichannel/billing-stripe` implements them. `@omnichannel/db` re-exports the
port's surface for its own callers and owns one sentence of its own — the refusal of an event the port did
not mint.

**3. An adapter package may not depend on `@omnichannel/db`.**

## Why no SDK

The decision is read off this repository's own record rather than off a preference.

- There are **no vendor API SDKs in the workspace**. The complete set of third-party runtime dependencies
  across thirteen packages is `zod`, `bullmq`, `ioredis`, `@prisma/client`, `@prisma/adapter-pg`, `pg`,
  `next`, `next-auth`, `react`, `react-dom`, `@auth/prisma-adapter`. Every one was introduced in Phase 1
  and named by ADR-005 or ADR-009.
- **Seven third-party HTTP APIs are already integrated by hand**, three of them where a first-party SDK
  exists and was declined. `packages/ai/src/transcription-provider.ts` builds its own
  `multipart/form-data` rather than taking `openai`. Stripe's form-encoded v1 API is a strictly easier
  case than the one already solved.
- **The mechanical enforcement has no payments entry.** `CORE_FORBIDDEN_THIRD_PARTY` in
  `scripts/architecture/rules.ts` names persistence, queue, UI/auth, LLM provider and Meta SDKs. Taking
  `stripe` would make the product rule "application and domain never import a provider SDK" a review
  promise until that list, this table and `REPOSITORY_LAYOUT.md` were extended — and extended again for
  WayForPay and for Cryptomus. Writing against the HTTP API leaves no importable name that could leak.
- **Retry belongs to the queue.** No adapter in this repository retries: one attempt, a hard
  `AbortController` timeout, a classified result, and BullMQ owns attempts and backoff. Stripe's SDK ships
  `maxNetworkRetries` and a timeout of its own, so using it correctly here means taking a dependency in
  order to switch off the part of it that is doing work.
- **Error objects are a disclosure risk.** `packages/observability/src/logger.ts` copies an allowlist of
  error fields, with the stated reason that "HTTP/DB client errors often carry request config, headers or
  credentials". Raw `fetch` hands this package a `{status, body}` record it selects codes out of; an SDK
  hands it an error object carrying the request, its headers and the key that signed it.
- **Verification needs nothing from an SDK.** `Stripe-Signature` is an HMAC-SHA256 over
  `timestamp + "." + rawBody`, and the same construction is already written twice, in
  `packages/channel-instagram/src/verify.ts` and `packages/channel-whatsapp/src/verify.ts`, with the
  length check before `timingSafeEqual` and a strict hex guard. The only genuinely new element is the
  five-minute timestamp tolerance.

**No specification forbids an SDK.** `BILLING_ENTITLEMENTS.md` and ADR-017 constrain *where* one may live,
not whether one may be taken. So this is an argument from precedent and enforcement, not a compliance
one — which is exactly why it is written down. If a future provider's protocol cannot honestly be written
by hand, reversing this is a new ADR and not a quiet `pnpm add`.

## Why the port moved to `application`

ADR-017 already says it: "application owns billing/entitlement use cases and provider-neutral ports;
billing provider adapter/infrastructure implements those ports". The port was first written inside
`packages/db`, beside the store that consumes it, which read naturally and made the first adapter
impossible — an adapter would have had to import the persistence package in order to name the interface it
implements.

It is the same arrangement ADR-010 settled for AI as amended by the PR #26 review: `application` owns
`ReplyModel` and `EmbeddingProvider`, `packages/ai` implements them and keeps provider details private.

**The forbidden edge `billing-stripe -> db` is the point, not tidiness.** The one rule this whole boundary
exists for is that a browser arriving at a success page never activates a paid entitlement. An adapter
that could reach the database could write an arrangement without a verified event; one that cannot reach
it has no way to try. The `WeakSet` brand that `verifyProviderDelivery` mints and
`recordVerifiedBillingEvent` checks remains the enforcement, and moving the mint did not weaken it: the
set is unreachable, the minted objects are frozen, and a structural cast type-checks and fails the check.

## Consequences

- A second adapter (WayForPay, Cryptomus) is a second package of the same shape, with no dependency to
  argue about and no new npm package on the money path.
- Stripe's API version is pinned in the adapter with the `Stripe-Version` header, and the documentation it
  was written against is cited with the date it was read — the convention `packages/ai` and
  `packages/channel-instagram` already follow. Inbound webhook payloads are **not** affected by that
  header: a snapshot event is rendered at the version fixed when the endpoint was created.
- Every provider call is scripted in tests through `BillingHttpPort`, so the acceptance matrix in Issue
  #41 runs with no network, no key and no charge.
- A route's credentials are resolved per request from configuration rather than from a module-level
  client, because one process serves more than one seller: ADR-019 binds each `BillingRoute` to an exact
  seller profile and an exact provider account, and the owner's decision requires the Ukrainian FOP and
  the Romanian company to stay separate legal entities.
