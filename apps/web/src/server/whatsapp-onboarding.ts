/**
 * WhatsApp Embedded Signup: start a connection, complete it, disconnect (Issue #19, ADR-015).
 *
 * The flow is not an OAuth redirect. Meta's Embedded Signup runs in a popup driven by the Facebook
 * JavaScript SDK and hands the browser two separate things — an exchangeable code from the login callback,
 * and a session-log object naming the customer's new assets. Both arrive in *our* page and are posted to
 * *our* server, which means every identifier in them is attacker-controlled until Meta confirms it.
 *
 * Five rules carry the security of this file, and all of them live here rather than in the route:
 *
 * 1. **Two halves of state.** The flow's `state` is a database row — single-use, short-lived, remembering
 *    who started it and for which Business Profile — *and* a cookie nonce whose hash is on that row.
 *    Neither half alone completes anything, so neither a leaked state nor a forged cookie is enough.
 * 2. **Re-authorization at completion.** Membership, role and profile access are re-read when the result
 *    comes back, and the store's own writes require an admin role, so access revoked mid-flow takes effect
 *    immediately.
 * 3. **Nothing the browser says about assets is believed.** The `phone_number_id` is looked up *on* the
 *    `waba_id` with the exchanged token; a pair that does not belong together is refused. This is the one
 *    check that stops a customer's own browser connecting someone else's number to their workspace.
 * 4. **The account becomes connected only after the provider confirmed the work.** Webhook subscription
 *    and — unless Meta reported coexistence — phone registration must both succeed first; a failure
 *    persists nothing at all, so there is no half-connected account and the operator can simply try again
 *    (both provider calls are idempotent).
 * 5. **No secret leaves memory.** The code, the token, the state value, the nonce and the two-step PIN never
 *    reach a log, a response body or an error message. Only fixed reason codes do.
 *
 * **The PIN is deliberately not stored.** It is the number's two-step verification secret, it is needed
 * once for registration, and keeping it would add a second secret at rest for a value the operator already
 * has. They supply it when they connect; we use it and forget it.
 *
 * Dependencies are injected, so the whole flow is testable without Meta, a database or a browser.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import {
  coexistenceCorroborated,
  EMBEDDED_SIGNUP_SCOPES,
  exchangeSignupCode,
  fetchGrantedAccess,
  fetchMessageTemplates,
  findPhoneNumberAsset,
  missingSignupScopes,
  readSignupNotice,
  registerPhoneNumber,
  subscribeMessagingAccount,
  unsubscribeMessagingAccount,
  coexistenceCapabilities,
  type SignupFailureReason,
  type WhatsAppOnboardingMode,
  type WhatsAppSignupConfig,
} from "@omnichannel/channel-whatsapp";
import { ChannelConnectError, type BusinessProfileContext, type WhatsAppOnboardingStore } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

/** How long the operator has to finish Embedded Signup before the state expires. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_COOKIE_NAME = "__Host-wa_signup_state";
const CREDENTIAL_PURPOSE = "WHATSAPP_BUSINESS_TOKEN" as const;
/**
 * How long the business token is assumed good when Meta states no expiry.
 *
 * Sixty days, which is what the Business Login configuration template Meta tells providers to start from
 * issues. It is a floor for health checks, not a promise: `debug_token` is believed over this whenever it
 * answers, and an expired token surfaces as `REAUTH_REQUIRED` either way.
 */
export const ASSUMED_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export type ConnectFailureReason =
  | "invalid_state"
  | "cancelled"
  | "denied"
  | "no_phone_number"
  | "provider_rejected"
  | "provider_unavailable"
  | "missing_scope"
  | "wrong_app"
  | "asset_mismatch"
  | "invalid_pin"
  | "subscription_failed"
  | "registration_failed"
  | "already_connected"
  | "different_account";

export interface WhatsAppOnboardingDependencies {
  readonly store: WhatsAppOnboardingStore;
  readonly signup: WhatsAppSignupConfig;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Opaque, unguessable values for the state ID and the cookie nonce. */
  readonly newId: () => string;
}

export interface StartedSignup {
  /** What the client script needs to launch the flow. None of it is secret. */
  readonly launch: {
    readonly appId: string;
    readonly configId: string;
    readonly graphVersion: string;
    readonly scopes: readonly string[];
  };
  /** Posted back with the result; its twin is the cookie below. */
  readonly stateId: string;
  readonly cookieNonce: string;
  readonly cookieMaxAgeSeconds: number;
}

export interface SignupCompletionInput {
  readonly state: string | undefined;
  /** `response.authResponse.code`. Lives 30 seconds, so it is exchanged in this request or not at all. */
  readonly code: string | undefined;
  /** The `WA_EMBEDDED_SIGNUP` session-log object, exactly as the browser received it. Untrusted. */
  readonly notice: unknown;
  /** Six digits, typed by the operator. Used once for registration and never stored. */
  readonly pin: string | undefined;
  readonly cookieNonce: string | undefined;
}

