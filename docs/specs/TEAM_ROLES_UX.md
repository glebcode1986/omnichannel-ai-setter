# Team & Roles UX

## Principle

Keep launch permissions understandable. Use three workspace roles — `OWNER`, `ADMIN`, `AGENT` — and combine them with Business Profile scope rather than creating a large role matrix.

Role answers **what a member may do**. Business Profile scope answers **where they may do it**.

Authorization is server-side. Hiding a button in the UI is never the permission boundary.

## Roles

### OWNER

The workspace owner has full workspace authority, including:
- Inbox / Review / Leads work;
- Knowledge and Style management;
- AI policy and AUTOPILOT settings;
- channel connection/disconnection;
- member and access management;
- billing/subscription changes;
- workspace-level security/audit settings;
- ownership transfer and workspace deletion.

Billing mutations remain OWNER-only for the initial product unless a future explicit delegated billing role is introduced.

### ADMIN

An admin may operate the business and configure non-billing product behavior within granted Business Profile scope, including:
- Inbox / Review / Leads;
- Knowledge and Style;
- AI policy / AUTOPILOT;
- channel configuration;
- member invitations/access management, except ownership-only operations;
- operational analytics/audit according to plan and scope.

ADMIN cannot transfer ownership, delete the workspace, or mutate subscription/provider billing state in the initial product.

### AGENT

An agent is primarily an operational user. Within granted Business Profile scope an agent may:
- view assigned/allowed conversations and leads;
- reply to customers;
- take over and later resume AI on a conversation;
- handle Review items;
- update lead stages, notes and next actions.

AGENT cannot change global/business-wide AI policy, connect channels, manage members, alter billing, or perform ownership/security-administration actions.

Optional agent permissions may allow specific operational capabilities such as:
- edit Knowledge;
- approve/add Style examples;
- view analytics;
- export leads when the plan supports export.

Keep these toggles small and explicit rather than building a generic enterprise IAM system at launch.

## Business Profile scope

Members may be scoped to all Business Profiles or a selected subset.

A member without access to a Business Profile must not receive its customer identities, message bodies, leads, analytics, notification previews or searchable results from the server.

Sensitive profiles may use stricter scope such as assigned-only conversation visibility. The architecture should permit this later without changing the role model.

## Assignment versus takeover

Assignment and AI control are separate concepts.

`Assigned to Anna` means Anna is the responsible human/manager. It does not automatically stop AI.

`Take over as Anna` means a human actively takes control of that conversation and AI enters the applicable human-active state.

Assignment filters should support at least `Assigned to me`, `Unassigned`, and `Team` where the member has scope.

## Invitations and seats

Invite flow:
1. enter email;
2. choose role;
3. choose Business Profile scope;
4. choose allowed optional agent permissions where relevant;
5. send invitation.

Initial seat accounting should count an invited member once the invitation is accepted/activated, not merely when an invitation email is created. Abuse/race-safe reservation can be an implementation detail if needed.

## Removal and history

Removing a member revokes future access but never deletes their historical messages, approvals, edits, lead transitions or audit records.

Historical records keep immutable actor identity/reference even when the person is no longer an active member.

## Ownership safety

The workspace must always have an active OWNER.

The last OWNER cannot delete/demote themselves or leave the workspace until ownership is explicitly transferred to another eligible active member.

Ownership transfer is a high-impact action and requires explicit confirmation and audit.

## Privacy and audit

Role/scope changes, invites, removals, optional permission changes and ownership transfer are auditable material actions.

Member notification delivery and search results must honor the same authorization/scope model as the underlying Inbox/Lead data.