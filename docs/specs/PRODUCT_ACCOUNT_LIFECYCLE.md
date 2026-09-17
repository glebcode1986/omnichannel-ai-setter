# Product & Account Lifecycle — Phase 6

## Principle

Do not model the whole product with one `ACTIVE / INACTIVE` flag. Workspace lifecycle, subscription lifecycle, Business Profile state, onboarding progress and channel connectivity are separate dimensions.

A customer-facing automation action is permitted only when both are true:

- the workspace/profile is commercially **ENTITLED** for the capability; and
- the relevant Business Profile/channel/action is **OPERATIONALLY_READY**.

Billing health alone never proves operational readiness, and a technically healthy channel never overrides entitlement state.

## Lifecycle dimensions

Track independently:

- user account/login state;
- Workspace state;
- onboarding/setup progress;
- WorkspaceSubscription state;
- Business Profile state;
- ChannelAccount state/capabilities;
- quota/capacity state such as voice minutes, seats and Business Profile slots;
- deletion lifecycle.

## Signup and setup

Creating a user account and Workspace does not automatically start the commercial trial.

Initial setup is resumable. A user may create a Workspace, define language/timezone, create a Business Profile and leave before connecting a working channel.

Business Profile setup may include channel connection, Knowledge, Style, objective/qualification rules and Test Drive. Progress should be shown as a checklist rather than a fake completion percentage.

## Trial start

The 14-day trial begins after the first successful working Business Profile/channel connection, not merely at registration.

Trial defaults should let the customer experience core product value. Real customer traffic should begin conservatively in `DRAFT`; enabling `AUTOPILOT` is an explicit action.

The UI must show trial remaining time and the expected behavior after expiry.

## Subscription lifecycle

Canonical commercial states remain:

- `TRIALING`;
- `ACTIVE`;
- `PAST_DUE`;
- `GRACE`;
- `CANCELED_PENDING_END`;
- `INACTIVE`.

Server-confirmed billing events are authoritative. Frontend redirects or local UI state are never sufficient proof of payment.

### ACTIVE

Confirmed paid entitlement applies according to the selected plan and add-ons.

Upgrade capacity becomes available only after the authoritative billing transition is confirmed and a new entitlement snapshot is active.

### PAST_DUE / GRACE

A failed renewal does not delete data or drop inbound customer messages. The product clearly explains the payment problem and follows the configured grace policy.

After the grace period, paid AI automation/transcription and other gated capabilities stop according to entitlement policy while operational data remains preserved.

### CANCELED_PENDING_END

Canceling a subscription normally schedules cancellation for the end of the already-paid period. Entitlements remain valid until that period ends. Cancellation is not data deletion.

### INACTIVE

After trial/subscription entitlement ends, the Workspace remains accessible according to product policy for history, billing recovery and reactivation. Paid automation does not silently continue.

## Upgrade and downgrade

Upgrades follow authoritative payment -> entitlement snapshot -> capacity availability.

Downgrades normally take effect at period end. If the new plan has lower limits, data is preserved.

For excess Business Profiles, the OWNER should select which profiles remain active. Excess profiles become inactive/read-only rather than being deleted.

For excess seats, affected members lose active access according to an explicit selection/policy, while historical actor references remain intact.

Do not silently delete data to satisfy a lower plan limit.

## Capacity exhaustion is not account inactivity

A depleted allowance such as voice transcription minutes does not change the Workspace subscription lifecycle.

Example: when voice minutes are exhausted, voice media still appears in Inbox, automatic transcription stops, text AI continues, and the customer may buy a top-up.

Similarly, seat/BP capacity limits are entitlement/capacity states, not generic account states.

## Channel lifecycle

A Workspace may be commercially active while one ChannelAccount is unhealthy.

Examples of channel states include connected/healthy, reconnect required, temporarily degraded and disconnected.

A broken WhatsApp credential must not imply that Instagram or unrelated Business Profiles are inactive. Automation pauses only for the affected path where necessary.

## Business Profile lifecycle

Business Profiles may be `SETUP`, `ACTIVE` or `INACTIVE` independently from the Workspace subscription.

Deactivation is reversible and preserves conversations, Contacts, Knowledge, Style and history. Deactivation is not deletion.

Exact commercial slot behavior for voluntarily inactive Business Profiles remains a packaging decision, but deactivation must never silently destroy data.

## Reactivation

A returning customer should not be forced to rebuild a retained Workspace from scratch.

After billing entitlement is restored, run an operational-readiness check before resuming automation. Re-check at least:

- channel authorization/capabilities;
- Business Profile active state;
- Knowledge freshness/review warnings;
- current AI mode/policy;
- unresolved Review/reconciliation blockers;
- entitlement/capacity state.

Do not replay old queued outbound work merely because billing became active again. Pending work must be reconciled/revalidated against current conversation state.

## User account versus Workspace

A user login is distinct from Workspace ownership/membership. One user may eventually belong to multiple Workspaces.

Removing a member from one Workspace does not necessarily delete that person's global login.

A last OWNER cannot simply disappear while leaving an active Workspace ownerless. Ownership must be transferred or the Workspace must enter an explicit deletion flow.

## Deletion

Deletion is an explicit, destructive lifecycle separate from subscription cancellation and Business Profile deactivation.

Workspace deletion is OWNER-only, stops automation safely, revokes/deactivates external credentials where applicable and creates a tracked deletion workflow.

Operational customer data, derived memory/search/media artifacts and other in-scope derived data are deleted/anonymized according to the privacy/retention specification. Minimal billing/legal records may remain separately where required.

After completed deletion, normal reactivation is not supported; a new Workspace is required.

## Event model

Lifecycle transitions should be event-driven and auditable. Example normalized events:

- `trial.started`;
- `subscription.activated`;
- `subscription.payment_failed`;
- `grace.started`;
- `subscription.reactivated`;
- `plan.downgrade_scheduled`;
- `business_profile.activated`;
- `business_profile.deactivated`;
- `channel.reconnect_required`;
- `workspace.deletion_requested`;
- `workspace.deletion_completed`.

Notifications, Admin Operations, Analytics and Billing should consume the same authoritative lifecycle facts rather than inventing independent interpretations.

## Product invariant

`ENTITLED + OPERATIONALLY_READY` is required for autonomous customer-facing execution.

Examples:

- paid but channel disconnected -> no autonomous send on that channel;
- channel healthy but subscription inactive -> no paid automation;
- voice quota exhausted -> text automation may remain ready;
- Workspace active but one Business Profile inactive -> unrelated profiles continue normally.