export interface ConnectedWhatsApp {
  readonly ok: true;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  readonly mode: WhatsAppOnboardingMode;
  /** True when the catalogue could not be read; the connection is live but its templates are unknown. */
  readonly templatesUnsynced: boolean;
}

export type SignupCompletion = ConnectedWhatsApp | { readonly ok: false; readonly reason: ConnectFailureReason };

export async function startWhatsAppConnect(
  dependencies: WhatsAppOnboardingDependencies,
  context: BusinessProfileContext,
): Promise<StartedSignup> {
  const stateId = dependencies.newId();
  const cookieNonce = dependencies.newId();
  await dependencies.store.createConnectState(context, {
    stateId,
    nonceHash: hashNonce(cookieNonce),
    channel: "WHATSAPP",
    requestedScopes: [...EMBEDDED_SIGNUP_SCOPES],
    expiresAt: new Date(dependencies.now().getTime() + CONNECT_STATE_TTL_MS),
  });
  dependencies.logger.info("whatsapp.connect_started", {
    workspaceId: context.workspaceId,
    businessProfileId: context.businessProfileId,
  });
  return {
    launch: {
      appId: dependencies.signup.appId,
      configId: dependencies.signup.configId,
      graphVersion: dependencies.signup.graphVersion ?? "",
      scopes: [...EMBEDDED_SIGNUP_SCOPES],
    },
    stateId,
    cookieNonce,
    cookieMaxAgeSeconds: Math.floor(CONNECT_STATE_TTL_MS / 1000),
  };
}

/**
 * Completes a signup. `authorize` re-checks the session against the state row; it is injected so the route
 * can use the real request context while tests supply their own.
 */
