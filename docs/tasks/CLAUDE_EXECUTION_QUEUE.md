# Claude Execution Queue

> Read `docs/handoff/CURRENT_HANDOFF.md` first.
> GitHub issues/specs are authoritative; chat is not.

## Current state — 2026-09-26

Independent review is accepted through PR #68 / P2-06.

Current blocker:
PR #69 / P2-07 at
`d8b56c91d710a435e7b2614f69fcd39297357f68`

Astra:
`ASTRA_REVIEW: CHANGES_REQUESTED head=d8b56c91d710a435e7b2614f69fcd39297357f68`

## ACTIVE NOW — fix P2-07 durable human delivery authority

Problem:
Review approval receives actor + reviewMode but drops them before durable delivery. The queued job is later executed as AUTOMATED, so normal reviewed DRAFT sends and Human Agent reviewed sends are broken/race-dependent.

Claude directive is posted on PR #69.

Required result:

1. Persist delivery authority:
   - AUTOMATED or HUMAN_APPROVED
   - approved user id
   - approved timestamp
   - reviewed transport intent / NORMAL vs HUMAN_AGENT

2. Only authenticated USER can create HUMAN_APPROVED.

3. Review scheduling + HUMAN_ACTIVE takeover must be one atomic DB decision for APPROVE/EDIT.

4. Worker must load persisted authority; it must not hardcode AUTOMATED.

5. Final claim/revalidation must bind the authority/intent being used.

6. NORMAL reviewed-human DRAFT reply must send through the common coordinator while preserving human ownership.

7. HUMAN_AGENT reviewed reply requires:
   - durable HUMAN_APPROVED
   - durable HUMAN_AGENT intent
   - fresh live eligibility immediately before dispatch
   - exact recipient/conversation/scope binding

8. New inbound, newer human activity, expired eligibility/window, draft rewrite, policy/account change or stale operation must still fail closed.

9. Sent-message/audit provenance must record the real human/automated transport path.

10. Real DB + queue + coordinator E2E tests are required. Stub-only schedule tests are insufficient.

Publish after green:

`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P2-07`

## Astra watcher

Astra is explicitly instructed:
- do not re-review rejected `d8b56c91...`;
- wait for the next corrected P2-07 exact HEAD;
- then independently verify the durable-authority fix;
- PASS -> continue only after propagation to fresh #70 -> #72 heads;
- CHANGES_REQUESTED -> stop at #69.

## Current downstream heads — not independently cleared

- #70 `41a926047e10985e7e8a4ebbfd73f8094b8b253a`
- #71 `b0a606917a28b2702b88c061c22bfec96f6effdd`
- #72 `1f90fe1a532d88b11d72c592ff2288a81af08ba5`

After #69 PASS:
normal-merge #69 -> #70 -> #71 -> #72, verify each and publish fresh exact markers.

## Stop condition

Do not open Stage D until the Stage B/C independent review train clears through #72.

## Hard invariants

- tenant + BP isolation
- human activity wins
- HUMAN_APPROVED cannot be synthesized by automation
- no stale send
- no blind retry after ambiguity
- no early delivery
- unknown invariants fail closed
- queues are not sole durable intent
- model output advisory
- secret-safe logging
