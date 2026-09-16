# Task Contract — P5-01 Claude

**Issue:** #27 `[P5-01] Build app shell and resumable onboarding`  
**Branch:** `feat/p5-01-app-shell-onboarding`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Phase 1 Auth.js/workspace membership and app scaffold are accepted. Integrate only channel connection APIs that are stable at implementation time.

## Read first
`PROJECT_CONTEXT.md`, `docs/handoff/CURRENT_HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`, `docs/specs/PRODUCT_UX.md`, `docs/specs/ONBOARDING_UX.md`, `docs/specs/PHASE5_IMPLEMENTATION_PLAN.md`, Issue #27.

## Objective
Build the authenticated workspace shell and resumable onboarding without implementing unrelated inbox/AI backend logic.

## Required scope
- primary navigation shell;
- workspace selection/context;
- resumable onboarding state and steps;
- channel connection cards/status surfaces;
- activation checklist;
- responsive/mobile navigation baseline;
- server-authorized role restrictions for settings/connection actions.

## Forbidden
Do not implement #28+ feature surfaces beyond placeholders needed for navigation. Do not invent provider credentials, send logic, AI policy, or duplicate channel onboarding backends.

## Verification
Test workspace isolation, OWNER/ADMIN vs MEMBER behavior, onboarding resume/reload, optional single-channel launch, incomplete connection states, activation gating, secret non-rendering, keyboard navigation and responsive shell. Run root lint/typecheck/test/build.

Open focused PR to `main`; do not merge.