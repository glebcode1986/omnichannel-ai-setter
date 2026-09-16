# Task Contract — P5-05 Claude

**Issue:** #31 `[P5-05] Build versioned Knowledge Library and retrieval tester`  
**Branch:** `feat/p5-05-knowledge-library`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Phase 2 factual knowledge/retrieval persistence and APIs are accepted.

## Read first
`PROJECT_CONTEXT.md`, `KNOWLEDGE_STYLE_UX.md`, `RETRIEVAL.md`, ADR-011, Issue #31.

## Objective
Build factual knowledge management with versioned provenance and retrieval-only testing.

## Required scope
- list/search/filter sources;
- create/edit/version/archive/restore facts, FAQs and pasted text;
- workspace/account scope;
- indexing status/errors;
- factual retrieval tester with provenance;
- `MISSING_FACT -> Add to knowledge` confirmation flow;
- stale/superseded source display.

## Hard invariants
Style/chat text is never automatically factual knowledge. Editing creates auditable versions. Failed ingestion cannot look active. All reads/writes are workspace scoped.

## Verification
Test versions, archive/restore, scope isolation, retrieval tester, indexing failure, missing-fact confirmation and factual/style separation. Run root checks; open PR; do not merge.