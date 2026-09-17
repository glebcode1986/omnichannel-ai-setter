import type { ChannelType } from "./channel";
import { literalGuard } from "./enum";
import type { BusinessProfileId, ChannelAccountId, ChannelIdentityId, ContactId, ContactPointId, WorkspaceId } from "./ids";

/**
 * Canonical customer inside **one Business Profile** (DATA_MODEL.md v0.4 §4). There is no default
 * cross-Business-Profile customer graph: the same person reaching two profiles is two contacts.
 */
export interface Contact {
  readonly id: ContactId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly displayName?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Links a contact to a provider/channel identity on one channel account of the same Business Profile.
 * The stable provider user ID is the identity key; username and display name are mutable attributes and
 * never identity evidence. Identities are never merged because names or usernames look alike.
 */
export interface ChannelIdentity {
  readonly id: ChannelIdentityId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly contactId: ContactId;
  readonly channelAccountId: ChannelAccountId;
  readonly channel: ChannelType;
  /** Stable provider user ID scoped to the channel account (e.g. an Instagram-scoped ID or wa_id). */
  readonly externalUserId: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Identity equality: the same stable provider user ID on the same channel account of the same Workspace and
 * Business Profile. Display names and usernames are ignored, and equal provider IDs in different Business
 * Profiles are different identities.
 */
export function isSameChannelIdentity(
  a: Pick<ChannelIdentity, "workspaceId" | "businessProfileId" | "channelAccountId" | "externalUserId">,
  b: Pick<ChannelIdentity, "workspaceId" | "businessProfileId" | "channelAccountId" | "externalUserId">,
): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.businessProfileId === b.businessProfileId &&
    a.channelAccountId === b.channelAccountId &&
    a.externalUserId === b.externalUserId
  );
}

export const CONTACT_POINT_TYPES = ["PHONE", "EMAIL"] as const;
export type ContactPointType = (typeof CONTACT_POINT_TYPES)[number];
export const isContactPointType = literalGuard(CONTACT_POINT_TYPES);

export const CONTACT_POINT_STATUSES = ["VERIFIED", "UNVERIFIED", "SUPERSEDED", "INVALID"] as const;
export type ContactPointStatus = (typeof CONTACT_POINT_STATUSES)[number];
export const isContactPointStatus = literalGuard(CONTACT_POINT_STATUSES);

/**
 * Phone/email of a contact (DATA_MODEL.md v0.4 §4). A matching contact point is at most duplicate-candidate
 * evidence, never an automatic merge. Normalization and matching are later identity-resolution work.
 */
export interface ContactPoint {
  readonly id: ContactPointId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly contactId: ContactId;
  readonly type: ContactPointType;
  readonly originalValue: string;
  /** Conservative normalized form when one is known; absent rather than guessed. */
  readonly normalizedValue?: string;
  readonly status: ContactPointStatus;
  /** Where the value came from (customer message, human confirmation, trusted import). */
  readonly source: string;
  readonly firstSeenAt: Date;
  readonly lastConfirmedAt?: Date;
}
