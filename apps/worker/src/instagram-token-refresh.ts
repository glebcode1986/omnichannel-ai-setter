/**
 * Keeping one Instagram connection alive (#9).
 *
 * A long-lived Instagram token lasts 60 days and has to be exchanged for a new one before it expires.
 * Nothing about that is a web request: it happens on Meta's clock, for every connected account, whether or
 * not anybody opens the dashboard. So it belongs to the worker, next to the other loops that exist because
 * the world moves while nobody is looking.
 *
 * This is the policy for a single account; `instagram-token-sweeper.ts` is what walks the accounts. The
 * ordering is the policy:
 *
 * 1. **An expired token is not a refresh, it is a re-authorization.** Meta refuses to refresh one, so
 *    calling it would be a request we know the answer to, and the honest answer for the operator is "this
 *    connection needs you".
 * 2. **A token minted minutes ago is not due.** Meta refuses to refresh anything younger than 24 hours, so
 *    a fresh connect must not be sent there only to be rejected.
 * 3. **A refusal is a re-authorization; an outage is not.** `unavailable` means we never got an answer and
 *    the next sweep asks again. Anything else means Meta looked at this token and said no.
 * 4. **A rotation that lost a race is dropped, never forced.** The new token was minted for a state of the
 *    connection that no longer exists.
 *
 * It takes its primitives as functions rather than a store and an HTTP client, for the same reason the
 * reconciliation sweeper does: the policy above is the part worth testing, and it should be testable
 * without a database or Meta.
 */
import { isRefreshEligible, type LongLivedToken, type OAuthResult } from "@omnichannel/channel-instagram";
import type { InstagramTokenRefreshTarget, StoredCredential } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

export type TokenRefreshOutcome =
  /** A new token is stored and the connection is good for another term. */
  | "REFRESHED"
  /** Too young to refresh. Nothing was asked of Meta and nothing is wrong. */
  | "NOT_DUE"
  /** Only a person can fix this one: the token is expired, or Meta refused it. */
  | "NEEDS_REAUTH"
  /** Meta did not answer. The token is untouched and the next sweep tries again. */
  | "UNAVAILABLE"
  /** The credential disappeared or was revoked between the sweep and the read. */
  | "NO_CREDENTIAL"
  /** Somebody disconnected or re-authorized while Meta was answering; the new token was discarded. */
  | "SUPERSEDED";

export interface TokenRefreshDependencies {
  /** The account's current secret, or undefined when it is gone or revoked. */
  readonly readCredential: (target: InstagramTokenRefreshTarget) => Promise<StoredCredential | undefined>;
  readonly refresh: (token: string) => Promise<OAuthResult<LongLivedToken>>;
  readonly rotate: (input: {
    readonly workspaceId: string;
    readonly credentialId: string;
    readonly token: string;
    readonly expiresAt: Date;
    readonly refreshedAt: Date;
    /** The mint time this rotation was computed from; the write lands only if it is still current. */
    readonly mintedAt: Date;
  }) => Promise<"ROTATED" | "SUPERSEDED">;
  /** Guarded on the same mint time, so a connection re-authorized in the meantime is left alone. */
  readonly markNeedsReauthorization: (input: {
    readonly workspaceId: string;
    readonly channelAccountId: string;
    readonly mintedAt: Date;
  }) => Promise<boolean>;
  readonly logger: Logger;
  readonly now: () => Date;
}

export async function refreshInstagramToken(
  dependencies: TokenRefreshDependencies,
  target: InstagramTokenRefreshTarget,
): Promise<TokenRefreshOutcome> {
  const now = dependencies.now();
  const stored = await dependencies.readCredential(target);
  if (stored === undefined || stored.expiresAt === null) {
    return "NO_CREDENTIAL";
  }
  // The mint time is re-read here rather than taken from the sweep, because the sweep's batch may be
  // minutes old by the time this row's turn comes and a refresh elsewhere may have moved it.
  const identity = { workspaceId: target.workspaceId, channelAccountId: target.channelAccountId, mintedAt: stored.mintedAt };

  if (stored.expiresAt.getTime() <= now.getTime()) {
    await dependencies.markNeedsReauthorization(identity);
    dependencies.logger.warn("instagram.token_expired", {
      workspaceId: target.workspaceId,
      businessProfileId: target.businessProfileId,
      channelAccountId: target.channelAccountId,
    });
    return "NEEDS_REAUTH";
  }
  if (!isRefreshEligible(stored.mintedAt, stored.expiresAt, now)) {
    return "NOT_DUE";
  }

  const refreshed = await dependencies.refresh(stored.token);
  if (!refreshed.ok) {
    if (refreshed.reason === "unavailable") {
      return "UNAVAILABLE";
    }
    await dependencies.markNeedsReauthorization(identity);
    // Code only: Meta's prose can quote the request, and the request carries the token.
    dependencies.logger.warn("instagram.refresh_rejected", {
      workspaceId: target.workspaceId,
      businessProfileId: target.businessProfileId,
      channelAccountId: target.channelAccountId,
      reason: refreshed.reason,
      ...(refreshed.code === undefined ? {} : { code: refreshed.code }),
    });
    return "NEEDS_REAUTH";
  }

  const rotation = await dependencies.rotate({
    workspaceId: target.workspaceId,
    credentialId: stored.credentialId,
    token: refreshed.value.accessToken,
    expiresAt: new Date(now.getTime() + refreshed.value.expiresInSeconds * 1000),
    refreshedAt: now,
    mintedAt: stored.mintedAt,
  });
  if (rotation === "SUPERSEDED") {
    dependencies.logger.info("instagram.refresh_discarded", {
      workspaceId: target.workspaceId,
      businessProfileId: target.businessProfileId,
      channelAccountId: target.channelAccountId,
      reason: "credential changed during refresh",
    });
    return "SUPERSEDED";
  }
  dependencies.logger.info("instagram.token_refreshed", {
    workspaceId: target.workspaceId,
    businessProfileId: target.businessProfileId,
    channelAccountId: target.channelAccountId,
  });
  return "REFRESHED";
}
