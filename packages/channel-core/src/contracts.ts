/**
 * Channel boundary contracts (docs/specs/CHANNEL_CONTRACTS.md). Channel adapters implement
 * `ChannelAdapter`; channel-neutral core code only sees these normalized shapes. Identifiers here are plain
 * strings because they come from the transport boundary; the application converts them to branded domain IDs.
 *
 * Scope (DATA_MODEL.md v0.4): every event and command names the Workspace, Business Profile and channel
 * account it belongs to. Adapters take that scope from their trusted account binding, never from the
 * provider payload, and the application checks it against the channel account it resolved itself.
 */
import type { ChannelCapabilities, ChannelType, MessageKind } from "@omnichannel/domain";

export type { AiMode, ChannelCapabilities, ChannelType, MessageKind } from "@omnichannel/domain";

// ---------------------------------------------------------------------------------------------------------
// Webhook input and verification
// ---------------------------------------------------------------------------------------------------------

/** Raw HTTP webhook exactly as received; adapters verify signatures against `rawBody` bytes. */
export interface RawWebhook {
  readonly method: "GET" | "POST";
  /** Header names lower-cased by the route before invoking the adapter. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly rawBody: Uint8Array;
  readonly receivedAt: Date;
}

/**
 * Result of authenticity verification. Only `VERIFIED` payloads may be normalized; `CHALLENGE` answers a
 * subscription handshake and never reaches business logic; `REJECTED` never reaches normalization.
 */
export type VerificationResult =
  | { readonly status: "VERIFIED" }
  | { readonly status: "CHALLENGE"; readonly responseBody: string }
  | { readonly status: "REJECTED"; readonly reason: string };

// ---------------------------------------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------------------------------------

export interface EventBase {
  readonly workspaceId: string;
  /** Business Profile owning the channel account; the customer-data boundary for everything the event touches. */
  readonly businessProfileId: string;
  readonly channel: ChannelType;
  readonly channelAccountId: string;
  /** Provider event identity; unique per channel account and used for idempotent ingestion. */
  readonly sourceEventId: string;
  /** Platform timestamp of the event. */
  readonly occurredAt: Date;
  /** Retention-controlled provider payload fragment for debugging; core logic must never read it. */
  readonly rawMeta?: unknown;
}

export interface MediaAttachment {
  readonly kind: Extract<MessageKind, "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT">;
  readonly providerMediaId?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly caption?: string;
}

export interface InboundMessageEvent extends EventBase {
  readonly type: "INBOUND_MESSAGE";
  /** Stable channel-scoped identity of the customer who sent the message. */
  readonly senderExternalId: string;
  readonly senderDisplayName?: string;
  readonly senderUsername?: string;
  /** Platform message ID when the provider supplies one. */
  readonly externalMessageId?: string;
  readonly messageKind: MessageKind;
  /** Normalized text or caption; untrusted customer content. */
  readonly text?: string;
  readonly media: readonly MediaAttachment[];
  readonly replyToExternalMessageId?: string;
}

/**
 * An outbound message observed on the platform. The application classifies it as our own echo or human
 * activity by correlating `platformMessageId` with stored send results (ADR-013), never by text equality.
 */
export interface OutboundEchoEvent extends EventBase {
  readonly type: "OUTBOUND_ECHO";
  readonly platformMessageId: string;
  readonly recipientExternalId: string;
  readonly messageKind: MessageKind;
  readonly text?: string;
  /** Provider-reported sending application identity, when the platform exposes one. */
  readonly sendingApplicationId?: string;
}

export const DELIVERY_STATUS_VALUES = ["SENT", "DELIVERED", "FAILED"] as const;
export type DeliveryStatusValue = (typeof DELIVERY_STATUS_VALUES)[number];

export interface ProviderError {
  /** Provider error code preserved for logs/metadata; core logic uses normalized outcomes only. */
  readonly code?: string;
  readonly message?: string;
}

export interface DeliveryStatusEvent extends EventBase {
  readonly type: "DELIVERY_STATUS";
  readonly platformMessageId: string;
  readonly status: DeliveryStatusValue;
  readonly error?: ProviderError;
}

export interface ReadStatusEvent extends EventBase {
  readonly type: "READ_STATUS";
  readonly readerExternalId: string;
  readonly platformMessageId: string;
}

export interface ReactionEvent extends EventBase {
  readonly type: "REACTION";
  readonly platformMessageId: string;
  readonly reactorExternalId: string;
  readonly action: "REACT" | "UNREACT";
  readonly reaction?: string;
}

export interface PostbackEvent extends EventBase {
  readonly type: "POSTBACK";
  readonly senderExternalId: string;
  /** Opaque payload the app configured on the button; untrusted when echoed back. */
  readonly payload: string;
  readonly title?: string;
  readonly relatedMessageId?: string;
}

export const CONVERSATION_POLICY_CHANGES = [
  "OPTED_OUT",
  "OPTED_IN",
  "WINDOW_OPENED",
  "WINDOW_CLOSED",
  "ACCOUNT_RESTRICTED",
  "ACCOUNT_RESTORED",
] as const;
export type ConversationPolicyChange = (typeof CONVERSATION_POLICY_CHANGES)[number];

/** Provider-reported change that affects messaging eligibility (opt-out, restriction, window change). */
export interface ConversationPolicyEvent extends EventBase {
  readonly type: "CONVERSATION_POLICY";
  readonly change: ConversationPolicyChange;
  readonly participantExternalId?: string;
  readonly detail?: string;
}

export type NormalizedChannelEvent =
  | InboundMessageEvent
  | OutboundEchoEvent
  | DeliveryStatusEvent
  | ReadStatusEvent
  | ReactionEvent
  | PostbackEvent
  | ConversationPolicyEvent;

export type NormalizedChannelEventType = NormalizedChannelEvent["type"];

export const NORMALIZED_CHANNEL_EVENT_TYPES = [
  "INBOUND_MESSAGE",
  "OUTBOUND_ECHO",
  "DELIVERY_STATUS",
  "READ_STATUS",
  "REACTION",
  "POSTBACK",
  "CONVERSATION_POLICY",
] as const satisfies readonly NormalizedChannelEventType[];

// ---------------------------------------------------------------------------------------------------------
// Messaging window / policy
// ---------------------------------------------------------------------------------------------------------

/**
 * Current messaging eligibility reported by the adapter. It is a platform fact; product policy decides
 * whether a TEMPLATE_ONLY conversation is held, reviewed or scheduled.
 */
export type WindowDecision =
  | { readonly state: "OPEN_FREEFORM"; readonly expiresAt?: Date }
  | { readonly state: "TEMPLATE_ONLY"; readonly expiresAt?: Date }
  | { readonly state: "NOT_ELIGIBLE"; readonly reason: string }
  | { readonly state: "UNKNOWN"; readonly reason: string };

export const WINDOW_STATES = ["OPEN_FREEFORM", "TEMPLATE_ONLY", "NOT_ELIGIBLE", "UNKNOWN"] as const satisfies readonly WindowDecision["state"][];

/** Only an open free-form window permits automated free-form sends; UNKNOWN fails closed. */
export function allowsFreeformSend(decision: WindowDecision, now: Date): boolean {
  return decision.state === "OPEN_FREEFORM" && (decision.expiresAt === undefined || decision.expiresAt.getTime() > now.getTime());
}

export interface ConversationPolicyContext {
  readonly workspaceId: string;
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly participantExternalId: string;
  /** Last qualifying inbound message from the participant, if any. */
  readonly lastInboundAt?: Date;
  readonly now: Date;
}

// ---------------------------------------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------------------------------------

export interface TemplateParameter {
  readonly name: string;
  readonly value: string;
}

/** Capability-gated outbound content; MVP supports text, WhatsApp adds approved templates. */
export type OutboundContent =
  | { readonly type: "TEXT"; readonly text: string }
  | {
      readonly type: "TEMPLATE";
      /** Provider-approved template name; never free text rewritten by a model. */
      readonly templateName: string;
      readonly languageCode: string;
      readonly parameters: readonly TemplateParameter[];
    };

export type OutboundContentType = OutboundContent["type"];

export const OUTBOUND_CONTENT_TYPES = ["TEXT", "TEMPLATE"] as const satisfies readonly OutboundContentType[];

export interface OutboundMessageCommand {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly recipientExternalId: string;
  /** Idempotency/audit identity generated by the application; stable across retries. */
  readonly operationId: string;
  readonly replyToExternalMessageId?: string;
  readonly content: OutboundContent;
}

/**
 * Normalized provider outcome. Adapters must not hide ambiguity behind exceptions: `AMBIGUOUS` means the
 * request may have reached the platform and must never be retried automatically.
 */
export type SendResult =
  | { readonly outcome: "ACCEPTED"; readonly platformMessageId: string; readonly providerRequestId?: string }
  | { readonly outcome: "REJECTED"; readonly retryable: boolean; readonly code?: string; readonly message: string }
  | { readonly outcome: "AMBIGUOUS"; readonly providerRequestId?: string; readonly code?: string; readonly message: string };

export const SEND_OUTCOMES = ["ACCEPTED", "REJECTED", "AMBIGUOUS"] as const satisfies readonly SendResult["outcome"][];

/** What delivery orchestration may do next with a send result. */
export type SendDisposition = "COMPLETED" | "RETRY_ALLOWED" | "FAILED" | "QUARANTINE_NO_RETRY";

/**
 * Maps a send result to the only permitted follow-up. AMBIGUOUS always quarantines (ADR-012): it is never
 * treated as retryable, regardless of any provider code it carries.
 */
export function sendDisposition(result: SendResult): SendDisposition {
  switch (result.outcome) {
    case "ACCEPTED":
      return "COMPLETED";
    case "REJECTED":
      return result.retryable ? "RETRY_ALLOWED" : "FAILED";
    case "AMBIGUOUS":
      return "QUARANTINE_NO_RETRY";
  }
}

// ---------------------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------------------

/**
 * Implemented by each channel package. Invariants: verification failures never reach normalization;
 * normalization is deterministic; adapters never call an LLM, choose reply content, implement human-like
 * delays or send on their own initiative.
 */
export interface ChannelAdapter {
  readonly channel: ChannelType;

  verifyWebhook(input: RawWebhook): Promise<VerificationResult>;
  normalizeWebhook(input: RawWebhook): Promise<NormalizedChannelEvent[]>;
  getCapabilities(channelAccountId: string): Promise<ChannelCapabilities>;
  evaluateWindow(ctx: ConversationPolicyContext): Promise<WindowDecision>;
  send(command: OutboundMessageCommand): Promise<SendResult>;
}
