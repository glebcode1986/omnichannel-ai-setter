import type { AiMode, ChannelCapabilities, ChannelType } from "./channel";
import { literalGuard } from "./enum";
import type { BusinessProfileId, ChannelAccountId, CredentialReference, WorkspaceId } from "./ids";

/**
 * Connection health; sends fail closed unless CONNECTED (INSTAGRAM_ADAPTER.md).
 *
 * `DEGRADED` is a connection the provider still honours but has flagged — WhatsApp onboarding
 * (WHATSAPP_ONBOARDING.md, Issue #19) needs it because Meta reports a number's quality rating, and a
 * number rated red is one message away from being restricted. It is deliberately not the same as
 * `NEEDS_REAUTH`: the credential and the assets are fine, so a person can still approve a reply, and
 * nothing automated goes out unattended until somebody has looked.
 */
export const CHANNEL_ACCOUNT_STATUSES = ["CONNECTED", "DEGRADED", "NEEDS_REAUTH", "DISCONNECTED"] as const;
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];
export const isChannelAccountStatus = literalGuard(CHANNEL_ACCOUNT_STATUSES);

/**
 * A connected Instagram professional account or WhatsApp business phone-number asset. It belongs to one
 * Business Profile, which initially owns at most one live account per channel (DATA_MODEL.md v0.4 §3).
 */
export interface ChannelAccount {
  readonly id: ChannelAccountId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly channel: ChannelType;
  /** Provider-assigned account/asset identifier; never a display string. */
  readonly externalAccountId: string;
  readonly displayName?: string;
  /** Reference to encrypted credentials; secrets are never stored on the entity. */
  readonly credentialsRef: CredentialReference;
  readonly status: ChannelAccountStatus;
  /** Last known capabilities; eligibility is always re-evaluated from live policy state before sending. */
  readonly capabilities: ChannelCapabilities;
  readonly defaultAiMode: AiMode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
