# Admin Operations — Internal Platform Console

**Status:** Product direction accepted. Internal operational tooling; not a customer-facing module.

## Principle

Admin Operations is a separate internal control plane for operating the SaaS safely. It must not be implemented as an unrestricted hidden super-admin mode inside the customer application.

Customer roles (`OWNER`, `ADMIN`, `AGENT`) and internal platform roles are separate authorization domains. Internal support access must be explicit, scoped, time-bounded where appropriate, and fully audited.

## Initial operational surfaces

The internal console should expose:
- Workspaces: plan, subscription state, trial, seats, Business Profiles, recent activity and operational health;
- Business Profiles: status, effective AI mode, connected channels, readiness/health and warnings;
- Channels: connection/auth state, capabilities, recent webhook/outbound activity and provider errors;
- Billing & Entitlements: plan, billing lifecycle, allowance/add-ons, grace, provider references and controlled overrides;
- Operations / Jobs: deliveries, reconciliation, follow-ups, booking operations, media processing and deletion jobs;
- Incidents: active provider/platform incidents and affected tenants;
- Feature flags / kill switches;
- internal security/audit history.

## Support access model

Internal staff should see metadata/diagnostics by default, not unrestricted conversation content.

Use an explicit `SupportAccessSession` concept with:
- actor/internal role;
- workspace / Business Profile scope;
- granted data scopes;
- reason/ticket reference;
- start and expiry time;
- customer approval when required by policy;
- audit trail.

Sensitive Business Profiles may require stricter scopes or masking.

Provide a separate break-glass path for urgent incidents. Break-glass access must require a reason, be time-limited, create a high-severity audit event, and never expose stored credentials/secrets.

## Internal platform roles

Do not reuse customer workspace roles. Initial internal role direction may include:
- `SUPPORT` — operational diagnostics and permitted support sessions;
- `BILLING` — billing lifecycle and approved billing actions;
- `OPERATIONS` — incidents, queues, reconciliation and controlled operational actions;
- `PLATFORM_ADMIN` — narrowly controlled platform administration.

Authorization remains server-side. `PLATFORM_ADMIN` does not imply direct visibility of raw secrets.

## Typed administrative actions

Routine support must not rely on direct database edits or free-form JSON mutation.

Expose typed actions that route through application/domain rules, for example:
- reconnect / reauthorize channel;
- reconcile subscription/payment state;
- grant a temporary entitlement override;
- add an approved voice-minute allowance/top-up;
- extend trial under policy;
- initiate refund through the billing domain;
- cancel at period end;
- cancel a stale follow-up;
- reindex a Knowledge source;
- safely retry an idempotent operation;
- run provider reconciliation;
- re-run transcription where permitted;
- revoke sessions;
- deactivate Business Profile.

Production database shell access is emergency tooling, not normal customer support tooling.

## Temporary entitlement overrides

Operational overrides must be explicit and expiring, not permanent hidden flags.

Record at least:
- target workspace/profile;
- entitlement/capacity changed;
- reason;
- actor;
- created_at;
- expires_at;
- linked incident/ticket where applicable.

Expiration should restore the authoritative plan-derived state automatically unless a newer valid override supersedes it.

## Reconciliation center

Provide a first-class view for ambiguous/high-risk external operations, including:
- ambiguous customer message sends;
- booking writes requiring reconciliation;
- billing/payment lifecycle uncertainty;
- other external side effects where blind retry could duplicate an action.

The console should expose normalized operation state, correlation IDs, provider references when known and safe reconciliation actions.

Do not provide a generic `retry anyway` control for ambiguous non-idempotent writes.

## Queue / operation inspector

Operators should be able to trace a logical operation through the system without raw Redis tooling:

`Conversation -> reply cycle -> draft -> scheduled delivery -> provider send -> status/reconciliation`

Expose logical queue health, pending counts, oldest job age, failures requiring attention and relevant correlation IDs. Queue implementation details are secondary to the business operation being inspected.

## Kill switches

Support scoped emergency controls for:
- all automated outbound globally;
- a channel/provider class globally;
- a workspace;
- a Business Profile;
- a specific ChannelAccount;
- high-risk features such as autonomous booking or template AUTOPILOT.

Emergency outbound pause must normally keep inbound ingestion/persistence running.

All kill-switch changes require an actor, reason and audit event.

## Feature flags / rollout controls

Feature flags are separate from incident kill switches. They support staged enablement such as:

`internal -> design partners -> limited cohort -> broader rollout`

Flags may scope by environment, workspace, Business Profile, plan/capability or explicit allowlist. Disabling a flag must fail safely without corrupting existing state.

## Customer-safe support snapshot

Provide a safe diagnostic snapshot containing identifiers and operational metadata such as:
- workspace / Business Profile IDs;
- channel/auth capability state;
- entitlement state;
- last inbound / outbound timestamps;
- queue/operation state;
- correlation IDs;
- relevant normalized error codes.

Do not include OAuth tokens, API keys, signing secrets or unnecessary private conversation text.

## Internal audit

Customer Audit answers what happened inside the customer's workspace.

Platform Security Audit separately records what internal staff accessed or changed. Material events include:
- opening a workspace/customer record;
- granting/using support access;
- break-glass access;
- data scope viewed;
- billing/entitlement mutation;
- reconciliation action;
- feature flag / kill switch changes;
- security/session intervention.

Historical actor identity must remain attributable after an internal staff member leaves.

## Privacy and least privilege

Internal support access never becomes a shortcut around tenant isolation. Credentials/secrets remain non-readable through the admin console. Sensitive conversation content is accessed only when necessary and permitted by policy/scope.

Exports, conversation-content access and break-glass actions should have stricter permission/audit posture than routine diagnostics.

## Commercial-launch minimum

Before routine commercial operation, the minimum useful Admin Operations capability should include:
- workspace lookup;
- subscription/entitlement inspection;
- channel diagnostics;
- scoped support access;
- ambiguous-operation reconciliation visibility;
- kill switches;
- internal audit.

Additional convenience operations may be added incrementally, but recurring direct-database intervention is a signal that the console is missing an operational capability.
