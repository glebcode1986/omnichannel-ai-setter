# Claude Execution Queue

> Read `docs/handoff/CURRENT_HANDOFF.md` first.
> GitHub issues/specs are authoritative; chat is not.

## Current state — 2026-09-21

Stage B and Stage C are implemented, but independent review is currently blocked at **PR #51** again because of a newly discovered worker failure-safety defect.

### Exact review history that matters

- #49 — Astra PASS
- #50 — Astra PASS
- #51 schedule-clamp fix — PASS at `1fb13b1aef0dd8dac5d905a4af7169f9735a7ef6`
- #52 verification-log fix — PASS at `cbf6e119628bd924c8c59ff39949b3f839808349`
- later parent changes moved current descendant HEADs
- current #51 HEAD `b5063ab67e556132e9afbe5f006edebeb7714349` — **CHANGES_REQUESTED**

## ACTIVE NOW — explicit restart

Claude has been explicitly told to resume PR #51 R3 now.

Astra watcher has been explicitly told:
- do not re-review the currently rejected `b5063ab...`;
- wait for the next new `CLAUDE_READY_FOR_ASTRA ... task=P1-04`;
- then re-review #51 and continue strict dependency order on PASS.

PR #63 already has its own R2 scope/Human-Agent repair at `628c6026d151b613ba02be17beb7a4175cbfa579`, propagated through #72; keep it intact while #51 is fixed.

## NEXT TASK — PR #51 R3 failure-safety correction

Current bad rule:
a process-wide unhandled rejection is considered survivable when:
- it carries a generic connection-level error code; and
- one of the worker's Redis clients is currently not ready.

This does not identify the rejection's source. An unrelated PostgreSQL/HTTP/pipe/etc. failure with the same code during a Redis outage can be incorrectly ignored.

### Required fix

1. Global `uncaughtException` = fatal.
2. Global `unhandledRejection` = fatal after value-safe logging.
3. Remove process-wide Redis-outage survivability inference.
4. Handle the known BullMQ/ioredis reconnect rejection at the actual owned promise/emitter boundary.
5. If ownership cannot be proven, fail/restart rather than guess.
6. Preserve secret-safe logs.
7. Add child-process adversarial regression:
   - Redis unreachable;
   - unrelated rejection uses the SAME network error code;
   - unrelated rejection must still exit 1.
8. Also pin code-less unrelated rejection and healthy-Redis same-code rejection as fatal.

Directive is posted on PR #51.

Publish:
`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P1-04`

Astra re-reviews #51 first.

## Propagation rule

Do **not** blindly propagate another rejected #51 implementation.

After Astra PASS on the new exact #51 HEAD, propagate with normal merges through:

#52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72.

No rebase, no force-push, no merge to main.

## Stage D stop condition

Do not open Stage D UI PRs until the current #51 failure-safety blocker is resolved and review is moving cleanly again.

## Mutation-test correction

Earlier P2-04 through P2-07 mutation scores were invalid because the scratch harness ran on a red baseline and cross-package imports could resolve to original unmutated source.

The harness has been repaired and now refuses to run unless baseline is green. Real survivors were re-run and genuine test gaps were closed.

Do not quote old mutation counts as evidence.

## Next feature train after review-safe Stage B/C

Stage D Design Partner UI, then WhatsApp, privacy/security, commercial billing, Admin Operations and Launch Readiness per Master Issue #61.

## Hard invariants

- tenant + Business Profile isolation
- human activity wins
- no stale send
- no blind retry after ambiguity
- no early delivery
- unknown invariants fail closed
- provider timing/window revalidation
- queues are not sole durable intent
- model output advisory
- secrets never enter prompts/client output/normal logs/plaintext audit
