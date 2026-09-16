# Task Contract — P5-06 Claude

**Issue:** #32 `[P5-06] Build Style Training and verified example library`  
**Branch:** `feat/p5-06-style-training`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Phase 2 style storage/retrieval APIs are accepted.

## Read first
`PROJECT_CONTEXT.md`, `KNOWLEDGE_STYLE_UX.md`, `RETRIEVAL.md`, ADR-011, Issue #32.

## Objective
Build style instructions and verified example management without letting style become factual authority.

## Required scope
- tone/length/emoji/greeting/sign-off/preferred/avoided language profile;
- verified example library with inbound context + human response;
- provenance `HUMAN_TYPED | HUMAN_EDITED_DRAFT`;
- suggested-example approve/reject;
- workspace/account scope;
- style test surface;
- archive/restore/audit.

## Hard invariants
Only verified human examples become active. Style cannot authorize factual claims. Suggested examples require deliberate activation. All data is workspace scoped.

## Verification
Test provenance, approval gating, scope isolation, archive/restore, style test and factual/style separation. Run root checks; open PR; do not merge.