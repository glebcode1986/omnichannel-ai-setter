/**
 * @omnichannel/db
 *
 * PostgreSQL persistence via Prisma: schema, client, tenant-scoped repositories and transactions.
 * Implements core ports; contains no business rules and no channel-specific transport code.
 *
 * Authorization (ADR-009, DATA_MODEL.md v0.4): Workspace-level operations (membership, Business Profile
 * creation/listing) take a `WorkspaceContext` from `authorizeWorkspaceAccess`. Business Profile owned
 * customer data (channel accounts, contacts, conversations, messages, ...) must take a `BusinessProfileContext`
 * from `authorizeBusinessProfileAccess` and scope every query through `profileScopeOf`.
 * Allowed workspace dependencies are enforced by `pnpm lint:boundaries` (see docs/specs/REPOSITORY_LAYOUT.md).
 */
export { createDbClient, type DbClient, type DbClientOptions, type DbExecutor } from "./client";
export {
  BusinessProfileAccessDeniedError,
  DbInputError,
  TenantRecordNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspacePermissionError,
} from "./errors";
export {
  authorizeBusinessProfileAccess,
  authorizedBusinessProfileFilter,
  authorizeWorkspaceAccess,
  profileScopeOf,
  requireRole,
  scopeOf,
  WORKSPACE_ADMIN_ROLES,
  type BusinessProfileAccessRequest,
  type BusinessProfileContext,
  type BusinessProfileScope,
  type WorkspaceAccessRequest,
  type WorkspaceContext,
} from "./tenancy";
export { createIngestionStore } from "./ingestion-store";
export * from "./repositories/channel-accounts";
export * from "./repositories/contacts";
export * from "./repositories/conversations";
export * from "./repositories/messages";
export * from "./repositories/workspaces";
export type {
  AiDraft,
  AutomationPolicy,
  BusinessProfile,
  ChannelAccount,
  ChannelIdentity,
  Contact,
  Conversation,
  DeliveryJobRecord,
  InboundEvent,
  KnowledgeChunk,
  KnowledgeDocument,
  MemberBusinessProfileAccess,
  Message,
  QueueOutbox,
  StyleExample,
  Workspace,
  WorkspaceMember,
} from "./generated/prisma/client";
