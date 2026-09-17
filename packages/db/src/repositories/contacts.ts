import {
  isValidIdentifier,
  toChannelIdentityId,
  toContactId,
  type ChannelIdentityId,
  type ContactId,
} from "@omnichannel/domain";

import type { DbClient } from "../client";
import { DbInputError, rethrowAsTenantNotFound, TenantRecordNotFoundError } from "../errors";
import { profileScopeOf, type BusinessProfileContext } from "../tenancy";

export interface NewChannelIdentity {
  readonly channelAccountId: string;
  readonly externalUserId: string;
  readonly displayName?: string;
  readonly username?: string;
}

/**
 * Creates a contact and its first channel identity atomically inside the context's Business Profile. The
 * channel account must belong to the same profile; otherwise nothing is written and
 * `TenantRecordNotFoundError` is thrown. Contacts are canonical per Business Profile: the same provider user
 * reaching another profile becomes a separate contact there.
 */
export async function createContactWithChannelIdentity(
  db: DbClient,
  context: BusinessProfileContext,
  input: NewChannelIdentity,
): Promise<{ readonly contactId: ContactId; readonly channelIdentityId: ChannelIdentityId }> {
  const scope = profileScopeOf(context);
  if (!isValidIdentifier(input.channelAccountId)) {
    throw new DbInputError("channelAccountId", "must be a valid identifier");
  }
  if (!isValidIdentifier(input.externalUserId)) {
    throw new DbInputError("externalUserId", "must be a valid identifier");
  }

  const channelAccount = await db.channelAccount.findUnique({
    where: { workspaceId_businessProfileId_id: { ...scope, id: input.channelAccountId } },
    select: { id: true },
  });
  if (channelAccount === null) {
    throw new TenantRecordNotFoundError("ChannelAccount");
  }

  try {
    return await db.$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: { ...scope, displayName: input.displayName },
        select: { id: true },
      });
      const identity = await tx.channelIdentity.create({
        data: {
          ...scope,
          contactId: contact.id,
          channelAccountId: input.channelAccountId,
          externalUserId: input.externalUserId,
          displayName: input.displayName,
          username: input.username,
        },
        select: { id: true },
      });
      return { contactId: toContactId(contact.id), channelIdentityId: toChannelIdentityId(identity.id) };
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "ChannelAccount");
  }
}
