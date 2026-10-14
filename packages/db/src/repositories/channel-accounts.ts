import { isValidIdentifier, type AiMode, type ChannelCapabilities, type ChannelType } from "@omnichannel/domain";

import type { DbExecutor } from "../client";
import { DbInputError, isUniqueViolation, rethrowAsTenantNotFound, TenantRecordNotFoundError } from "../errors";
import type { ChannelAccountStatus, Prisma } from "../generated/prisma/client";

/** Connection state of a channel account, mirrored from the schema enum. */
export type ChannelAccountStatusValue = ChannelAccountStatus;
import { recordAuditEvent } from "../audit-store";
import { profileScopeOf, requireRole, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "../tenancy";

/** Channel account fields safe to return to callers; credential references stay inside persistence. */
const channelAccountSelect = {
  id: true,
  workspaceId: true,
  businessProfileId: true,
  channel: true,
  externalAccountId: true,
  displayName: true,
  status: true,
  capabilities: true,
  defaultAiMode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChannelAccountSelect;

export type ChannelAccountRecord = Prisma.ChannelAccountGetPayload<{ select: typeof channelAccountSelect }>;

export interface NewChannelAccount {
  readonly channel: ChannelType;
  readonly externalAccountId: string;
  readonly displayName?: string;
  readonly capabilities: ChannelCapabilities;
  readonly defaultAiMode?: AiMode;
}

/** Connects a channel account to the context's Business Profile (OWNER/ADMIN only). */
export async function createChannelAccount(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: NewChannelAccount,
): Promise<ChannelAccountRecord> {
  const scope = profileScopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "connecting channel accounts");
  if (!isValidIdentifier(input.externalAccountId)) {
    throw new DbInputError("externalAccountId", "must be a valid identifier");
  }
  return db.channelAccount.create({
    data: {
      ...scope,
      channel: input.channel,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
      capabilities: { ...input.capabilities },
      defaultAiMode: input.defaultAiMode ?? "OFF",
    },
    select: channelAccountSelect,
  });
}

/** Why a connect attempt did not produce a connected account. Fixed vocabulary; never provider prose. */
export type ChannelConnectFailure = "already_connected" | "different_account";

export class ChannelConnectError extends Error {
  readonly reason: ChannelConnectFailure;

  constructor(reason: ChannelConnectFailure) {
    super(`channel account could not be connected: ${reason}`);
    this.name = "ChannelConnectError";
    this.reason = reason;
  }
}

export interface ConnectChannelAccountInput {
  readonly channel: ChannelType;
  /** Provider account ID (for Instagram, the professional account's messaging ID). */
  readonly externalAccountId: string;
  readonly displayName?: string;
  readonly capabilities: ChannelCapabilities;
  readonly credentialId: string;
}

/**
 * Connects or reconnects one provider account to this Business Profile.
 *
 * A reconnect updates the existing row rather than replacing it: every conversation, message and inbound
 * event references this account, and the schema refuses to delete or renumber it — history must survive a
 * token refresh. Reconnecting a *different* provider account is refused instead of silently rebinding, and
 * an account already live elsewhere fails with a reason that does not disclose where.
 */
export async function connectChannelAccount(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: ConnectChannelAccountInput,
): Promise<ChannelAccountRecord> {
  const scope = profileScopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "connecting channel accounts");
  if (!isValidIdentifier(input.externalAccountId)) {
    throw new DbInputError("externalAccountId", "must be a valid identifier");
  }

  // Only a *live* account owns the profile's channel slot, matching the partial unique index. A
  // disconnected row is history: it must not stop the profile from connecting a different account later.
  const live = await db.channelAccount.findFirst({
    where: { ...scope, channel: input.channel, status: { not: "DISCONNECTED" } },
    select: { id: true, externalAccountId: true, credentialId: true },
  });
  if (live !== null && live.externalAccountId !== input.externalAccountId) {
    // This profile already speaks for another Instagram account; swapping it would orphan its history.
    throw new ChannelConnectError("different_account");
  }
  // Reconnecting an account that was disconnected revives its own row rather than creating a second one,
  // which would also collide on the account's unique credential reference.
  const existing =
    live ??
    (await db.channelAccount.findFirst({
      where: { ...scope, channel: input.channel, externalAccountId: input.externalAccountId },
      orderBy: { createdAt: "desc" },
      select: { id: true, externalAccountId: true, credentialId: true },
    }));

  try {
    const account =
      existing === null
        ? await db.channelAccount.create({
            data: {
              ...scope,
              channel: input.channel,
              externalAccountId: input.externalAccountId,
              displayName: input.displayName,
              capabilities: { ...input.capabilities },
              credentialId: input.credentialId,
              status: "CONNECTED",
            },
            select: channelAccountSelect,
          })
        : await db.channelAccount.update({
            where: { workspaceId_businessProfileId_id: { ...scope, id: existing.id } },
            data: {
              displayName: input.displayName,
              capabilities: { ...input.capabilities },
              credentialId: input.credentialId,
              status: "CONNECTED",
            },
            select: channelAccountSelect,
          });
    // Admin-only to read, because it says which provider account this business now speaks as.
    await recordAuditEvent(db, context, {
      kind: "CHANNEL_CONNECTED",
      summary: `Connected ${input.channel} account ${input.displayName}`,
      subjectType: "channel_accounts",
      subjectId: account.id,
      actorUserId: context.userId,
      channelAccountId: account.id,
      detail: { channel: input.channel, reconnected: existing !== null },
    });
    return account;
  } catch (error) {
    // The live-account index is global on purpose: one provider account may be live in one place only.
    if (isUniqueViolation(error)) {
      throw new ChannelConnectError("already_connected");
    }
    throw error;
  }
}

