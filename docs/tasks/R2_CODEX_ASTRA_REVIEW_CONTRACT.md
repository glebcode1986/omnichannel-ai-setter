# Review Contract — R2 Codex/Astra

**Issue:** #17 `[R2] Codex/Astra independent Phase 2 safety and architecture review`  
**Executor:** Codex/Astra as independent reviewer/test author.  
**Scope:** review #8–#16 incrementally; do not rubber-stamp Claude.

## Mandatory reading
Read `PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, relevant Phase 2 specs/ADRs and the task contract before reading Claude's explanation of its PR.

## Required review targets

### Boundary integrity
- Meta/provider types remain in adapter/provider packages;
- no channel/provider implementation leaks into pure domain/application contracts;
- LLM/model output has no direct transport authority.

### Instagram policy
- current Meta scopes/window/Human Agent behavior is re-verified where required;
- `STANDARD_ONLY` and `HUMAN_ASSISTED_EXTENDED` match ADR-014;
- no background path silently attaches `HUMAN_AGENT`;
- human-assisted send has explicit audited human actor/action and revalidation.

### Retrieval/AI safety
- factual/style corpora remain separated;
- workspace/account isolation on all retrieval paths;
- prompt injection cannot override product/policy boundaries;
- missing fact/retrieval outage fail safely;
- provider malformed output cannot escape schema validation.

### Delivery/concurrency
- final pre-send revalidation is authoritative;
- two workers cannot double-send;
- newer inbound/takeover/policy change supersedes pending delivery;
- `AMBIGUOUS` is quarantined, never blindly retried;
- stale `SENDING`/restart recovery is safe;
- own echo vs human manual echo correlation is adversarially tested.

### Data/security
- credentials/secrets never leak to logs/client URLs;
- PII logging is minimized/redacted;
- tenant boundaries hold under malformed IDs and concurrent activity.

## Independent test additions
Prioritize adversarial cases Claude may miss: replayed webhook, reordered status/echo events, delayed human reply racing worker claim, token expiry mid-send, retrieval outage, prompt injection in trusted-looking source text, Human Agent eligibility expiry, and provider timeout after request write.

## Review output
For each PR return `PASS` or `CHANGES_REQUESTED` with exact evidence. Systemic architecture gaps require a spec/ADR amendment; do not patch around them silently.

## Merge rule
The final P2-09 vertical slice must not merge with unresolved R2 findings on policy, security, tenant isolation, ambiguity or duplicate-send risk.
