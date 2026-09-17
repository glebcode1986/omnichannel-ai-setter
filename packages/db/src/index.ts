/**
 * @omnichannel/db
 *
 * PostgreSQL persistence via Prisma: schema, client, tenant-scoped repositories and transactions.
 * Implements core ports; contains no business rules and no channel-specific transport code.
 *
 * Every tenant-data entry point takes a `WorkspaceContext` from `authorizeWorkspaceAccess` (ADR-009).
 * Allowed workspace dependencies are enforced by `pnpm lint:boundaries` (see docs/specs/REPOSITORY_LAYOUT.md).
 */
export { createDbClient, type DbClient, type DbClientOptions, type DbExecutor } from "./client";
export {
  DbInputError,
  TenantRecordNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspacePermissionError,
} from "./errors";
export {
  authorizeWorkspaceAccess,
  requireWorkspaceRole,
  scopeOf,
  WORKSPACE_ADMIN_ROLES,
  type WorkspaceAccessRequest,
  type WorkspaceContext,
} from "./tenancy";
export * from "./repositories/channel-accounts";
export * from "./repositories/contacts";
export * from "./repositories/conversations";
export * from "./repositories/messages";
export * from "./repositories/workspaces";
export type {
  AiDraft,
  AutomationPolicy,
  ChannelAccount,
  Contact,
  ContactIdentity,
  Conversation,
  DeliveryJobRecord,
  InboundEvent,
  KnowledgeChunk,
  KnowledgeDocument,
  Message,
  StyleExample,
  Workspace,
  WorkspaceMember,
} from "./generated/prisma/client";
