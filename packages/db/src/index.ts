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
export {
  createPresenceStore,
  presenceCapabilitiesOf,
  presenceSettingsOf,
  type PresenceContext,
  type PresenceStore,
} from "./presence-store";
export { createReviewStore, createStyleLearningStore } from "./review-store";
export {
  editLead,
  listAssignableMembers,
  listLeads,
  readQualification,
  readStageDisplays,
  readStageHistory,
  recordQualification,
  saveStageDisplays,
  transitionLeadStage,
  type AssignableMember,
  type LeadEditOutcome,
  type LeadFilter,
  type LeadRow,
  type LeadValueSource,
  type QualificationAnswer,
  type StageConfigOutcome,
  type StageDisplay,
  type StageHistoryEntry,
  type StageTransitionOutcome,
} from "./lead-store";
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
  readStyleProfiles,
  rejectStyleExample,
  restoreStyleExample,
  saveStyleProfile,
  suggestStyleExample,
  type NewStyleExample,
  type StyleDecisionValue,
  type StyleDecisionView,
  type StyleExampleCursor,
  type StyleExampleFilter,
  type StyleExamplePage,
  type StyleExampleView,
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
export { createInstagramOnboardingStore, type ConnectedAccountRef, type ChannelOnboardingStore, type InstagramOnboardingStore } from "./onboarding-store";
export { applyTemplateStatusUpdate, readTemplateCatalogue, type StoredTemplate, type TemplateStatusUpdate } from "./whatsapp-template-store";
export {
  createPendingTranscripts,
  loadTranscriptionWork,
  markTranscriptMediaDeleted,
  readMessageTranscripts,
  recordTranscript,
  recordTranscriptionFailure,
  type MessageTranscriptRecord,
  type PendingTranscriptInput,
  type RecordedTranscript,
  type TranscriptionStateValue,
  type TranscriptionWork,
} from "./transcript-store";
export {
  createWhatsAppOnboardingStore,
  type ConnectWhatsAppInput,
  type WhatsAppConnectionRecord,
  type WhatsAppOnboardingModeValue,
  type WhatsAppOnboardingStore,
  type WhatsAppPhoneAsset,
  type WhatsAppTemplateInput,
} from "./whatsapp-onboarding-store";
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
export {
  confirmFact,
  confirmPreference,
  dismissDuplicateCandidate,
  expireStaleMemory,
  forgetCustomer,
  listContactPoints,
  listDuplicateCandidates,
  normalizeContactPoint,
  proposeFact,
  proposePreference,
  readAuthoritativeMemory,
  readConversationSummary,
  readMemoryHistory,
  recordContactPoint,
  recordConversationSummary,
  recordExternalIdentity,
  searchCustomers,
  searchLimit,
  type ContactPointView,
  type CustomerSearchHit,
  type DuplicateCandidateView,
  type FactCategory,
  type MemoryEntry,
  type MemoryOutcome,
  type MemorySource,
  type MemoryStatus,
  type SummaryView,
} from "./customer-memory-store";
export {
  auditPageLimit,
  readableAuditKinds,
  recordAuditEvent,
  recordWorkspaceAuditEvent,
  searchAuditEvents,
  type AuditEventInput,
  type AuditEventView,
  type AuditPage,
  type AuditSearch,
} from "./audit-store";
export {
  deliveryOutcomes,
  draftOutcomes,
  firstResponseTimes,
  inboundVolume,
  leadMovement,
  missingFactFrequency,
  modelUsage,
  readOperationalSnapshot,
  reviewReasons,
  takeoverRate,
  type DeliveryOutcomes,
  type DraftOutcomes,
  type LeadMetrics,
  type MetricFilter,
  type MetricWindow,
  type ModelUsage,
  type OperationalSnapshot,
  type ReasonCount,
  type ResponseTimes,
  type StageMovement,
  type TakeoverRate,
  type VolumePoint,
} from "./analytics-store";
export {
  closeGoal,
  readGoals,
  setNextAction,
  setPrimaryGoal,
  suggestGoal,
  type GoalOutcome,
  type GoalView,
} from "./goal-store";
export {
  cancelFollowUp,
  cancelPendingFollowUps,
  claimFollowUp,
  dueFollowUps,
  hourIn,
  isSuppressed,
  liftSuppression,
  nextOpening,
  planFollowUp,
  readFollowUps,
  recordFollowUpSent,
  suppressFollowUps,
  type FollowUpClaim,
  type FollowUpOutcome,
  type FollowUpView,
} from "./followup-store";
export {
  assignTask,
  completeTask,
  createTask,
  dismissTask,
  listTasks,
  suggestTask,
  type TaskFilter,
  type TaskOutcome,
  type TaskView,
} from "./human-task-store";
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
