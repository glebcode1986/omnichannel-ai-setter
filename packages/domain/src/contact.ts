import type { ChannelType } from "./channel";
import type { ChannelAccountId, ContactId, ContactIdentityId, WorkspaceId } from "./ids";

/** Canonical person/customer inside one workspace. */
export interface Contact {
  readonly id: ContactId;
  readonly workspaceId: WorkspaceId;
  readonly displayName?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A channel-specific identity of a contact on one channel account. Identities are never merged across
 * channels just because names look similar; cross-channel linking is explicit (DATA_MODEL.md).
 */
export interface ContactIdentity {
  readonly id: ContactIdentityId;
  readonly workspaceId: WorkspaceId;
  readonly contactId: ContactId;
  readonly channelAccountId: ChannelAccountId;
  readonly channel: ChannelType;
  /** Provider user identifier scoped to the channel account (e.g. an Instagram-scoped ID or wa_id). */
  readonly externalUserId: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
