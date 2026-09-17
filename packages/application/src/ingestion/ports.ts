/**
 * Ports for channel-neutral webhook ingestion. `packages/db` implements the store, `packages/queue` the
 * debounce scheduler, and the apps compose them with channel adapters and logging.
 */
import type { ChannelAdapter, NormalizedChannelEventType } from "@omnichannel/channel-core";
import type {
  ChannelAccountStatus,
  ChannelType,
  ConversationStatus,
  HumanTakeoverState,
  MediaReference,
  MessageDeliveryStatus,
  MessageKind,
} from "@omnichannel/domain";

/** Structured audit/diagnostic log. Fields must never contain message text or credentials. */
export interface LogPort {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Channel account a webhook route resolves to (system lookup; no user session is involved). */
export interface WebhookAccount {
  readonly workspaceId: string;
  readonly channelAccountId: string;
  readonly channel: ChannelType;
  readonly status: ChannelAccountStatus;
}

export interface ChannelAdapterProvider {
  /** Adapter bound to this account, or undefined when this deployment has no adapter for the channel. */
  adapterFor(account: WebhookAccount): ChannelAdapter | undefined;
}

/** Job payload for Stage A debounce (mirrors the `inbound-debounce.v1` queue contract). */
export interface InboundDebouncePayload {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly anchorMessageId: string;
  readonly anchorInboundAt: string;
}

export interface DebounceScheduler {
  scheduleInboundDebounce(job: InboundDebouncePayload, options: { readonly delayMs: number }): Promise<unknown>;
}

/** What happened to one verified, normalized event; stored with the source event for audit. */
export type IngestionOutcome =
  | "INBOUND_STORED"
  | "INBOUND_DUPLICATE_MESSAGE"
  | "OWN_ECHO"
  | "HUMAN_TAKEOVER"
  | "OUTBOUND_DUPLICATE_MESSAGE"
  | "STATUS_APPLIED"
  | "STATUS_UNCHANGED"
  | "STATUS_UNMATCHED"
  | "IGNORED_UNSUPPORTED";

export interface SourceEventKey {
  readonly workspaceId: string;
  readonly channelAccountId: string;
  readonly sourceEventId: string;
}

export interface ConversationSnapshot {
  readonly conversationId: string;
  readonly status: ConversationStatus;
  readonly aiEnabled: boolean;
  readonly takeoverState: HumanTakeoverState["state"];
}

export interface StoredMessageStatus {
  readonly messageId: string;
  readonly deliveryStatus: MessageDeliveryStatus | null;
}

export interface OutboxEntry {
  readonly id: string;
  readonly kind: "INBOUND_DEBOUNCE";
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly payload: InboundDebouncePayload;
  /** Selected debounce delay, counted from `createdAt`. */
  readonly delayMs: number;
  readonly createdAt: Date;
  /** Dispatch attempts so far, including the current claim. */
  readonly attempts: number;
}

/** Writes performed for one event; they commit or roll back together. */
export interface IngestionTransaction {
  /** Records the source event; DUPLICATE when it was already recorded (the event is then skipped). */
  claimSourceEvent(
    event: SourceEventKey & {
      readonly eventType: NormalizedChannelEventType;
      readonly occurredAt: Date;
      readonly correlationId: string;
    },
  ): Promise<"NEW" | "DUPLICATE">;
  completeSourceEvent(event: SourceEventKey & { readonly outcome: IngestionOutcome }): Promise<void>;

  ensureContactIdentity(input: {
    readonly workspaceId: string;
    readonly channelAccountId: string;
    readonly externalUserId: string;
    readonly displayName?: string;
    readonly username?: string;
  }): Promise<{ readonly contactIdentityId: string }>;
  ensureConversation(input: {
    readonly workspaceId: string;
    readonly channelAccountId: string;
    readonly contactIdentityId: string;
  }): Promise<ConversationSnapshot>;

  /** Returns undefined when a message with the same platform ID already exists. */
  insertMessage(input: {
    readonly workspaceId: string;
    readonly channelAccountId: string;
    readonly conversationId: string;
    readonly direction: "IN" | "OUT";
    readonly source: "PARTICIPANT" | "HUMAN";
    readonly channelMessageId?: string;
    readonly kind: MessageKind;
    readonly text?: string;
    readonly media: readonly MediaReference[];
    readonly replyToChannelMessageId?: string;
    readonly deliveryStatus?: MessageDeliveryStatus;
    readonly occurredAt: Date;
  }): Promise<{ readonly messageId: string } | undefined>;
  /** Advances last inbound/outbound and inbox activity timestamps monotonically. */
  recordActivity(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly direction: "IN" | "OUT";
    readonly occurredAt: Date;
  }): Promise<void>;

  /** Whether a platform message ID belongs to an app-originated send (stored operation or delivery job). */
  isAppOriginatedMessage(input: {
    readonly workspaceId: string;
    readonly channelAccountId: string;
    readonly platformMessageId: string;
  }): Promise<boolean>;
  /** Sets HUMAN_ACTIVE (or extends an existing human takeover) for native/manual activity. */
  startHumanTakeover(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly since: Date;
    readonly pausedUntil: Date;
  }): Promise<void>;

  findMessageByPlatformId(input: {
    readonly workspaceId: string;
    readonly channelAccountId: string;
    readonly platformMessageId: string;
  }): Promise<StoredMessageStatus | undefined>;
  updateMessageDeliveryStatus(input: {
    readonly workspaceId: string;
    readonly messageId: string;
    readonly deliveryStatus: MessageDeliveryStatus;
    readonly occurredAt: Date;
  }): Promise<void>;

  /** Adds an outbox entry unless one with the same dedupe key exists (then returns undefined). */
  addOutboxEntry(input: {
    readonly workspaceId: string;
    readonly kind: "INBOUND_DEBOUNCE";
    readonly dedupeKey: string;
    readonly correlationId: string;
    readonly payload: InboundDebouncePayload;
    readonly delayMs: number;
  }): Promise<{ readonly id: string } | undefined>;
}

export interface IngestionStore {
  findWebhookAccount(channel: ChannelType, channelAccountId: string): Promise<WebhookAccount | undefined>;
  transaction<T>(work: (tx: IngestionTransaction) => Promise<T>): Promise<T>;

  /** Leases undispatched entries that are due (optionally only the given IDs) so one dispatcher owns each. */
  claimOutboxEntries(input: {
    readonly now: Date;
    readonly limit: number;
    readonly leaseMs: number;
    readonly ids?: readonly string[];
  }): Promise<OutboxEntry[]>;
  markOutboxDispatched(input: { readonly id: string; readonly now: Date }): Promise<void>;
  markOutboxFailed(input: { readonly id: string; readonly errorName: string; readonly retryAt: Date }): Promise<void>;
}
