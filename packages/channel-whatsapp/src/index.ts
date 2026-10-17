/**
 * @omnichannel/channel-whatsapp
 *
 * Official WhatsApp Business Cloud API ChannelAdapter implementation: raw-body webhook verification,
 * deterministic normalization, customer-service-window evaluation, free-form text and approved-template
 * sending, and the read/typing presence effect. Meta request/response shapes and error codes stay inside
 * this package; core code sees only the normalized contract.
 *
 * Platform facts are re-verified in docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md and injected as
 * configuration, never hard-coded in domain code. The adapter never calls a model, never decides reply
 * content, never delays and never sends on its own initiative.
 */
export { createWhatsAppAdapter, type WhatsAppAdapter } from "./adapter";
export {
  ACCOUNT_LIFECYCLE_EVENTS,
  ACCOUNT_UPDATE_FIELD,
  readAccountLifecycleChanges,
  type AccountLifecycleChange,
  type AccountLifecycleEvent,
} from "./account-lifecycle";
export { coexistenceCapabilities, WHATSAPP_CAPABILITIES } from "./capabilities";
export {
  DEFAULT_GRAPH_HOST,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_SERVICE_WINDOW_MS,
  MAX_TEXT_LENGTH,
  messagesUrl,
  resolveConfig,
  type ResolvedWhatsAppConfig,
  type WhatsAppAccountBinding,
  type WhatsAppAdapterConfig,
  type WhatsAppConnectionState,
  type WhatsAppSecrets,
} from "./config";
export { isAccessTokenRejection, OUTSIDE_SERVICE_WINDOW_CODE } from "./errors";
export { createFetchHttpPort, type WhatsAppHttpPort, type WhatsAppHttpRequest, type WhatsAppHttpResult } from "./http";
export {
  deleteMedia,
  downloadMedia,
  MAX_MEDIA_BYTES,
  MEDIA_LIMITS,
  MEDIA_URL_TTL_MS,
  mediaIdUsable,
  mediaLimitFor,
  mediaSupported,
  resolveMediaUrl,
  TRANSCRIBABLE_MIME_TYPES,
  transcribableMimeType,
  WEBHOOK_MEDIA_ID_TTL_MS,
  type DownloadedMedia,
  type MediaFailureReason,
  type MediaLocation,
  type MediaResult,
} from "./media";
export { normalizeWhatsAppWebhook } from "./normalize";
export {
  coexistenceCorroborated,
  EMBEDDED_SIGNUP_SCOPES,
  exchangeSignupCode,
  fetchGrantedAccess,
  fetchMessageTemplates,
  findPhoneNumberAsset,
  missingSignupScopes,
  onboardingModeOf,
  PHONE_PIN_LENGTH,
  readSignupNotice,
  registerPhoneNumber,
  SIGNUP_CODE_TTL_MS,
  subscribeMessagingAccount,
  SYSTEM_USER_SCOPE,
  unsubscribeMessagingAccount,
  type BusinessToken,
  type GrantedAccess,
  type MessageTemplateRecord,
  type PhoneNumberAsset,
  type SignupFailureReason,
  type SignupNotice,
  type SignupResult,
  type WhatsAppOnboardingMode,
  type WhatsAppSignupConfig,
} from "./onboarding";
export { parseWebhook, providerTime, type WhatsAppWebhook } from "./payload";
export { createWhatsAppAdapterRegistry, type RegistryAccount, type WhatsAppBinding, type WhatsAppRegistryOptions } from "./registry";
export {
  buildTemplatePayload,
  buildTextPayload,
  checkSendable,
  markReadAndTyping,
  MARK_READ_MAX_AGE_MS,
  sendMessage,
  TYPING_INDICATOR_TTL_MS,
} from "./send";
export {
  readTemplateShape,
  readTemplateStatusChanges,
  SENDABLE_TEMPLATE_STATUS,
  TEMPLATE_STATUS_FIELD,
  templateSendable,
  UNSENDABLE_TEMPLATE_STATUSES,
  type TemplateStatusChange,
} from "./templates";
export { assertVerified, verifyWhatsAppWebhook } from "./verify";
export { evaluateServiceWindow, type WindowInputs } from "./window";
