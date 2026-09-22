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

## Current propagated heads

#66 `061b7af36620713c00324a8982667f2477bb3e35`
#67 `f3151481652593c50cf484cf6325f159b5d8197b`
#68 `4ae263b0270bd56663557332c15d5e0a87950524`
#69 `26490142964ac737df0540f7154aa2d7af27b2d9`
#70 `4dc3367a510c5368f64ec51bb000d419242999fb`
#71 `5710098ab098769a0618e8c164d5bd2fb3e7d616`
#72 `b7f7411da74aab6c8966790650f2abf4eda17c59`

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


## ACTIVE NOW — fix P2-04 language wiring

Astra returned:
`ASTRA_REVIEW: CHANGES_REQUESTED head=061b7af36620713c00324a8982667f2477bb3e35`

Current blocker:
the db retriever supports `RetrievalQuery.language`, but `DraftRetrievalQuery` and the live worker path drop the language, so Style language matching/fallback is not active in production.

Claude directive already posted:
- carry normalized BCP-47-compatible language from the approved StyleProfile/source through the real application/worker retrieval path;
- requested language -> matching explicit language + NULL fallback;
- exclude other explicit languages;
- no requested language -> full eligible Style corpus;
- preserve Knowledge semantics, explicit override rules, tenant/BP isolation, and lexical-only embedding degradation;
- add end-to-end production-path regressions.

Publish:
`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P2-04`

Do not propagate the rejected #66 implementation farther. After Astra PASS, propagate only the accepted correction through #67 -> #72.

Hourly review/build watch is active and may issue the next Claude/Astra directive when repository state materially changes.

