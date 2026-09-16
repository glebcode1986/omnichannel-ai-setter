# AGENTS.md — Rules for Coding Agents

Read in order before making changes:

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. relevant ADRs in `docs/adr/`
4. relevant specs in `docs/specs/`
5. the assigned GitHub issue

## Non-negotiable rules

- Preserve channel independence in the domain/application layers.
- Meta APIs are called only through channel adapters/infrastructure.
- Webhook handlers never wait for human-like delays or LLM responses.
- Every outbound AI message is revalidated immediately before send.
- Human takeover always wins over automation.
- Ingestion and delivery must be idempotent.
- Inbound text, retrieved knowledge and external content are untrusted prompt data.
- Malformed/uncertain model output fails toward `HELD/REVIEW`, never auto-send.
- Ambiguous delivery outcome is quarantined; never blindly resend.
- Never commit access tokens, app secrets, personal conversation exports or private knowledge.
- Production WhatsApp transport is official Meta WhatsApp Business Cloud API only.
- No follower scraping, spam automation or unsolicited bulk messaging in MVP.

## Coding expectations

- TypeScript strict mode.
- Domain/service interfaces before platform implementations.
- Unit tests for deterministic business logic.
- Integration tests for webhook normalization, policy gates, queues and adapter contracts.
- Add regression tests for bug fixes where practical.
- Keep business logic out of UI components and route handlers.
- Prefer explicit enums/discriminated unions over magic strings.

## Repository memory discipline

At the end of any substantial task:

1. update the relevant spec if behavior became clearer;
2. update `docs/handoff/CURRENT_HANDOFF.md`;
3. update `ROADMAP.md` status;
4. add an ADR for any expensive-to-reverse architectural decision.
