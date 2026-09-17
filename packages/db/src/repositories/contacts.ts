import {
  isValidIdentifier,
  toContactId,
  toContactIdentityId,
  type ContactId,
  type ContactIdentityId,
} from "@omnichannel/domain";

import type { DbClient } from "../client";
import { DbInputError, rethrowAsTenantNotFound, TenantRecordNotFoundError } from "../errors";
import { scopeOf, type WorkspaceContext } from "../tenancy";

export interface NewContactIdentity {
  readonly channelAccountId: string;
  readonly externalUserId: string;
  readonly displayName?: string;
  readonly username?: string;
}

/**
 * Creates a canonical contact and its first channel identity atomically. The channel account must belong
 * to the caller's workspace; otherwise nothing is written and `TenantRecordNotFoundError` is thrown.
 */
export async function createContactWithIdentity(
  db: DbClient,
  context: WorkspaceContext,
  input: NewContactIdentity,
): Promise<{ readonly contactId: ContactId; readonly contactIdentityId: ContactIdentityId }> {
  const workspaceId = scopeOf(context);
  if (!isValidIdentifier(input.channelAccountId)) {
    throw new DbInputError("channelAccountId", "must be a valid identifier");
  }
  if (!isValidIdentifier(input.externalUserId)) {
    throw new DbInputError("externalUserId", "must be a valid identifier");
  }

  const channelAccount = await db.channelAccount.findUnique({
    where: { workspaceId_id: { workspaceId, id: input.channelAccountId } },
    select: { id: true },
  });
  if (channelAccount === null) {
    throw new TenantRecordNotFoundError("ChannelAccount");
  }

  try {
    return await db.$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: { workspaceId, displayName: input.displayName },
        select: { id: true },
      });
      const identity = await tx.contactIdentity.create({
        data: {
          workspaceId,
          contactId: contact.id,
          channelAccountId: input.channelAccountId,
          externalUserId: input.externalUserId,
          displayName: input.displayName,
          username: input.username,
        },
        select: { id: true },
      });
      return { contactId: toContactId(contact.id), contactIdentityId: toContactIdentityId(identity.id) };
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "ChannelAccount");
  }
}
