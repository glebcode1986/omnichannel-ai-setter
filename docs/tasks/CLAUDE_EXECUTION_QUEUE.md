# Claude Execution Queue

> Read `docs/handoff/CURRENT_HANDOFF.md` first.
> GitHub issues/specs are authoritative; chat is not.

## Current state — 2026-09-21 evening

Independent review has advanced through PR #64.

Accepted:
- #51 PASS `b6e17347a91b4ce4552ce2251a3f5af05df67dfc`
- #52 PASS `182150bc10a01eba0b9eaa57eb44c036b8e225d8`
- #63 PASS `cd04a9972d25f8cf20edd57c5753c325130ee4de`
- #64 PASS `f0dee940a1baf0f3c8d8615ef2090587bf2def01`

## P2-03 — ACCEPTED

Current corrected HEAD:
`ed3a7b0f1ed56ae36bce9f903db47fd7202aba12`

Previous Astra blocker:
repair-stage model outage was incorrectly converted into a permanent HELD invalid-output draft, consuming the idempotent generation key.

Current fix:
- repair returns explicit ATTEMPTED vs UNAVAILABLE;
- repair outage -> UNAVAILABLE;
- no draft write;
- queue retry remains possible;
- one bounded repair preserved.

Astra accepted this exact SHA:
`ASTRA_REVIEW: PASS head=ed3a7b0f1ed56ae36bce9f903db47fd7202aba12`.

## Claude action on verdict

### If PASS
Propagate accepted #65 normally through:

#66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72

For each child:
- merge parent normally;
- run required verification;
- publish fresh exact `CLAUDE_READY_FOR_ASTRA`;
- do not rebase/force-push;
- do not merge to main.

Then stand by for the next Astra blocker.

### If CHANGES_REQUESTED
Fix #65 itself first.
Do not propagate the rejected implementation.

## Downstream heads are stale until accepted #65 propagation

#66 `ac7abda2dd860e729f3d520245cb52c7bb63b886`
#67 `31f16449278fc9f871935b4316249295bbe7a866`
#68 `8fef94d2172e3c75075457b7ad6d84a6096aa761`
#69 `ebe10c7d51b13176e8da0a66b2518e8447563ecc`
#70 `120b3a1be28cded029025701376934c4a40326b0`
#71 `e995f3c36cb83ab29dcfb7c6f98cbafe382a9312`
#72 `def2e0711b64ab46c185d7e863039102ae66f340`

## Stop condition

Do not open Stage D until the independent review queue has moved safely through the current Stage B/C stack.

## Hard invariants

- tenant + BP isolation
- human activity wins
- no stale send
- no blind retry after ambiguity
- no early delivery
- unknown invariants fail closed
- transient infrastructure/provider failure stays retryable and must not become permanent customer state
- queues are not sole durable intent
- model output advisory
- secret-safe logging


## ACTIVE NOW — propagate accepted P2-03 into P2-04

Claude is explicitly instructed to:
1. normal-merge accepted #65 into #66;
2. verify #66;
3. publish fresh `CLAUDE_READY_FOR_ASTRA ... task=P2-04`;
4. continue propagation through #67 -> #72.

Astra watcher is explicitly instructed to ignore the stale #66 HEAD and review only the first fresh propagated P2-04 HEAD.

If #66 passes, continue strict dependency order through #72.

No Stage D yet.
