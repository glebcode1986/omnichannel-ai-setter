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
export { WHATSAPP_CAPABILITIES } from "./capabilities";
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
export { normalizeWhatsAppWebhook } from "./normalize";
export { providerTime } from "./payload";
export { createWhatsAppAdapterRegistry, type RegistryAccount, type WhatsAppBinding, type WhatsAppRegistryOptions } from "./registry";
export { buildTemplatePayload, buildTextPayload, checkSendable, markReadAndTyping, sendMessage } from "./send";
export { assertVerified, verifyWhatsAppWebhook } from "./verify";
export { evaluateServiceWindow, type WindowInputs } from "./window";
