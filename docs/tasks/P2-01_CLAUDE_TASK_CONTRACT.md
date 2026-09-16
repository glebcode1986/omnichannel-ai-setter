# Task Contract — P2-01 Claude

**Issue:** #8 `[P2-01] Implement Instagram transport adapter and fixture suite`  
**Branch:** `feat/p2-01-instagram-adapter`  
**Start condition:** Phase 1 exit criteria complete.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`, `INSTAGRAM_ADAPTER.md`, `CHANNEL_CONTRACTS.md`, ADR-006/012/013/014, `META_INSTAGRAM_PHASE2_VERIFICATION.md`, Issue #8.

## Objective
Implement `packages/channel-instagram` against the frozen `ChannelAdapter` contract using official Instagram API with Instagram Login.

## Required behavior
- webhook challenge/signature verification and deterministic normalization;
- inbound text, supported status/reaction/postback events, outbound echoes;
- correlate known app-originated echoes vs unmatched human/manual echoes;
- standard text send -> normalized `ACCEPTED | REJECTED | AMBIGUOUS`;
- separate standard automated-window evaluation from Human Agent eligibility;
- separate explicitly-human Human Agent send capability/path when approved;
- background/autopilot path must never silently apply `HUMAN_AGENT`;
- unsupported media is represented safely and held/escalated when core cannot understand it.

## Constraints
Provider-specific request/response types stay inside `packages/channel-instagram`. No LLM, retrieval, delay, lead logic or product-policy decisions in the adapter.

## Tests
Fixture-driven coverage for malformed/duplicate inbound, own echo, unmatched manual echo, status, accepted send, definite rejection, network ambiguity, standard-window closed, Human-Agent eligible/blocked/expired, unsupported media.

## PR requirements
Re-verify current Meta API version, scopes, webhook fields, window/Human Agent requirements in the PR. Update verification docs if current Meta behavior differs. Run root lint/typecheck/test plus package tests. Do not merge.
