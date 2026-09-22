# Current Handoff

**Last updated:** 2026-09-21 evening  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Implementation:** Stage B complete; Stage C reliability implemented  
**Independent review position:** PR #66 / P2-04 is CHANGES_REQUESTED at `061b7af36620713c00324a8982667f2477bb3e35`
**Active now:** Claude has a focused P2-04 language-wiring fix directive; hourly Astra/Claude watch is active
**Stage D:** paused

> **NEW CHAT / NEW AGENT: START HERE.**  
> GitHub is canonical project memory. Fetch live PR HEADs before acting.

## Read order

1. `PROJECT_CONTEXT.md`
2. this file
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. Master Issue #61
7. current PR / issue / task contract
8. relevant specs / ADRs

## Review progress

Accepted in current dependency chain:
- PR #49 — PASS
- PR #50 — PASS
- PR #51 — PASS at `b6e17347a91b4ce4552ce2251a3f5af05df67dfc`
- PR #52 — PASS at `182150bc10a01eba0b9eaa57eb44c036b8e225d8`
- PR #63 — PASS at `cd04a9972d25f8cf20edd57c5753c325130ee4de`
- PR #64 — PASS at `f0dee940a1baf0f3c8d8615ef2090587bf2def01`

### What #64 fixed before PASS
Astra found two credential-lifecycle problems:
- disconnect was not atomic with credential destruction;
- refresh could resurrect a revoked token.

Claude made disconnect transactional and made refresh fail closed after revocation.

Astra then found a reconnect regression: the account could become CONNECTED while its credential stayed revoked. Claude separated human reauthorization/restoration from ordinary rotation, protected against stale refresh, and Astra accepted #64.

## PR #65 / P2-03 — PASS

Previous reviewed HEAD:
`af2ba698819532ff860e84ff98ad648b5ece36bc`

Astra found that:
1. first model output is malformed;
2. repair attempt hits transient provider unavailability;
3. code incorrectly persisted a permanent `HELD / INVALID_MODEL_OUTPUT` draft;
4. generation idempotency then prevented a later retry from replacing it.

Claude fixed the owning PR.

Current exact HEAD:
`ed3a7b0f1ed56ae36bce9f903db47fd7202aba12`

Fix:
- repair returns a discriminated outcome;
- repair-stage provider outage returns `UNAVAILABLE`;
- no draft is written;
- idempotency key remains available for a later queue retry;
- bounded one-repair behavior remains intact;
- malformed/refusal/valid repaired outcomes remain distinct.

Claude verification reported:
- `pnpm verify` 580 passed;
- `pnpm test:e2e` 28 passed;
- migration drift 0;
- lint/boundaries clean.

Astra independently accepted this exact SHA:

`ASTRA_REVIEW: PASS head=ed3a7b0f1ed56ae36bce9f903db47fd7202aba12`

Claude propagated the accepted parent through #66 -> #72 and published fresh exact heads.

## Active commands posted

On PR #65:

### Astra
Re-review exact HEAD `ed3a7b0f1ed56ae36bce9f903db47fd7202aba12`.

If PASS, wait for Claude to propagate accepted parent, then continue:
#66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72.

Do not review stale downstream HEADs before propagation.

### Claude
Stand by on the #65 verdict.

- PASS -> normal-merge accepted #65 through #66 -> #72, verify each, publish fresh exact markers.
- CHANGES_REQUESTED -> fix #65 itself first; do not propagate rejected code.

No rebase, no force-push, no merge to main, no Stage D yet.

## Current propagated downstream heads

All of these now contain the accepted #65 parent:

- #66 `061b7af36620713c00324a8982667f2477bb3e35`
- #67 `f3151481652593c50cf484cf6325f159b5d8197b`
- #68 `4ae263b0270bd56663557332c15d5e0a87950524`
- #69 `26490142964ac737df0540f7154aa2d7af27b2d9`
- #70 `4dc3367a510c5368f64ec51bb000d419242999fb`
- #71 `5710098ab098769a0618e8c164d5bd2fb3e7d616`
- #72 `b7f7411da74aab6c8966790650f2abf4eda17c59`

## Implementation status

### Stage B implemented
Instagram transport/onboarding, AI draft engine, factual/style retrieval, deterministic policy, delivery coordinator, human handoff/Review, eval harness, Instagram E2E.

### Stage C implemented
Reliability/health, scoped kill switches, backpressure, reconciliation, incident state and safe recovery.

Latest propagated Stage C verification before current #65 fix reported 910 passing tests on #72. This is implementation evidence, not independent acceptance of the whole stack.

## Remaining path after review-safe Stage B/C

Stage D — Design Partner UI  
Stage E — WhatsApp  
Stage F — privacy/security/export/retention/deletion  
Stage G — billing/entitlements  
Stage H — Admin Operations  
Stage I — Launch Readiness / staged Commercial Beta

## Hard invariants

- Workspace + Business Profile isolation.
- Human activity wins over AI.
- No stale send.
- No blind retry after ambiguous write.
- No early delivery.
- Unknown invariants fail closed.
- Transient provider outage must remain retryable, not be converted into permanent business state.
- Provider/webhook/job idempotency.
- Model output advisory; application policy authoritative.
- Secrets never enter prompts, client output, normal logs or plaintext audit.


## Current blocker — PR #66 / P2-04

Astra reviewed exact HEAD:
`061b7af36620713c00324a8982667f2477bb3e35`

Verdict:
`ASTRA_REVIEW: CHANGES_REQUESTED head=061b7af36620713c00324a8982667f2477bb3e35`

Blocking gap:
- SQL/db retrieval already supports optional `RetrievalQuery.language`;
- canonical P2-04 contract requires Style language filtering with requested-language + NULL fallback;
- production `DraftRetrievalQuery` does not carry language;
- worker calls retrieval without language, so live multilingual Style retrieval effectively runs with `language=undefined` and can return the wrong-language examples.

Required fix is posted on PR #66:
- carry normalized BCP-47-compatible language from the authoritative resolved StyleProfile / approved source through application -> worker -> retrieval;
- requested language keeps matching + NULL examples and excludes other explicit languages;
- no language preserves the full eligible Style corpus;
- Knowledge behavior and tenant/BP boundaries remain unchanged;
- add production-path regressions proving the language value is actually forwarded end-to-end.

After Claude publishes a new exact P2-04 HEAD, Astra re-reviews #66 first. Only after PASS should the correction propagate through #67 -> #72.

An hourly condition watch is active to inspect the repository, issue the next Claude/Astra directive when state changes, update canonical handoff/queue, and notify the user only on meaningful changes.
