# ADR-005: Prisma + PostgreSQL + BullMQ/Redis Core Stack

**Status:** Accepted

## Decision

Use TypeScript with PostgreSQL persistence through Prisma and durable background work through BullMQ + Redis for the initial implementation.

Baseline application stack:

- Next.js 16 / React 19 dashboard/API surface;
- TypeScript strict mode;
- Prisma 7 + PostgreSQL;
- BullMQ 5 + ioredis/Redis;
- Vitest for unit/integration tests;
- Zod (or equivalent strict schema validation) at external/LLM boundaries.

## Why

OpenSetter, our strongest AI-setter upstream reference, already uses Prisma 7, BullMQ 5 and ioredis. Keeping these choices materially reduces adaptation/rewrite cost while satisfying our durable-delay and transactional persistence requirements.

wacrm remains a WhatsApp implementation reference but its Supabase-centric persistence/auth model does not justify replacing the core stack merely for consistency with that repository.

## Consequences

- selected OpenSetter modules can be adapted with less infrastructure churn;
- BullMQ workers are separate long-running processes from webhook/API handlers;
- Redis is coordination/scheduling infrastructure, not the durable conversation source of truth;
- PostgreSQL remains authoritative for conversation, draft, delivery and audit state;
- hosting must support long-running workers (or workers must be deployed separately from serverless web functions).

## Not decided here

- managed PostgreSQL vendor;
- managed Redis vendor;
- authentication library/provider;
- exact deployment provider.
