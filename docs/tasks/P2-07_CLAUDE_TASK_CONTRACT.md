# Task Contract — P2-07 Claude

**Issue:** #14 `[P2-07] Implement human handoff and review state machine`  
**Branch:** `feat/p2-07-human-handoff`  
**Depends on:** #8 adapter, #12 policy, #13 delivery.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `HUMAN_HANDOFF.md`, ADR-004/013/014, `DELIVERY_COORDINATOR.md`, Issue #14.

## Objective
Implement review/takeover ownership independently from OFF/DRAFT/AUTOPILOT mode so real human activity always wins without confusing app-generated outbound echoes for humans.

## Required state semantics
At minimum preserve distinct states equivalent to:
- `NONE`
- `REVIEW_REQUIRED`
- `HUMAN_ACTIVE`

Store actor/reason/timestamps needed for audit and safe resume.

## Required behavior
- unmatched/native outbound echo -> verified human/manual takeover and pending automation becomes stale;
- correlated known app-originated echo -> does not falsely trigger takeover;
- explicit claim/pause/resume actions;
- optional timed-resume may only resume when guard conditions still hold;
- human-approved or human-edited AI draft uses the same delivery coordinator, not a bypass send path;
- human-edited final wording may become a style example with `HUMAN_EDITED_DRAFT` provenance but never factual knowledge;
- `HUMAN_ASSISTED_EXTENDED` exposes a deliberate human review/send action and rechecks current Human Agent eligibility immediately before send.

## Race tests
Native manual reply racing a pending worker; correlated own echo; explicit pause/resume; timed resume with newer human activity; edited-draft provenance; Human Agent eligibility expires while draft waits; two agents attempt to claim the same review item.

## PR requirements
Document state-transition table and actor/audit semantics. No UI convenience may bypass server-side ownership and delivery checks. Run root/concurrency tests. Do not merge.
