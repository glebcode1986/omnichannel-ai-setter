import { isValidIdentifier, type AiMode, type ChannelCapabilities, type ChannelType } from "@omnichannel/domain";

import type { DbExecutor } from "../client";
import { DbInputError } from "../errors";
import type { Prisma } from "../generated/prisma/client";
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
