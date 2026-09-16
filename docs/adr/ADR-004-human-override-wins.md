# ADR-004: Human Override Wins

**Status:** Accepted

## Decision

A verified manual human reply pauses/cancels AI automation for that conversation according to configurable takeover policy.

## Why

The system assists an owner/team and must never race or contradict a human operator.

## Consequences

- scheduled AI sends are cancelled where possible;
- final send gate blocks stale jobs even if cancellation races;
- API-sent echoes must be distinguished from genuine human replies;
- takeover state is auditable and visible in inbox UI.
