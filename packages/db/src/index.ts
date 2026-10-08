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
  isUniqueViolation,
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
export { readModePolicies, resolveEffectiveMode, type ModePolicyRow } from "./automation-mode";
export { createAiDraftStore } from "./ai-draft-store";
export { createDraftContextStore, type DraftContext, type DraftContextQuery, type DraftContextStore } from "./draft-context-store";
export {
  createDeliveryStore,
  recoverStaleSendingDeliveries,
  requestHumanReview,
  scheduleAutomatedDelivery,
  type AutomatedDeliveryInput,
} from "./delivery-store";
export { createReviewStore, createStyleLearningStore } from "./review-store";
export { createConversationOperationStore } from "./conversation-operations-store";
export { composeHumanReply, pendingHumanReply, type ComposeInput, type ComposeOutcome } from "./composer-store";
export {
  listReviewQueue,
  type ReviewCursor,
  type ReviewItem,
  type ReviewQueueFilter,
  type ReviewQueuePage,
  type RetrievalProvenance,
} from "./review-queue-store";
export { createIngestionStore } from "./ingestion-store";
export {
  type PendingSend,
  listInbox,
  readConversation,
  type ConversationDetail,
  type InboxCursor,
  type InboxFilter,
  type InboxPage,
  type InboxRow,
  type LatestDraft,
  type ThreadMessage,
} from "./inbox-store";
export { countUnusableGenerations, DEFAULT_SNAPSHOT_WINDOW, readReliabilitySnapshot, type ReliabilitySnapshot, type SnapshotWindow } from "./reliability-metrics";
export { createReconciliationStore, findUnresolvedOperations, type UnresolvedOperation } from "./reconciliation-store";
export { createSuspensionStore, type NewSuspension, type SuspensionStore, type SuspensionTargetQuery, type SystemSuspension } from "./suspension-store";
export { createKnowledgeRetriever, createStyleRetriever } from "./retrieval/retrievers";
export {
  archiveKnowledge,
  createKnowledge,
  editKnowledge,
  listKnowledge,
  publishKnowledge,
  readKnowledge,
  recordIndexingResult,
  restoreKnowledge,
  type KnowledgeCursor,
  type KnowledgeDetail,
  type KnowledgeFilter,
  type KnowledgeLibraryPage,
  type KnowledgeLifecycleAct,
  type KnowledgeScope,
  type KnowledgeSummary,
  type KnowledgeVersion,
  type KnowledgeWriteOutcome,
  type NewKnowledge,
} from "./knowledge-store";
export {
  seedKnowledge,
  seedStyleExample,
  type SeededKnowledge,
  type SeedKnowledgeInput,
  type SeedStyleExampleInput,
} from "./retrieval/seed";
export {
  DEFAULT_MIN_LEXICAL_SCORE,
  DEFAULT_MIN_SIMILARITY,
  EMBEDDING_DIMENSIONS,
} from "./retrieval/sql";
export { createStyleProfileStore, type StyleProfileQuery, type StyleProfileStore } from "./style-profile-store";
export {
  listPolicyAudits,
  readPolicies,
  savePolicy,
  type PolicyAuditEntry,
  type PolicyEdit,
  type PolicyView,
  type PolicyWriteOutcome,
} from "./policy-store";
export {
  approveStyleExample,
  archiveStyleExample,
  createStyleExample,
  listStyleExamples,
  readStyleExampleLifecycle,
  readStyleProfiles,
  rejectStyleExample,
  restoreStyleExample,
  saveStyleProfile,
  suggestStyleExample,
  type NewStyleExample,
  type StyleDecisionCursor,
  type StyleDecisionValue,
  type StyleDecisionView,
  type StyleExampleCursor,
  type StyleExampleFilter,
  type StyleExamplePage,
  type StyleExampleView,
  type StyleLifecyclePage,
  type StyleProfileDraft,
  type StyleProfileLayerView,
  type StyleScope,
  type StyleWriteOutcome,
} from "./style-store";
export {
  createCredentialCipher,
  CREDENTIAL_ALGORITHM,
  CredentialCryptoError,
  type CredentialCipher,
  type CredentialCipherOptions,
  type CredentialPurpose,
  type CredentialScope,
  type EncryptedCredential,
} from "./credentials";
export * from "./repositories/channel-connect-states";
export { createInstagramOnboardingStore, type ConnectedAccountRef, type InstagramOnboardingStore } from "./onboarding-store";
export {
  activateBusinessProfile,
  readOnboarding,
  skipOnboardingStep,
  unskipOnboardingStep,
  type ActivationOutcome,
  type OnboardingSnapshot,
} from "./setup-store";
export * from "./repositories/channel-credentials";
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
