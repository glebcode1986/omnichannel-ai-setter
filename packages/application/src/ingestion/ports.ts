/**
 * Ports for channel-neutral webhook ingestion. `packages/db` implements the store, `packages/queue` the
 * debounce scheduler, and the apps compose them with channel adapters and logging.
 */
import type { ChannelAdapter, NormalizedChannelEventType } from "@omnichannel/channel-core";
import type {
  ChannelAccountStatus,
  ChannelCapabilities,
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
  /**
   * The provider's own ID for this account (Instagram's `entry.id`). It is here because binding an
   * adapter is synchronous and per-account: without it a composition root could only bind by workspace,
   * and a workspace with two accounts would be free to pick the wrong one.
   */
  readonly externalAccountId: string;
  /**
   * The provider account this one belongs to, when the channel has two levels.
   *
   * WhatsApp does: a number is owned by a messaging account, the webhook names that account in
   * `entry.id`, and the subscription and template catalogue live on it rather than on the number. It is
   * here for the same reason `externalAccountId` is — binding an adapter is synchronous, so a value the
   * adapter needs must arrive with the account rather than be fetched while binding.
   *
   * Absent for a channel with one level, which is every channel but WhatsApp today.
   */
  readonly parentExternalAccountId?: string;
  /**
   * What this account can carry, as recorded when it was connected.
   *
   * Carried so ingestion can act on a capability without a second read — specifically whether replies a
   * person sends outside this product are visible to it (#23). Absent when nothing was recorded, which
   * reads as no capabilities rather than as every capability.
   */
  readonly capabilities?: ChannelCapabilities;
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

/**
 * One inbound message whose recordings are owed a reading (Issue #21).
 *
 * The message rather than the media, because the pending rows were written in the same transaction as the
 * message and the worker reads them from there. A payload naming the media would be a second place the
 * same list lives, and the two would eventually disagree.
 */
export interface MediaTranscriptionPayload {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly correlationId: string;
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly messageId: string;
}

/**
 * A port of its own rather than a second method on the debounce scheduler.
 *
 * The two jobs have nothing in common but the queue they travel through: one waits out a burst, the other
 * reads a file. Folding them into one interface named for the first would make the name a lie, and a
 * composition root could then satisfy the type while wiring only half of what it implies.
 */
export interface MediaTranscriptionScheduler {
  scheduleMediaTranscription(job: MediaTranscriptionPayload, options: { readonly delayMs: number }): Promise<unknown>;
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

/** What every outbox entry carries, whatever kind of work it describes. */
interface OutboxEntryBase {
  readonly id: string;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly correlationId: string;
  /** Selected delay, counted from `createdAt`. */
  readonly delayMs: number;
  readonly createdAt: Date;
  /** Dispatch attempts so far, including the current claim. */
  readonly attempts: number;
}

/**
 * Discriminated on `kind`, so a payload can never be dispatched to the wrong scheduler. A flat shape with
 * a union payload would type-check while handing a transcription job to the debounce queue.
 */
export type OutboxEntry =
  | (OutboxEntryBase & { readonly kind: "INBOUND_DEBOUNCE"; readonly payload: InboundDebouncePayload })
  | (OutboxEntryBase & { readonly kind: "MEDIA_TRANSCRIPTION"; readonly payload: MediaTranscriptionPayload });

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
   *
   * For an inbound message it also settles any follow-up still waiting to chase this customer's silence
   * (#55) — in the same transaction, because "they replied" and "the chase is off" are one fact and a crash
   * between them would leave a worker chasing a question that has moved on. Named here rather than left to
   * the implementation: this is the only path a webhook takes, so it is the only place the cancellation can
   * live and be real.
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
  /**
   * Sets HUMAN_ACTIVE (or extends an existing human takeover) for native/manual activity, and settles any
   * follow-up still waiting on this conversation (#55).
   *
   * A person who answers from the provider's own app has taken the conversation over as surely as one who
   * pressed the button in ours, and automation does not interrupt either. The takeover started through our
   * UI is settled by the conversation-operations store; this is the other door into the same state, and a
   * guard on one of two doors is a guard on neither.
   */
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
    input: ProfileScope & { readonly dedupeKey: string; readonly correlationId: string; readonly delayMs: number } & (
        | { readonly kind: "INBOUND_DEBOUNCE"; readonly payload: InboundDebouncePayload }
        | { readonly kind: "MEDIA_TRANSCRIPTION"; readonly payload: MediaTranscriptionPayload }
      ),
  ): Promise<{ readonly id: string } | undefined>;

  /**
   * Records that this message's recordings are owed a reading (Issue #21).
   *
   * In the same transaction as the message, so a voice note cannot be stored without the product knowing
   * it has not been read yet — which is what lets the draft path tell "nothing was said" from "we have
   * not heard it yet" instead of drafting over silence.
   */
  recordPendingTranscripts(
    input: ProfileScope & {
      readonly messageId: string;
      readonly media: readonly { readonly providerMediaId: string; readonly mimeType?: string; readonly sizeBytes?: number }[];
    },
  ): Promise<{ readonly created: number }>;
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
