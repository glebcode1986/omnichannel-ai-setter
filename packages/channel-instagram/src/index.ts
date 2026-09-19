/**
 * @omnichannel/channel-instagram
 *
 * Instagram (Instagram API with Instagram Login) ChannelAdapter implementation: webhook verification,
 * deterministic normalization, messaging-window evaluation and text sending. Meta request/response shapes
 * and error codes stay inside this package; core code sees only the normalized contract.
 *
 * Platform facts are re-verified in docs/research/META_INSTAGRAM_PHASE2_VERIFICATION.md and injected as
 * configuration, never hard-coded in domain code. The adapter never calls a model, never decides reply
 * content, never delays and never sends on its own initiative.
 */
export { createInstagramAdapter, type InstagramAdapter } from "./adapter";
export { INSTAGRAM_CAPABILITIES } from "./capabilities";
export {
  DEFAULT_GRAPH_HOST,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_OAUTH_AUTHORIZE_HOST,
  DEFAULT_OAUTH_TOKEN_HOST,
  DEFAULT_HUMAN_AGENT_WINDOW_MS,
  DEFAULT_STANDARD_WINDOW_MS,
  MAX_TEXT_BYTES,
  type HumanAgentApproval,
  type InstagramAccountBinding,
  type InstagramAdapterConfig,
  type InstagramConnectionState,
  type InstagramSecrets,
} from "./config";
export { createFetchHttpPort, type InstagramHttpPort, type InstagramHttpRequest, type InstagramHttpResult } from "./http";
export {
  buildAuthorizeUrl,
  exchangeCode,
  exchangeForLongLivedToken,
  fetchIdentity,
  INSTAGRAM_MESSAGING_SCOPES,
  isRefreshEligible,
  LONG_LIVED_TOKEN_TTL_MS,
  MIN_REFRESH_AGE_MS,
  missingScopes,
  normalizeAuthorizationCode,
  refreshLongLivedToken,
  type ExchangedCode,
  type InstagramIdentity,
  type InstagramOAuthConfig,
  type LongLivedToken,
  type OAuthFailureReason,
  type OAuthResult,
} from "./oauth";
export type { HumanActor } from "./human-agent";
export {
  createInstagramAdapterRegistry,
  type InstagramBinding,
  type InstagramRegistryOptions,
  type RegistryAccount,
} from "./registry";
export { evaluateHumanAgentEligibility, evaluateStandardWindow, type HumanAgentEligibility, type WindowInputs } from "./window";
export {
  DEFAULT_AUTOMATED_DISPATCH_TARGET_MS,
  DEFAULT_AUTOMATED_RESPONSE_BUDGET_MS,
  instagramTimingPolicy,
  remainingAutomatedDispatchMs,
  type InstagramTimingPolicy,
} from "./timing";
