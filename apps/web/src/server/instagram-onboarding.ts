/**
 * Instagram Login onboarding: start a connect, complete the callback, disconnect.
 *
 * The security of this flow rests on four things, all enforced here rather than in the route handlers:
 *
 * 1. **Two halves.** The OAuth `state` is a database row (single-use, short-lived, remembering who started
 *    the flow and for which Business Profile) *and* a cookie nonce whose hash is on that row. One half alone
 *    completes nothing, so neither a stolen link nor a forged cookie is enough.
 * 2. **Re-authorization at the callback.** Membership, role and profile access are re-read when the callback
 *    returns, so access revoked mid-flow takes effect immediately.
 * 3. **Least privilege, verified.** Meta reports which scopes the person actually granted; a missing one
 *    refuses the connection instead of storing a credential that cannot send.
 * 4. **No secret leaves memory.** Codes, tokens, the state value and the nonce never reach a log, a redirect
 *    target, an error message or a response body — only fixed reason codes do.
 *
 * Dependencies are injected so this can be tested without Meta, a database or a browser.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import {
  buildAuthorizeUrl,
  exchangeCode,
  exchangeForLongLivedToken,
  fetchIdentity,
  INSTAGRAM_CAPABILITIES,
  INSTAGRAM_MESSAGING_SCOPES,
  missingScopes,
  type InstagramOAuthConfig,
} from "@omnichannel/channel-instagram";
import { ChannelConnectError, type BusinessProfileContext, type InstagramOnboardingStore } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

/** How long a person has to finish the Instagram login before the state expires. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_COOKIE_NAME = "__Host-ig_oauth_state";
const CREDENTIAL_PURPOSE = "INSTAGRAM_ACCESS_TOKEN" as const;

export type ConnectFailureReason =
  | "invalid_state"
  | "denied"
  | "provider_rejected"
  | "provider_unavailable"
  | "missing_scope"
  | "already_connected"
  | "different_account"
  /** The plan does not sell this channel, or the workspace may not do paid work at all (#40). */
  | "not_entitled";

export interface OnboardingDependencies {
  readonly store: InstagramOnboardingStore;
  readonly oauth: InstagramOAuthConfig;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Opaque, unguessable values for the state ID and the cookie nonce. */
  readonly newId: () => string;
  readonly humanAgentApproval: "APPROVED" | "NOT_APPROVED" | "UNKNOWN";
}

export interface StartedConnect {
  /** Where the browser must be sent. Contains no secret of ours. */
  readonly authorizeUrl: string;
  /** Value for the state cookie; only its hash is stored. */
  readonly cookieNonce: string;
  readonly cookieMaxAgeSeconds: number;
}

export interface CallbackInput {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
  readonly cookieNonce: string | undefined;
}

export type CallbackResult =
  | { readonly ok: true; readonly workspaceId: string; readonly businessProfileId: string; readonly channelAccountId: string }
  | { readonly ok: false; readonly reason: ConnectFailureReason };

export async function startInstagramConnect(
  dependencies: OnboardingDependencies,
  context: BusinessProfileContext,
): Promise<StartedConnect> {
  const stateId = dependencies.newId();
  const cookieNonce = dependencies.newId();
  await dependencies.store.createConnectState(context, {
    stateId,
    nonceHash: hashNonce(cookieNonce),
    channel: "INSTAGRAM",
    requestedScopes: [...INSTAGRAM_MESSAGING_SCOPES],
    expiresAt: new Date(dependencies.now().getTime() + CONNECT_STATE_TTL_MS),
  });
  dependencies.logger.info("instagram.connect_started", {
    workspaceId: context.workspaceId,
    businessProfileId: context.businessProfileId,
  });
  return {
    authorizeUrl: buildAuthorizeUrl(dependencies.oauth, stateId),
    cookieNonce,
    cookieMaxAgeSeconds: Math.floor(CONNECT_STATE_TTL_MS / 1000),
  };
}

/**
 * Completes a callback. `authorize` re-checks the session against the state row; it is passed in so the
 * route can use the real request context while tests can supply a fake.
 */
