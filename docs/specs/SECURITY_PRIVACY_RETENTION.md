# Security, Privacy, Retention & Deletion — Product Contract

**Status:** Accepted product/architecture contract for MVP implementation.

## Core principle

Collect only data useful to the product, preserve provenance, restrict visibility, minimize what reaches LLMs/logs/exports, support real correction/deletion, and audit sensitive access/actions.

## Authorization boundary

Every customer-owned request is authorized server-side through:

`authenticated user -> Workspace membership -> role -> Business Profile scope -> action permission`

Client/UI state is never authoritative. Search/list endpoints must not reveal whether unauthorized records exist.

Workspace is the top tenant/billing boundary. Business Profile is the default operational/customer-data/privacy boundary. Cross-BP customer identity, memory and search are disabled by default.

Removed members lose current access immediately. Historical audit/action attribution remains as a former member identity rather than being rewritten.

## Data classes

Keep policy distinctions between at least:
- conversation/customer content;
- customer memory/facts/preferences;
- Business Knowledge/Style;
- operational state/jobs/events;
- audit/security records;
- billing/legal records;
- secrets/credentials.

Each class may have different access, retention and deletion behavior.

## Secrets

Provider tokens/API credentials/signing secrets are encrypted or stored behind encrypted references server-side.

Secrets must never appear in:
- LLM prompts/context;
- normal application logs;
- customer exports;
- plaintext audit records;
- client-rendered settings after initial one-time secret creation where applicable.

Rotation/revocation is explicit and audited.

## Customer memory

Durable memory is structured, useful customer information with source/provenance and freshness. It is not a speculative psychological dossier.

Durable memory may include explicit facts/preferences relevant to service. Do not store inferred wealth, vulnerability, loneliness, manipulability, political persuasion traits, or similar profiling for sales manipulation.

A customer correction/forget/delete operation must stop future AI use of the corrected/deleted fact and remove/supersede platform-controlled derived retrieval/index entries.

AI-generated reply text is not authoritative provenance for a customer fact.

## Knowledge / derived indexes

Deleted, archived, superseded or expired trusted Knowledge must be excluded from retrieval. Stale embeddings/search indexes must be removed or made unreachable as part of the version/deletion lifecycle.

Search/vector indexes are derived data; the durable business/customer record remains authoritative.

## LLM context minimization

The model receives only the minimum bounded authorized context relevant to the current action:
- current conversation/recent messages;
- fresh confirmed customer facts/preferences when relevant;
- relevant history/summary;
- trusted Business Knowledge;
- Style instructions/examples.

Do not send the entire Workspace, entire customer history, unrelated BP data or secrets merely because they are available.

## Retention

Analytics retention is separate from conversation-history/media retention.

Initial MVP may retain normal conversation/customer history while the Workspace remains active unless the owner deletes it, while preserving an extension point for later configurable retention such as 3/12/24 months or custom policies.

Raw media may have a shorter retention period than conversation/transcript metadata. A practical initial direction is that original audio/media can expire earlier (for example ~90 days) while the permitted transcript/conversation record follows conversation retention. Exact production defaults must be configurable and documented before launch.

Sensitive Business Profiles should support more conservative retention/memory/export posture.

## Sensitive profile mode

A Business Profile may be marked sensitive. Initial protections may include:
- no message text in notification previews by default;
- stricter staff/BP access;
- conservative memory behavior;
- stricter export permission;
- shorter configurable retention where supported;
- sensitive fields excluded from ordinary analytics dimensions.

Sensitive mode strengthens privacy controls; it does not weaken tenant isolation or audit.

## Deletion scopes

Support explicit deletion levels:
- Contact;
- Conversation (where product/legal policy permits independent deletion);
- Business Profile;
- Workspace.

Deactivation is not deletion.

Workspace deletion is OWNER-only and should require re-authentication / strong confirmation, a clear warning, immediate automation/channel shutdown, and export opportunity where appropriate before irreversible cleanup begins.

## Deletion workflow

Use durable `DeletionJob` state:

`REQUESTED -> PROCESSING -> COMPLETED | PARTIAL_FAILURE`

A deletion job records actor, scope, timestamps, progress and external-system limitations without copying unnecessary deleted content into audit.

Deletion under platform control must address derived data including:
- CustomerFact/Preference memory;
- conversation summaries;
- embeddings/search indexes;
- cached AI context;
- media derivatives/transcripts;
- generated exports still retained by the platform;
- other denormalized/materialized copies.

External CRMs/connectors may have separate retention/deletion ownership. The UI/job status must not falsely claim external deletion when the connector cannot perform it.

## Billing/legal retention

Workspace/customer deletion does not imply destruction of the minimum billing/tax/refund/chargeback/legal evidence the platform is required to retain. Such records are stored separately/minimally and are not available as active customer-conversation context.

Do not retain conversation content inside billing/audit records merely to defeat deletion.

## Export

OWNER may export authorized Workspace data. ADMIN access to exports is permission-controlled. Sensitive-profile conversation export may require a separate explicit permission.

Exports are audited, scoped and generated from authorized server-side queries. They never contain provider/API secrets.

## Audit

Customer Workspace audit answers: “what happened inside my Workspace?”

Internal platform security audit answers: “which platform operator accessed or changed customer data/configuration?”

Audit should record actor, action, scope, reason where required, correlation/operation ID and timestamp without unnecessarily duplicating sensitive conversation content.

## Platform/support access

Platform support must not gain unrestricted permanent impersonation by default. Use scoped/time-limited support access, with stronger break-glass controls for exceptional access. See `ADMIN_OPERATIONS.md`.

## Infrastructure baseline

MVP security baseline includes:
- session protection and secure cookie/auth configuration;
- server-side authorization on every query/mutation;
- rate limiting on abuse-prone external surfaces;
- webhook signature/authenticity verification that fails closed;
- encrypted credential handling and rotation/revoke paths;
- structured logs with secret/content minimization;
- backup/restore testing;
- backup lifecycle bounded by retention policy.

A restore must not permanently resurrect already-deleted customer data: deletion reconciliation must be replayable/reapplied after restore where needed.

## Exit criteria

Before normal commercial launch:
- cross-Workspace and cross-BP authorization attacks are tested;
- removed-member access revocation is immediate;
- secret/log redaction is verified adversarially;
- Contact/BP/Workspace deletion workflows are durable and observable;
- successful deletion removes platform-controlled derived AI/search/memory copies;
- exports are scoped/audited and secret-free;
- sensitive-profile privacy controls work on the supported MVP surfaces;
- backup/restore procedures do not silently defeat deletion guarantees.