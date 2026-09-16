# ADR-008: pnpm Workspace Monorepo

**Status:** Accepted

## Decision

Use a lightweight pnpm-workspace monorepo without requiring Turborepo in the first implementation.

Target layout:

```text
apps/
  web/                 # Next.js dashboard + HTTP/webhook routes
  worker/              # BullMQ workers / background processors
packages/
  domain/              # pure entities, value objects, enums, policies, ports
  application/         # use cases/orchestration
  db/                  # Prisma schema/client/repositories/transactions
  queue/               # BullMQ job contracts, producers, worker plumbing
  ai/                  # model providers, retrieval, structured generation
  channel-core/        # normalized event/send/capability contracts
  channel-instagram/   # Instagram Meta adapter
  channel-whatsapp/    # WhatsApp Cloud API adapter
  observability/       # logging/tracing/audit helpers
```

## Why

The web process and worker process have different deployment/runtime needs. Channel adapters must remain separable from the core. A pnpm workspace provides package boundaries and agent ownership without adding a build orchestrator before it is needed.

## Dependency direction

- `domain` depends on no infrastructure/channel package.
- `application` may depend on `domain` and declared ports.
- `db`, `queue`, `ai`, channel packages implement ports and may depend on shared contracts/domain types.
- `web` and `worker` compose concrete implementations.
- channel packages must not import each other.

Circular package dependencies are forbidden.

## Agent ownership

Implementation issues should name owned packages. Claude and Codex/Astra should not concurrently edit the same package unless the issue explicitly calls for review-only work.