/** Connection-state transitions (expiry, re-authorization, disconnect). Capabilities are left untouched. */
export async function setChannelAccountStatus(
  db: DbExecutor,
  context: BusinessProfileContext,
  channelAccountId: string,
  status: ChannelAccountStatus,
): Promise<ChannelAccountRecord> {
  const scope = profileScopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "changing channel account status");
  if (!isValidIdentifier(channelAccountId)) {
    throw new TenantRecordNotFoundError("ChannelAccount");
  }
  try {
    return await db.channelAccount.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
      data: { status },
      select: channelAccountSelect,
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "ChannelAccount");
  }
}

/** Refreshes the capability snapshot after a reconnect or a provider change. */
export async function updateChannelAccountCapabilities(
  db: DbExecutor,
  context: BusinessProfileContext,
  channelAccountId: string,
  capabilities: ChannelCapabilities,
): Promise<ChannelAccountRecord> {
  const scope = profileScopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "updating channel account capabilities");
  if (!isValidIdentifier(channelAccountId)) {
    throw new TenantRecordNotFoundError("ChannelAccount");
  }
  try {
    return await db.channelAccount.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
      data: { capabilities: { ...capabilities } },
      select: channelAccountSelect,
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "ChannelAccount");
  }
}

/** The credential a system flow must decrypt to act as this account; never exposed to browser callers. */
export async function getChannelAccountCredentialId(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  channelAccountId: string,
): Promise<string | undefined> {
  const account = await db.channelAccount.findUnique({
    where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
    select: { credentialId: true },
  });
  return account?.credentialId ?? undefined;
}

/** One Instagram connection whose stored token is close enough to expiry to be worth refreshing. */
export interface InstagramTokenRefreshTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  readonly credentialId: string;
  /** When the stored token was minted. Meta refuses to refresh one younger than 24 hours. */
  readonly mintedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Connections whose token expires before `dueBefore`, oldest expiry first.
 *
 * Unscoped on purpose, like the reconciliation queries: a token expires on Meta's clock and not on anyone's
 * visit to a dashboard, so the process that keeps connections alive runs across every workspace and has no
 * member to be authorized as. Nothing is decrypted here — a refresh needs to know *which* credential and
 * *when* it was minted, and the secret is read one row at a time by the caller that is about to use it.
 *
 * Only `CONNECTED` accounts: a disconnected one has no connection to keep, and one already marked
 * `NEEDS_REAUTH` is waiting for a person, not for us.
 */
export async function findInstagramTokensDueForRefresh(
  db: DbExecutor,
  options: { readonly dueBefore: Date; readonly limit: number },
): Promise<readonly InstagramTokenRefreshTarget[]> {
  const rows = await db.channelAccount.findMany({
    where: {
      channel: "INSTAGRAM",
      status: "CONNECTED",
      credential: { purpose: "INSTAGRAM_ACCESS_TOKEN", revokedAt: null, expiresAt: { not: null, lte: options.dueBefore } },
    },
    select: {
      id: true,
      workspaceId: true,
      businessProfileId: true,
      credentialId: true,
      credential: { select: { expiresAt: true, refreshedAt: true, createdAt: true } },
    },
    orderBy: { credential: { expiresAt: "asc" } },
    take: options.limit,
  });
  return rows.flatMap((row) => {
    // The query already requires both, so this narrows rather than filters. Written as a `flatMap` so a
    // schema change that made either nullable in practice drops the row instead of asserting over it.
    if (row.credentialId === null || row.credential === null || row.credential.expiresAt === null) {
      return [];
    }
    return [
      {
        workspaceId: row.workspaceId,
        businessProfileId: row.businessProfileId,
        channelAccountId: row.id,
        credentialId: row.credentialId,
        mintedAt: row.credential.refreshedAt ?? row.credential.createdAt,
        expiresAt: row.credential.expiresAt,
      },
    ];
  });
}

/**
 * Marks a connection as needing re-authorization — but only if the credential that failed is still the one
 * the account is using.
 *
 * The condition is the same one `rotateChannelCredential` applies, and for the same reason. Between a
 * provider refusing a token and this write, somebody may have re-authorized the account; marking it then
 * would tell an operator to reconnect something they just reconnected, and the account would refuse to
 * send until they did it again. Matching the mint time makes that case a no-op.
 *
 * Returns whether this call changed the row. `false` also covers the account that was already marked, or
 * disconnected: both are states a person owns, and neither is ours to overwrite.
 */
export async function markChannelAccountNeedsReauthorization(
  db: DbExecutor,
  input: { readonly workspaceId: string; readonly channelAccountId: string; readonly mintedAt: Date },
): Promise<boolean> {
  if (!isValidIdentifier(input.channelAccountId)) {
    return false;
  }
  const marked = await db.channelAccount.updateMany({
    where: {
      workspaceId: input.workspaceId,
      id: input.channelAccountId,
      status: "CONNECTED",
      credential: { OR: [{ refreshedAt: input.mintedAt }, { refreshedAt: null, createdAt: input.mintedAt }] },
    },
    data: { status: "NEEDS_REAUTH" },
  });
  return marked.count === 1;
}

export async function getChannelAccount(
  db: DbExecutor,
  context: BusinessProfileContext,
  channelAccountId: string,
): Promise<ChannelAccountRecord | null> {
  const scope = profileScopeOf(context);
  if (!isValidIdentifier(channelAccountId)) {
    return null;
  }
  return db.channelAccount.findUnique({
    where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
    select: channelAccountSelect,
  });
}

export async function listChannelAccounts(db: DbExecutor, context: BusinessProfileContext): Promise<ChannelAccountRecord[]> {
  const scope = profileScopeOf(context);
  return db.channelAccount.findMany({
    where: scope,
    select: channelAccountSelect,
    orderBy: { createdAt: "asc" },
  });
}
