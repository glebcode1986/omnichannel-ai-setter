# Phase 5 Implementation Plan — SaaS Product UX

**Status:** Product UX architecture prepared. Implementation may begin incrementally once the required Phase 1/2 backend contracts exist.

## Goal

Turn the omnichannel engine into a usable multi-tenant SaaS for non-technical business owners and operators.

## Work packages

### P5-01 — App shell + resumable onboarding
Authenticated workspace shell, navigation, channel connection cards, setup checklist and resumable onboarding state.

### P5-02 — Unified Inbox
Cross-channel conversation list/search/filter and three-pane desktop / stacked mobile experience.

### P5-03 — Conversation operations + Review Queue
Thread, composer, effective AI mode, pending delivery, takeover controls, AI review items and explicit approve/edit/reject/send actions.

### P5-04 — AI Settings + Simulation Playground
Behavior, review posture, timing, takeover policy, channel-specific after-window modes, and no-send simulation.

### P5-05 — Knowledge Library
Versioned factual sources, ingestion/index state, retrieval tester and missing-fact-to-knowledge workflow.

### P5-06 — Style Training
Style profile, verified examples, provenance, suggestion approval and style test surface.

### P5-07 — Leads Pipeline
Conversation-linked lead record, qualification fields, stage history, kanban/table and inbox side panel.

### P5-08 — Analytics + Audit
Operational metrics, filters, provider/application-state distinctions and append-oriented material action log.

### P5-09 — Product UX E2E + accessibility/responsiveness
Full onboarding -> setup -> inbox -> review -> lead flow, keyboard/mobile/accessibility states, loading/error/empty/offline-ish recovery UX.

### R5 — independent Codex/Astra UX/data-boundary review
Focus on tenancy, authorization, stale UI actions, race conditions, accessibility, policy-bypass attempts and misleading provider state.

## Dependency guidance

```text
Phase 1 auth/workspace + domain stable
        |
        +--> P5-01 shell/onboarding foundation
        |
        +--> P5-02 inbox shell once conversation APIs exist

Phase 2 policy/delivery/handoff stable
        +--> P5-03 review/conversation operations
        +--> P5-04 AI settings/playground
        +--> P5-05 knowledge
        +--> P5-06 style
        +--> P5-07 leads
        +--> P5-08 analytics/audit

P5-01..08 --> P5-09 E2E
R5 reviews incrementally.
```

Phase 5 does not need to wait for every WhatsApp feature. The UI must render capabilities conditionally and can ship first with Instagram-backed data, then expose WhatsApp states when Phase 4 is available.

## Cross-cutting requirements

- server-side workspace authorization for every mutation/query;
- optimistic UI never bypasses authoritative policy/revalidation;
- stale review/send actions fail safely with a clear refresh reason;
- channel/account capability differences are visible but do not fork the whole product UI;
- no secrets/tokens rendered after storage;
- accessibility: keyboard operation, focus states, semantic labels, reduced-motion compatibility where relevant;
- responsive Inbox and Review workflows;
- test fixtures do not require production Meta credentials.

## Phase 5 exit criteria

A workspace owner can sign in, complete onboarding, connect/configure available channels, add knowledge/style guidance, test AI behavior, operate unified conversations, review/approve/edit replies, take over/resume conversations, manage leads, and inspect operational metrics/audit — with all actions respecting workspace roles and shared policy/delivery rules.
