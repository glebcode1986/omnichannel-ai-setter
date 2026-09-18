/**
 * The delivery coordinator's boundaries (DELIVERY_COORDINATOR.md, ADR-003, ADR-012, ADR-014).
 *
 * This is the only path by which an AI reply reaches a customer. Everything here is shaped by one fact:
 * **a send cannot be undone.** So the port is narrow — claim, send, settle — and every type is built to
 * make the dangerous move harder to express than the safe one.
 */
import type { ChannelType, SendResult, WindowDecision } from "@omnichannel/channel-core";
import type { AiMode, DeliveryJobStatus, HumanTakeoverState, ReasonCode } from "@omnichannel/domain";

import type { AccountHealth, HumanAgentAvailability, ReplyCycleState } from "../policy/inputs";

/** Who authorized this delivery. Automation cannot produce the human variant: it has no actor to name. */
export type DeliveryAuthority =
  | { readonly kind: "AUTOMATED" }
  | {
      /**
       * An explicitly human-approved send. Only this variant may use a provider's human-support path, and
       * eligibility is still re-checked immediately before dispatch — a decision a human made a minute ago
       * is not evidence about the window now.
       */
      readonly kind: "HUMAN_APPROVED";
      readonly approvedByUserId: string;
      readonly approvedAt: Date;
    };

/** Everything the coordinator re-reads immediately before claiming. Never cached from scheduling time. */
export interface DeliverySendContext {
  readonly deliveryJobId: string;
  readonly operationId: string;
  readonly draftId: string;
  readonly conversationId: string;
  readonly channel: ChannelType;
  readonly recipientExternalId: string;
  readonly channelAccountId: string;
  /** The reply itself. Absent means the draft was held or cleared, which is never sendable. */
  readonly text?: string;
  readonly status: DeliveryJobStatus;
  readonly attemptCount: number;
  readonly mode: AiMode;
  readonly aiEnabled: boolean;
  readonly takeover: HumanTakeoverState;
  readonly replyCycle: ReplyCycleState;
  readonly account: AccountHealth;
  readonly draftNeedsReview: boolean;
  /** True once any outbound message already exists for this draft: the send already happened. */
  readonly alreadySent: boolean;
}

/** How a delivery ended. One shape per durable outcome, so an impossible pair cannot be written. */
export type DeliverySettlement =
  | { readonly kind: "SENT"; readonly platformMessageId: string; readonly providerRequestId?: string }
  | { readonly kind: "CANCELLED"; readonly status: CancelledStatus; readonly reasons: readonly ReasonCode[] }
  | { readonly kind: "HELD"; readonly status: HeldStatus; readonly code?: string; readonly message: string }
  | { readonly kind: "RETRY"; readonly code?: string; readonly message: string }
  | { readonly kind: "EXHAUSTED"; readonly code?: string; readonly message: string };

export type CancelledStatus = Extract<DeliveryJobStatus, `CANCELLED_${string}`>;
export type HeldStatus = Extract<DeliveryJobStatus, `HELD_${string}`>;

export type ClaimOutcome =
  /** This worker owns the send. Exactly one caller can ever receive this for one operation. */
  | { readonly kind: "CLAIMED" }
  /** Another worker owns it, or it has already finished. Either way this worker must not send. */
  | { readonly kind: "NOT_CLAIMABLE"; readonly status: DeliveryJobStatus };

export interface DeliveryStore {
  /** Re-reads live state. Returns undefined when the job or its conversation no longer exists. */
  loadForSend(operationId: string): Promise<DeliverySendContext | undefined>;
  /**
   * Atomically moves one claimable delivery into SENDING. The database decides the winner, not the caller:
   * two workers racing the same operation must see one `CLAIMED` and one `NOT_CLAIMABLE`.
   */
  claim(operationId: string, claimedAt: Date): Promise<ClaimOutcome>;
  /** Writes the terminal (or retryable) outcome, and the sent message when there is one. */
  settle(operationId: string, settlement: DeliverySettlement, at: Date): Promise<void>;
  /** Returns a claimed delivery to SCHEDULED for a later attempt, without counting it as a failure. */
  reschedule(operationId: string, notBefore: Date): Promise<void>;
}

/** The one place a channel adapter is invoked for a customer-visible AI reply. */
export interface DeliverySendPort {
  send(input: DeliverySendCommand): Promise<SendResult>;
}

export interface DeliverySendCommand {
  readonly channel: ChannelType;
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly recipientExternalId: string;
  readonly text: string;
  /** Stable across every retry and restart, so the provider can recognise a repeat. */
  readonly operationId: string;
  readonly authority: DeliveryAuthority;
}

/** Live channel facts read at send time, not at scheduling time. */
export interface DeliveryChannelState {
  readonly window: WindowDecision;
  readonly humanAgent: HumanAgentAvailability;
  /** The provider's own latest permitted dispatch instant, if the channel imposes one. */
  readonly dispatchDeadline?: Date;
}

export interface DeliveryLogPort {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}
