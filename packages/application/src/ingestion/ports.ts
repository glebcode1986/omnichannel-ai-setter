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

/**
 * Channel account a webhook route resolves to (system lookup; no user session is involved). The account
 * belongs to exactly one Business Profile, which scopes every customer-data write of its events.
 */
export interface WebhookAccount {
  readonly workspaceId: string;
  readonly businessProfileId: string;
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
  readonly businessProfileId: string;
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

/** Workspace + Business Profile scope carried by every ingestion write. */
export interface ProfileScope {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

export interface SourceEventKey extends ProfileScope {
  readonly channelAccountId: string;
  readonly sourceEventId: string;
}

export interface ConversationSnapshot {
  readonly conversationId: string;
  readonly contactId: string;
  readonly stateVersion: number;
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
  readonly businessProfileId: string;
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

  /**
   * Finds or creates the contact + channel identity for a stable provider user ID on one channel account,
   * inside the resolved Business Profile only. Usernames/display names are refreshed, never used as keys.
   */
  ensureChannelIdentity(
    input: ProfileScope & {
      readonly channelAccountId: string;
      readonly externalUserId: string;
      readonly displayName?: string;
      readonly username?: string;
    },
  ): Promise<{ readonly channelIdentityId: string; readonly contactId: string }>;
  ensureConversation(
    input: ProfileScope & {
      readonly channelAccountId: string;
      readonly channelIdentityId: string;
      readonly contactId: string;
    },
  ): Promise<ConversationSnapshot>;

  /** Returns undefined when a message with the same platform ID already exists. */
  insertMessage(
    input: ProfileScope & {
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
  },
  ): Promise<{ readonly messageId: string } | undefined>;
  /**
   * Records a newly stored participant message or unmatched human outbound: advances last inbound/outbound
   * and inbox timestamps monotonically and increments the conversation state version by exactly one, in the
   * same transaction. Never called for duplicates, own echoes or status events.
   */
  recordActivity(
    input: ProfileScope & {
      readonly conversationId: string;
      readonly direction: "IN" | "OUT";
      readonly occurredAt: Date;
    },
  ): Promise<void>;

  /** Whether a platform message ID belongs to an app-originated send (stored operation or delivery job). */
  isAppOriginatedMessage(
    input: ProfileScope & { readonly channelAccountId: string; readonly platformMessageId: string },
  ): Promise<boolean>;
  /** Sets HUMAN_ACTIVE (or extends an existing human takeover) for native/manual activity. */
  startHumanTakeover(
    input: ProfileScope & { readonly conversationId: string; readonly since: Date; readonly pausedUntil: Date },
  ): Promise<void>;

  /**
   * Finds the message by platform message ID and locks it until the transaction ends, so concurrent status
   * events for the same message are applied one after another against the latest committed status.
   */
  findMessageByPlatformId(
    input: ProfileScope & { readonly channelAccountId: string; readonly platformMessageId: string },
  ): Promise<StoredMessageStatus | undefined>;
  updateMessageDeliveryStatus(
    input: ProfileScope & {
      readonly messageId: string;
      readonly deliveryStatus: MessageDeliveryStatus;
      readonly occurredAt: Date;
    },
  ): Promise<void>;

  /** Adds an outbox entry unless one with the same dedupe key exists (then returns undefined). */
  addOutboxEntry(
    input: ProfileScope & {
    readonly kind: "INBOUND_DEBOUNCE";
    readonly dedupeKey: string;
    readonly correlationId: string;
    readonly payload: InboundDebouncePayload;
    readonly delayMs: number;
  },
  ): Promise<{ readonly id: string } | undefined>;
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

/**
 * Why a webhook failed verification, as this application classifies it.
 *
 * A closed set owned here, not a string owned by an adapter. The adapter's own `reason` is free text
 * produced from raw headers, query values and body bytes, so it can contain a bearer token, a signature
 * or a fragment of a customer's message — and a structured log is the last place any of those should
 * reach. The diagnostic value of that string is real but it is not worth the class of leak it opens, so
 * it is deliberately discarded rather than sanitized: a heuristic redactor is a promise that the next
 * unexpected format will also be caught, and it will not be.
 *
 * Keeping the VERIFIED-but-not-a-delivery case as its own code matters for the same reason. Folding it
 * back into one label is how a future edit reintroduces "and a bit of detail about which" as free text.
 */
export const VERIFICATION_FAILURES = [
  /** The adapter refused the request; why it refused is not recorded. */
  "ADAPTER_REJECTED",
  /** The signature was accepted, but the request is not a delivery. */
  "VERIFIED_NON_POST",
] as const;
export type VerificationFailure = (typeof VERIFICATION_FAILURES)[number];
