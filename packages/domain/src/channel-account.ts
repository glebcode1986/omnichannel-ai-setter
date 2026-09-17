import type { AiMode, ChannelCapabilities, ChannelType } from "./channel";
import { literalGuard } from "./enum";
import type { ChannelAccountId, CredentialReference, WorkspaceId } from "./ids";

/** Connection health; sends fail closed unless CONNECTED (INSTAGRAM_ADAPTER.md). */
export const CHANNEL_ACCOUNT_STATUSES = ["CONNECTED", "NEEDS_REAUTH", "DISCONNECTED"] as const;
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];
export const isChannelAccountStatus = literalGuard(CHANNEL_ACCOUNT_STATUSES);

/** A connected Instagram professional account or WhatsApp business phone-number asset. */
export interface ChannelAccount {
  readonly id: ChannelAccountId;
  readonly workspaceId: WorkspaceId;
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