export async function completeInstagramConnect(
  dependencies: OnboardingDependencies,
  input: CallbackInput,
  authorize: (workspaceId: string, businessProfileId: string) => Promise<BusinessProfileContext>,
): Promise<CallbackResult> {
  const now = dependencies.now();
  if (input.error !== undefined) {
    // The person said no, or Meta refused. Their message is untrusted text and is never echoed back.
    dependencies.logger.info("instagram.connect_denied", {});
    return fail(dependencies, "denied");
  }
  if (input.state === undefined || input.code === undefined || input.cookieNonce === undefined) {
    return fail(dependencies, "invalid_state");
  }

  const state = await dependencies.store.consumeConnectState({ stateId: input.state, now });
  if (state === undefined || state.channel !== "INSTAGRAM" || !nonceMatches(input.cookieNonce, state.nonceHash)) {
    // Unknown, replayed, expired and cookie-mismatched all fail identically.
    return fail(dependencies, "invalid_state");
  }

  // Re-authorized now, not when the flow started: a revoked membership or role must stop the connection.
  const context = await authorize(state.workspaceId, state.businessProfileId);
  if (context.userId !== state.userId) {
    return fail(dependencies, "invalid_state");
  }

  const exchanged = await exchangeCode(dependencies.oauth, input.code);
  if (!exchanged.ok) {
    return fail(dependencies, exchanged.reason === "unavailable" ? "provider_unavailable" : "provider_rejected", context);
  }
  const declined = missingScopes(exchanged.value.grantedScopes);
  if (declined.length > 0) {
    // Storing a credential that cannot read messages would create an account that looks connected and is not.
    dependencies.logger.warn("instagram.connect_missing_scope", {
      workspaceId: context.workspaceId,
      businessProfileId: context.businessProfileId,
      missing: declined,
    });
    return { ok: false, reason: "missing_scope" };
  }

  const longLived = await exchangeForLongLivedToken(dependencies.oauth, exchanged.value.accessToken);
  if (!longLived.ok) {
    return fail(dependencies, longLived.reason === "unavailable" ? "provider_unavailable" : "provider_rejected", context);
  }
  const identity = await fetchIdentity(dependencies.oauth, longLived.value.accessToken);
  if (!identity.ok) {
    return fail(dependencies, identity.reason === "unavailable" ? "provider_unavailable" : "provider_rejected", context);
  }
  if (identity.value.userId !== exchanged.value.userId) {
    // The token must belong to the account the exchange named; anything else is a mix-up we refuse.
    return fail(dependencies, "provider_rejected", context);
  }

  const expiresAt = new Date(now.getTime() + longLived.value.expiresInSeconds * 1000);
  try {
    const { channelAccountId } = await dependencies.store.connectAccount(context, {
      channel: "INSTAGRAM",
      // The messaging ID, never the app-scoped `id`: sends address /<IG_ID>/messages.
      externalAccountId: identity.value.userId,
      ...(identity.value.username === undefined ? {} : { displayName: identity.value.username }),
      capabilities: INSTAGRAM_CAPABILITIES,
      purpose: CREDENTIAL_PURPOSE,
      token: longLived.value.accessToken,
      expiresAt,
      now,
    });
    dependencies.logger.info("instagram.connected", {
      workspaceId: context.workspaceId,
      businessProfileId: context.businessProfileId,
      channelAccountId,
    });
    return { ok: true, workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, channelAccountId };
  } catch (error) {
    if (error instanceof ChannelConnectError) {
      // "already_connected" deliberately does not say where; that would disclose another Workspace.
      return fail(dependencies, error.reason, context);
    }
    throw error;
  }
}

export async function disconnectInstagramAccount(
  dependencies: OnboardingDependencies,
  context: BusinessProfileContext,
  channelAccountId: string,
): Promise<void> {
  // One transaction, because the two halves cannot be allowed to disagree. Done separately, a failure
  // between them leaves an account that reads as disconnected — slot freed, UI saying the connection is
  // gone — while its encrypted token is still there and still usable. That is the half-state nobody goes
  // looking for, so it is the one that must be impossible.
  await dependencies.store.disconnectAccount(context, channelAccountId, dependencies.now());
  dependencies.logger.info("instagram.disconnected", {
    workspaceId: context.workspaceId,
    businessProfileId: context.businessProfileId,
    channelAccountId,
  });
}

function fail(
  dependencies: OnboardingDependencies,
  reason: ConnectFailureReason,
  context?: BusinessProfileContext,
): { readonly ok: false; readonly reason: ConnectFailureReason } {
  dependencies.logger.warn("instagram.connect_failed", {
    reason,
    ...(context === undefined ? {} : { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId }),
  });
  return { ok: false, reason };
}

function hashNonce(nonce: string): Uint8Array {
  return createHash("sha256").update(nonce, "utf8").digest();
}

function nonceMatches(nonce: string, expected: Uint8Array): boolean {
  const actual = hashNonce(nonce);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
