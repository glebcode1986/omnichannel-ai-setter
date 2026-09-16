# Task Contract — P5-08 Claude

**Issue:** #34 `[P5-08] Build operational Analytics and searchable Audit`  
**Branch:** `feat/p5-08-analytics-audit`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Event/audit/AI usage/delivery/lead telemetry and workspace authorization are stable.

## Read first
`PROJECT_CONTEXT.md`, `LEADS_ANALYTICS_UX.md`, `PHASE5_IMPLEMENTATION_PLAN.md`, Issue #34.

## Objective
Build operational analytics and material-action audit surfaces with correct state semantics.

## Required scope
- inbound volume, response time, draft/send/review/skip/takeover, review reasons, lead movement, provider failures/ambiguity, missing-fact and usage/cost metrics when available;
- date/channel/account/mode/lead/assignee filters;
- documented metric definitions;
- explicit scheduled/accepted/delivered/read distinctions;
- searchable append-oriented audit log;
- role-gated sensitive audit access.

## Hard invariants
Do not infer delivered/read from application acceptance. Metrics must remain workspace scoped and timezone definitions explicit. Audit rows are not silently editable.

## Verification
Test aggregation boundaries, timezone/date filtering, isolation, state distinction, audit search/immutability expectations and authorization. Run root checks; open PR; do not merge.