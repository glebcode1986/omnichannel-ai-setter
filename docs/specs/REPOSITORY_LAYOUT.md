# Repository Layout — v0.1

Canonical Phase-1 layout:

```text
apps/
  web/
  worker/
packages/
  domain/
  application/
  db/
  queue/
  ai/
  channel-core/
  channel-instagram/
  channel-whatsapp/
  observability/
docs/
  adr/
  handoff/
  research/
  specs/
```

## Ownership guidance

- `domain`: pure TypeScript; no React, Prisma, BullMQ, Meta SDK/API or LLM provider imports.
- `application`: use cases and ports; coordinates state transitions.
- `db`: Prisma schema/client/repositories/transaction helpers only.
- `queue`: BullMQ job names/payload schemas/producers/worker bootstrap helpers.
- `ai`: provider adapters, retrieval and structured draft generation; never sends channel messages.
- `channel-core`: public channel boundary types/contracts.
- channel packages: Meta HTTP/webhook implementation and provider mapping only.
- `observability`: correlation IDs, structured logs, audit helpers.
- `apps/web`: dashboard, auth/session, API/webhook entry points and composition root.
- `apps/worker`: long-running processors and composition root.

## Import rule

Composition happens at app edges. Infrastructure packages implement core ports; core packages must not import concrete infrastructure.

## Phase-1 bootstrap

Use pnpm workspace, shared TypeScript config and lint/test tooling. Do not introduce Turborepo unless build performance/CI later justifies it.
