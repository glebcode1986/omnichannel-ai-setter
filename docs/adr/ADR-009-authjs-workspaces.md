# ADR-009: Auth.js + Prisma Workspace Membership

**Status:** Accepted for MVP

## Decision

Use Auth.js (NextAuth v5 family) with Prisma-backed user/account/session persistence and an explicit Workspace/WorkspaceMember tenancy model.

Initial workspace roles:

- `OWNER`
- `ADMIN`
- `AGENT`

Fine-grained enterprise RBAC is post-MVP.

## Why

OpenSetter already uses NextAuth/Auth.js with Prisma, minimizing adaptation cost. Our core persistence is already Prisma/PostgreSQL, so introducing a second auth/database abstraction is unnecessary for MVP.

## Tenant isolation rule

Every customer-owned record belongs directly or transitively to a `workspace_id`. Application/repository methods that read/write tenant data require an authenticated `WorkspaceContext`. Cross-workspace access tests are mandatory for sensitive repositories and API routes.

## Database security

MVP isolation is enforced through application/repository scoping plus database constraints. PostgreSQL RLS may be added later as defense-in-depth via a separate ADR; agents must not assume RLS exists today.

## Consequences

- Auth.js browser/session identity is separate from workspace authorization.
- A user may belong to multiple workspaces.
- active workspace selection is explicit.
- channel credentials, knowledge, contacts and conversations are workspace-scoped.
