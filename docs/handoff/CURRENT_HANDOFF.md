# Current Handoff

**Last updated:** 2026-09-21 evening  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Implementation:** Stage B complete; Stage C reliability implemented  
**Independent review position:** PR #65 / P2-03 is accepted; next review target is propagated PR #66 / P2-04  
**Active now:** Claude propagating accepted #65 through #66 -> #72; Astra watcher armed on #66  
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

Claude is now explicitly re-started to propagate the accepted parent through #66 -> #72.

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

## Current downstream live heads before P2-03 propagation

These are **stale relative to the corrected #65 HEAD** and must not be independently accepted until propagation:

- #66 `ac7abda2dd860e729f3d520245cb52c7bb63b886`
- #67 `31f16449278fc9f871935b4316249295bbe7a866`
- #68 `8fef94d2172e3c75075457b7ad6d84a6096aa761`
- #69 `ebe10c7d51b13176e8da0a66b2518e8447563ecc`
- #70 `120b3a1be28cded029025701376934c4a40326b0`
- #71 `e995f3c36cb83ab29dcfb7c6f98cbafe382a9312`
- #72 `def2e0711b64ab46c185d7e863039102ae66f340`

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


## Next review target — PR #66 / P2-04

The currently visible #66 HEAD is stale relative to the accepted #65 correction.

Claude has been explicitly instructed to normal-merge the accepted #65 HEAD into #66, verify, and publish a fresh:

`CLAUDE_READY_FOR_ASTRA head=<new-sha> task=P2-04`

Astra watcher has been armed on #66 and must wait for that **new propagated HEAD** before reviewing.

If #66 passes, continue strict dependency order:
#67 -> #68 -> #69 -> #70 -> #71 -> #72.
