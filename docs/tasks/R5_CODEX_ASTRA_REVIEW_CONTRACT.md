# Review Contract — R5 Codex/Astra

**Issue:** #36 `[R5] Codex/Astra independent SaaS UX and data-boundary review`

## Role
Independent reviewer/test author. Do not rely on Claude's PR narrative as evidence; read specs/contracts and inspect implementation behavior.

## Required review areas
- server-side workspace scope and role authorization for every UI read/mutation;
- stale/double review/send/policy actions;
- optimistic UI vs authoritative delivery/provider states;
- secret/token redaction;
- Knowledge/Style separation;
- no unsafe bulk customer-send review workflow;
- Instagram human-assisted action remains explicitly human initiated;
- WhatsApp template autopilot requires explicit mode + allowlist;
- audit coverage for policy/lead/review/takeover/material changes;
- accessibility, keyboard/focus and responsive critical paths;
- multi-tab/concurrent operator races and retry/double-submit behavior.

## Adversarial cases
Cross-workspace IDs, stale review/action version, double approve, human takeover racing approval, account disconnect during compose, policy change in another tab, allowlist removal before send, archived knowledge source in stale UI, lost network after action submission, malformed filters/query state.

## Deliverable
For each Phase 5 PR: `PASS` or `CHANGES_REQUESTED`, exact evidence, and independent regression tests where practical. Systemic gaps require spec/ADR correction rather than client-side masking.