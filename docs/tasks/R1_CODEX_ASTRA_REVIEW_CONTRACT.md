# Review Contract — R1 Codex/Astra

**Executor:** Codex/Astra as independent reviewer/test author  
**Issue:** #7 `[R1] Codex/Astra independent Phase 1 architecture and regression review`  
**Scope:** review Phase 1 PRs/issues #2–#6 incrementally  
**Rule:** read specs before reading Claude's PR explanation.

## Purpose

Provide an independent engineering check of architecture boundaries, tenancy, idempotency, concurrency and failure safety. This role does not rubber-stamp Claude and does not implement Claude-owned feature scope unless a follow-up issue explicitly assigns it.

## Mandatory reading

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. relevant ADRs/specs for the PR under review
5. corresponding GitHub issue/task contract
6. only then inspect the PR diff and Claude's notes

## Required review dimensions

### Architecture

- dependency direction matches ADR-008;
- pure core packages do not import Next.js/Prisma/Meta/provider SDKs;
- provider-specific fields do not leak into channel-neutral core/application code;
- app composition edges own concrete infrastructure wiring.

### Tenancy/security

- every tenant data path has explicit workspace scope;
- cross-workspace reads/writes are adversarially tested;
- external payloads are runtime-validated;
- no secrets/real customer data are committed or logged unsafely.

### Idempotency/concurrency

- duplicate inbound event cannot create duplicate message/reply cycle;
- deterministic queue/job identities behave under retries/restarts;
- stale/superseded jobs fail closed;
- only one logical delivery can own/send a draft/action;
- ambiguous transport outcome never triggers blind resend.

### Webhook behavior

- verification happens before trusted processing;
- webhook/request lifecycle contains no LLM calls or human-like sleeps;
- fast ACK architecture is preserved;
- persistence/enqueue consistency has a recoverable strategy.

## Independent tests to add where useful

Prefer tests that the implementation author is least likely to have written:

- duplicate concurrent webhook delivery;
- simultaneous cross-workspace identifiers;
- two workers racing the same logical job/delivery claim;
- stale debounce waking after supersession;
- malformed event/job payloads;
- enqueue/persistence partial failure;
- simulated worker restart;
- ambiguous provider state represented without resend.

## Review output

For each PR produce one of:

- `PASS`
- `CHANGES_REQUESTED`

Every requested change must include exact evidence: file/path, violated contract/invariant, and preferably a failing regression test. Do not normalize systemic architecture drift by patching around it; propose an ADR/spec change for an actual design conflict.

## Merge rule

A Claude PR with unresolved architecture/security/idempotency findings must not be merged simply because its happy-path tests pass.
