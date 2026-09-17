/**
 * Single-use state for an in-flight channel connect (OAuth).
 *
 * The row is the authority, not the browser cookie: it records who started the flow and for which Business
 * Profile, and it is consumed atomically, so replaying a callback cannot bind a second account or land in
 * another tenant. The cookie contributes a nonce whose hash is stored here, so neither half alone is enough.
 */
import { isValidIdentifier, type ChannelType } from "@omnichannel/domain";

import type { DbExecutor } from "../client";
import { DbInputError } from "../errors";
import { profileScopeOf, requireRole, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "../tenancy";

export interface ConnectStateRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly userId: string;
  readonly channel: ChannelType;
  readonly nonceHash: Uint8Array;
  readonly requestedScopes: readonly string[];
}

export async function createChannelConnectState(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: {
    readonly stateId: string;
    readonly nonceHash: Uint8Array;
    readonly channel: ChannelType;
    readonly requestedScopes: readonly string[];
    readonly expiresAt: Date;
  },
): Promise<void> {
  const scope = profileScopeOf(context);
  // Connecting a channel is an administrative act, checked again when the callback returns.
  requireRole(context, WORKSPACE_ADMIN_ROLES, "connecting channel accounts");
  if (!isValidIdentifier(input.stateId)) {
    throw new DbInputError("stateId", "must be a valid identifier");
  }
  await db.channelConnectState.create({
    data: {
      id: input.stateId,
      ...scope,
      userId: context.userId,
      channel: input.channel,
      nonceHash: Buffer.from(input.nonceHash),
      requestedScopes: [...input.requestedScopes],
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });
}

/**
 * Consumes the state exactly once. A conditional update is the whole point: two concurrent callbacks race on
 * the same row and only one can win, so a replay cannot create a second account.
 */
export async function consumeChannelConnectState(
  db: DbExecutor,
  input: { readonly stateId: string; readonly now: Date },
): Promise<ConnectStateRecord | undefined> {
  if (!isValidIdentifier(input.stateId)) {
    return undefined;
  }
  const claimed = await db.channelConnectState.updateMany({
    where: { id: input.stateId, consumedAt: null, expiresAt: { gt: input.now } },
    data: { consumedAt: input.now },
  });
  if (claimed.count !== 1) {
    // Unknown, already used or expired are deliberately indistinguishable to the caller.
    return undefined;
  }
  const row = await db.channelConnectState.findUniqueOrThrow({
    where: { id: input.stateId },
    select: { id: true, workspaceId: true, businessProfileId: true, userId: true, channel: true, nonceHash: true, requestedScopes: true },
  });
  return row;
}

/** Housekeeping for states nobody completed; they carry no secret, only an expiry. */
export async function deleteExpiredChannelConnectStates(db: DbExecutor, before: Date): Promise<number> {
  const { count } = await db.channelConnectState.deleteMany({ where: { expiresAt: { lt: before } } });
  return count;
}
