# Task Contract — P5-07 Claude

**Issue:** #33 `[P5-07] Build Leads pipeline and qualification workspace`  
**Branch:** `feat/p5-07-leads-pipeline`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Contact/Conversation/LeadState APIs and audit persistence are stable.

## Read first
`PROJECT_CONTEXT.md`, `LEADS_ANALYTICS_UX.md`, `PRODUCT_UX.md`, relevant data-model specs, Issue #33.

## Objective
Build lightweight conversation-linked CRM/lead workflow.

## Required scope
- configurable display stages over stable internal IDs;
- kanban + table views;
- qualification fields, assignee, tags/notes, next action;
- stage history/source actor;
- inbox-side lead editing;
- shared audited stage-transition API for drag/drop and direct edits.

## Hard invariants
AI suggestions remain distinct from human-confirmed values. Stale drag/drop must not overwrite newer state silently. Workspace isolation and audit apply to every transition.

## Verification
Test stage config, isolation, AI suggestion vs confirmation, concurrent/stale transitions, conversation sync, audit, responsive/table fallback and authorization. Run root checks; open PR; do not merge.