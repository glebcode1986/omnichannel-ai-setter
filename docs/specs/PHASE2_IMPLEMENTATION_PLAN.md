# Phase 2 Implementation Plan — Instagram + AI Vertical Slice

**Status:** Architecture ready; implementation must wait for Phase 1 exit criteria.

## Goal

Create one safe end-to-end Instagram AI conversation path: official onboarding -> verified webhook -> normalized conversation -> AI draft -> deterministic policy -> human-like delayed delivery -> official Instagram send -> echo/status reconciliation -> human takeover.

## Work packages

- P2-01 Instagram transport adapter and fixture suite.
- P2-02 Instagram Login onboarding/token lifecycle.
- P2-03 provider-neutral AI draft engine.
- P2-04 factual + style retrieval.
- P2-05 deterministic policy engine.
- P2-06 delivery coordinator/final revalidation.
- P2-07 human handoff/takeover state machine.
- P2-08 evaluation harness and golden conversations.
- P2-09 Instagram end-to-end vertical slice.
- R2 independent Codex/Astra architecture, safety and regression review.

## Dependency graph

```text
Phase 1 exit
   |-----------------------------|
   v                             v
P2-01 Instagram adapter      P2-03 AI engine
   |                             |
   v                         P2-04 retrieval
P2-02 onboarding                 |
   |                         P2-05 policy
   |                             |
   +-----------> P2-06 delivery <+
                    |
                P2-07 handoff
                    |
                P2-08 evals
                    |
                P2-09 vertical slice

R2 reviews incrementally across all P2 work.
```

## Implementation rule

Claude owns one bounded implementation issue at a time. Codex/Astra independently reads specs before diffs and adds adversarial/concurrency tests rather than merely validating Claude's explanation.

## Phase 2 exit criteria

- a professional Instagram account can connect through the accepted login path without a Facebook Page dependency unless Meta requires otherwise at implementation time;
- webhook fixtures verify/normalize inbound messages, echoes and statuses safely;
- a text inbound conversation can generate a schema-valid draft using one configured model provider;
- factual/style retrieval are separate and provenance is persisted with the draft;
- DRAFT and AUTOPILOT modes follow deterministic policy gates;
- AUTOPILOT selects/stores a natural delay, revalidates immediately before send and cannot double-send under concurrency/retry;
- unmatched human/manual outbound activity pauses automation;
- ambiguous send outcomes are quarantined;
- an end-to-end fixture/integration suite covers duplicate inbound, newer-message supersession, human takeover, low confidence, missing fact, closed window and network ambiguity.