export async function completeWhatsAppConnect(
  dependencies: WhatsAppOnboardingDependencies,
  input: SignupCompletionInput,
  authorize: (workspaceId: string, businessProfileId: string) => Promise<BusinessProfileContext>,
): Promise<SignupCompletion> {
  const now = dependencies.now();
  if (input.state === undefined || input.cookieNonce === undefined) {
    return fail(dependencies, "invalid_state");
  }
  // Consumed before anything else, so a replay finds nothing even when the first attempt failed later on.
  const state = await dependencies.store.consumeConnectState({ stateId: input.state, now });
  if (state === undefined || state.channel !== "WHATSAPP" || !nonceMatches(input.cookieNonce, state.nonceHash)) {
    return fail(dependencies, "invalid_state");
  }

  const context = await authorize(state.workspaceId, state.businessProfileId);
  if (context.userId !== state.userId) {
    // Someone else's browser finishing a flow this person started. The role check would pass; the
    // binding is what makes it refusable.
    return fail(dependencies, "invalid_state");
  }

  const notice = readSignupNotice(input.notice);
  if (notice.kind === "CANCELLED") {
    dependencies.logger.info("whatsapp.connect_cancelled", { workspaceId: state.workspaceId, step: notice.currentStep ?? "unknown" });
    return { ok: false, reason: "cancelled" };
  }
  if (notice.kind === "ERRORED") {
    // The provider's own message is untrusted text shown to the customer, and is never echoed or logged;
    // the code and session ID are what support asks for.
    dependencies.logger.warn("whatsapp.connect_provider_error", {
      workspaceId: state.workspaceId,
      ...(notice.code === undefined ? {} : { providerErrorCode: notice.code }),
      ...(notice.sessionId === undefined ? {} : { providerSessionId: notice.sessionId }),
    });
    return { ok: false, reason: "denied" };
  }
  if (notice.kind === "UNREADABLE" || input.code === undefined) {
    return fail(dependencies, "invalid_state");
  }
  if (notice.phoneNumberId === undefined || notice.wabaId === undefined) {
    // `FINISH_ONLY_WABA` and `FINISH_GRANT_ONLY_API_ACCESS` end the flow without a number. There is
    // nothing to connect yet, and saying so is more useful than a generic refusal.
    dependencies.logger.info("whatsapp.connect_without_number", { workspaceId: state.workspaceId, event: notice.event });
    return { ok: false, reason: "no_phone_number" };
  }

  const exchanged = await exchangeSignupCode(dependencies.signup, input.code);
  if (!exchanged.ok) {
    // Thirty seconds is the whole life of that code, so there is nothing to retry in the background: the
    // operator starts again, which is why this is a refusal rather than a queued repair.
    return fail(dependencies, reasonOf(exchanged.reason), exchanged.code);
  }
  const accessToken = exchanged.value.accessToken;

  const access = await fetchGrantedAccess(dependencies.signup, accessToken);
  if (!access.ok) {
    return fail(dependencies, reasonOf(access.reason), access.code);
  }
  const missing = missingSignupScopes(access.value.scopes);
  if (missing.length > 0) {
    // Named, not listed back from the provider: these are our own constants, so the message cannot carry
    // provider text, and an operator can be told exactly which permission to grant.
    dependencies.logger.warn("whatsapp.connect_missing_scope", { workspaceId: state.workspaceId, missing });
    return { ok: false, reason: "missing_scope" };
  }

  const asset = await findPhoneNumberAsset(dependencies.signup, accessToken, {
    wabaId: notice.wabaId,
    phoneNumberId: notice.phoneNumberId,
  });
  if (!asset.ok) {
    return fail(dependencies, reasonOf(asset.reason), asset.code);
  }

  const subscribed = await subscribeMessagingAccount(dependencies.signup, accessToken, notice.wabaId);
  if (!subscribed.ok) {
    // Nothing has been written yet, so there is no half-connected account to clean up — and subscribing
    // is idempotent, so trying again costs nothing.
    dependencies.logger.warn("whatsapp.connect_subscription_failed", {
      workspaceId: state.workspaceId,
      ...(subscribed.code === undefined ? {} : { code: subscribed.code }),
    });
    return { ok: false, reason: "subscription_failed" };
  }
  const webhookSubscribedAt = dependencies.now();

  let phoneRegisteredAt: Date | undefined;
  if (notice.mode !== "COEXISTENCE_EXISTING_BUSINESS_APP") {
    if (input.pin === undefined) {
      return { ok: false, reason: "invalid_pin" };
    }
    const registered = await registerPhoneNumber(dependencies.signup, accessToken, {
      phoneNumberId: notice.phoneNumberId,
      pin: input.pin,
    });
    if (!registered.ok) {
      dependencies.logger.warn("whatsapp.connect_registration_failed", {
        workspaceId: state.workspaceId,
        ...(registered.code === undefined ? {} : { code: registered.code }),
      });
      return { ok: false, reason: registered.reason === "invalid_pin" ? "invalid_pin" : "registration_failed" };
    }
    phoneRegisteredAt = dependencies.now();
  }

  // Best effort, and visible when it fails: a connection whose catalogue is unknown is usable for
  // free-form customer care and must not silently look template-ready.
  const catalogue = await fetchMessageTemplates(dependencies.signup, accessToken, notice.wabaId);
  const templatesUnsynced = !catalogue.ok;
  if (!catalogue.ok) {
    dependencies.logger.warn("whatsapp.template_bootstrap_failed", {
      workspaceId: state.workspaceId,
      ...(catalogue.code === undefined ? {} : { code: catalogue.code }),
    });
  }

  try {
    const connected = await dependencies.store.connectWhatsAppAccount(context, {
      phoneNumberId: notice.phoneNumberId,
      wabaId: notice.wabaId,
      ...(notice.businessPortfolioId === undefined ? {} : { businessPortfolioId: notice.businessPortfolioId }),
      asset: asset.value,
      onboardingMode: notice.mode,
      // Per account rather than per channel: whether replies a person sends outside this product are
      // visible to it depends on whether this number is on coexistence, which Meta reports only at the
      // end of the flow. An account that cannot see them has to say so rather than behave as though
      // none happen (#23).
      capabilities: coexistenceCapabilities(notice.mode),
      purpose: CREDENTIAL_PURPOSE,
      token: accessToken,
      expiresAt: access.value.expiresAt ?? expiryOf(exchanged.value.expiresInSeconds, now),
      webhookSubscribedAt,
      ...(phoneRegisteredAt === undefined ? {} : { phoneRegisteredAt }),
      ...(catalogue.ok ? { templates: { records: catalogue.value.templates, complete: catalogue.value.complete, syncedAt: dependencies.now() } } : {}),
      // Degraded only when the *provider* says the number is in trouble. A red quality rating is Meta
      // warning that the next unattended message is the risky one, and the policy layer holds every
      // automated reply for a flagged account until somebody looks.
      //
      // A catalogue we could not read is deliberately **not** degradation. Free-form customer care is
      // unaffected by it, the transport refuses a template send naming a template it cannot find, and
      // delivery policy rechecks template status anyway — so pausing a healthy number's automation over
      // a read that can be retried would be the second penalty for one gap.
      health: health(asset.value.qualityRating, templatesUnsynced),
      now: dependencies.now(),
    });
    dependencies.logger.info("whatsapp.connected", {
      workspaceId: state.workspaceId,
      businessProfileId: state.businessProfileId,
      channelAccountId: connected.channelAccountId,
      mode: notice.mode,
      coexistenceCorroborated: coexistenceCorroborated(notice.mode, asset.value),
      templatesUnsynced,
    });
    return {
      ok: true,
      workspaceId: state.workspaceId,
      businessProfileId: state.businessProfileId,
      channelAccountId: connected.channelAccountId,
      mode: notice.mode,
      templatesUnsynced,
    };
  } catch (error) {
    if (error instanceof ChannelConnectError) {
      // `already_connected` is the global live-account index: one provider number may be live in exactly
      // one Workspace, which is what stops two tenants claiming the same phone.
      dependencies.logger.warn("whatsapp.connect_refused", { workspaceId: state.workspaceId, reason: error.reason });
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

/**
 * Disconnects a WhatsApp account.
 *
 * The provider unsubscribe is attempted first and is best effort: if it fails, the local disconnect still
 * happens. The alternative is worse — a workspace told "could not disconnect" while its credential is
 * still live and its worker still sending — and an unsubscribe that did not land only means Meta keeps
 * delivering events for an account whose webhook route now resolves to a disconnected row and drops them.
 */
export async function disconnectWhatsAppAccount(
  dependencies: WhatsAppOnboardingDependencies,
  context: BusinessProfileContext,
  channelAccountId: string,
): Promise<{ readonly ok: boolean; readonly unsubscribed: boolean }> {
  const now = dependencies.now();
  const connection = await dependencies.store.readConnection(context, channelAccountId);
  if (connection === undefined) {
    return { ok: false, unsubscribed: false };
  }
  let unsubscribed = false;
  if (connection.credentialId !== undefined) {
    const stored = await dependencies.store.readCredential(context, { credentialId: connection.credentialId, purpose: CREDENTIAL_PURPOSE });
    if (stored !== undefined) {
      const result = await unsubscribeMessagingAccount(dependencies.signup, stored.token, connection.wabaId);
      unsubscribed = result.ok;
      if (!result.ok) {
        dependencies.logger.warn("whatsapp.unsubscribe_failed", {
          workspaceId: context.workspaceId,
          channelAccountId,
          ...(result.code === undefined ? {} : { code: result.code }),
        });
      }
    }
  }
  await dependencies.store.disconnectWhatsAppAccount(context, channelAccountId, now);
  dependencies.logger.info("whatsapp.disconnected", { workspaceId: context.workspaceId, channelAccountId, unsubscribed });
  return { ok: true, unsubscribed };
}

/**
 * The provider-reported quality rating Meta uses for a number one step from being restricted.
 *
 * Compared case-insensitively against the string Meta sends, because it is provider vocabulary rather
 * than ours and the comparison should not be the thing that breaks when they change its case.
 */
const FLAGGED_QUALITY = "red";
export const TEMPLATES_UNSYNCED_REASON = "TEMPLATES_UNSYNCED";
export const FLAGGED_QUALITY_REASON = "PROVIDER_QUALITY_RED";

function health(
  qualityRating: string | undefined,
  templatesUnsynced: boolean,
): { readonly status: "CONNECTED" | "DEGRADED"; readonly reason?: string } {
  if (qualityRating !== undefined && qualityRating.toLowerCase() === FLAGGED_QUALITY) {
    return { status: "DEGRADED", reason: FLAGGED_QUALITY_REASON };
  }
  // Recorded either way: the reason is the only thing an operator has to go on when a template send is
  // refused, and "we never managed to read your catalogue" is the answer.
  return templatesUnsynced ? { status: "CONNECTED", reason: TEMPLATES_UNSYNCED_REASON } : { status: "CONNECTED" };
}

function expiryOf(expiresInSeconds: number | undefined, now: Date): Date {
  return new Date(now.getTime() + (expiresInSeconds === undefined ? ASSUMED_TOKEN_TTL_MS : expiresInSeconds * 1000));
}

/** Provider vocabulary into this flow's vocabulary. Nothing from Meta's prose crosses. */
function reasonOf(reason: SignupFailureReason): ConnectFailureReason {
  switch (reason) {
    case "unavailable":
      return "provider_unavailable";
    case "missing_scope":
      return "missing_scope";
    case "wrong_app":
      return "wrong_app";
    case "asset_mismatch":
      return "asset_mismatch";
    case "invalid_pin":
      return "invalid_pin";
    case "invalid_response":
    case "provider_rejected":
      return "provider_rejected";
  }
}

function fail(dependencies: WhatsAppOnboardingDependencies, reason: ConnectFailureReason, code?: string): { readonly ok: false; readonly reason: ConnectFailureReason } {
  // Codes are logged, never returned: a provider code in a redirect is provider text on a page.
  dependencies.logger.warn("whatsapp.connect_failed", { reason, ...(code === undefined ? {} : { code }) });
  return { ok: false, reason };
}

function hashNonce(nonce: string): Uint8Array {
  return createHash("sha256").update(nonce, "utf8").digest();
}

/** Constant-time, because the comparison is against a value an attacker supplies and can vary. */
function nonceMatches(nonce: string, expected: Uint8Array): boolean {
  const actual = hashNonce(nonce);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
