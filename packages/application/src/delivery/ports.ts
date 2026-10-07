/**
 * The delivery coordinator's boundaries (DELIVERY_COORDINATOR.md, ADR-003, ADR-012, ADR-014).
 *
 * This is the only path by which an AI reply reaches a customer. Everything here is shaped by one fact:
 * **a send cannot be undone.** So the port is narrow — claim, send, settle — and every type is built to
 * make the dangerous move harder to express than the safe one.
 */
import type { ChannelType, SendResult, WindowDecision } from "@omnichannel/channel-core";
import type {
  AiMode,
  CommercialAccess,
  DeliveryJobStatus,
  HumanTakeoverState,
  ReasonCode,
  SendAuthority,
  SuspensionReason,
  SuspensionScope,
} from "@omnichannel/domain";

import type { AccountHealth, HumanAgentAvailability, PolicyLimits, ReplyCycleState } from "../policy/inputs";

/**
 * Who authorized this delivery (`SendAuthority`, in the domain).
 *
 * Automation cannot produce the human variant: it has no actor to name. Only that variant may use a
 * provider's human-support path, and eligibility is still re-checked immediately before dispatch — a
 * decision a human made a minute ago is not evidence about the window now.
 */
export type DeliveryAuthority = SendAuthority;

/**
 * An opaque description of the live state a send was authorized against.
 *
 * `loadForSend` produces it and `claim` re-asserts it, in the same statement that takes the send. Nothing in
 * between may read it, and the type makes sure nothing can: a check the coordinator performed on it would be
 * a read followed by an act, which is exactly the gap this exists to close. The coordinator's only duty is to
 * carry it back unchanged.
 */
declare const stateGuard: unique symbol;
export interface DeliveryStateGuard {
  readonly [stateGuard]: never;
}

/** Everything the coordinator re-reads immediately before claiming. Never cached from scheduling time. */
export interface DeliverySendContext {
  readonly deliveryJobId: string;
  readonly operationId: string;
  /** The tenant this delivery belongs to; channel rules are evaluated within it, never across it. */
  readonly workspaceId: string;
  /**
   * The AI draft this send came from, absent when a person composed it themselves (ADR-018 Option B).
   *
   * Absent rather than a placeholder: a coordinator that received an invented draft id would log and
   * reconcile against a row that does not exist. Everything else about the send is identical, which is
   * the point — there is one send path, not two.
   */
  readonly draftId?: string;
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
  /**
   * The automation limits this send must satisfy.
   *
   * Read here, with everything else, rather than passed in by the caller. The limits and the mode come out
   * of the same policy rows, and a caller that read them separately would be judging one version of the
   * business's settings while the claim bound another — two reads, one of them unguarded.
   */
  readonly limits: PolicyLimits;
  /** The customer's own last message: where a provider's messaging window starts counting. */
  readonly lastInboundAt?: Date;
  /**
   * On whose authority this send would go out, read from the row the approval was recorded on.
   *
   * Here rather than on the command, because an authority is something that was *granted*. A background job
   * constructing one as it goes is how a queue retry acquires a human's approval it was never given — and
   * how a human's approval is silently lost, which is the same bug seen from the other side.
   */
  readonly authority: DeliveryAuthority;
  /**
   * An operator's kill switch covering this send, if one does.
   *
   * Read here with everything else, and re-asserted by the claim. It used to be resolved by the worker
   * before the coordinator ran, on the reasoning that a switch is a decision about the system rather than
   * a fact about this conversation — which is true, and was still the wrong place for it. A value read
   * before the coordinator's own read cannot be bound by the claim, so a switch committed in between was
   * simply invisible: the guard had no predicate for it and the send went out behind the operator's back.
   */
  readonly outboundSuspended?: { readonly scope: SuspensionScope; readonly reason: SuspensionReason };
  /**
   * What this workspace's commercial state permits, resolved in the same read as everything else (#40).
   *
   * Here for the reason the kill switch is here, learned the same way: a value resolved before the
   * coordinator's own read cannot be bound by the claim, so a change committed in between would be
   * invisible. And this one changes with the clock as well as with writes — a trial can expire during a
   * two-minute delay without anybody writing a row — so the claim re-resolves it rather than comparing
   * row versions.
   */
  readonly commercial: CommercialAccess;
  /** What every fact above was read from, for the claim to re-assert. Opaque here, and deliberately so. */
  readonly guard: DeliveryStateGuard;
}

/**
 * The live channel facts a send depends on — the messaging window, the human-support exception, the
 * provider's own dispatch deadline.
 *
 * Derived from a context rather than read on its own, so the window and the state the claim binds come
 * from the same instant. Channel-specific rules live behind this port: answering "may a reply still be
 * sent?" is a channel question, and it must not require the credentials needed to actually send one.
 */
export interface DeliveryChannelStatePort {
  stateFor(context: DeliverySendContext): DeliveryChannelState;
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
  | { readonly kind: "NOT_CLAIMABLE"; readonly status: DeliveryJobStatus }
  /**
   * The state the approval rested on moved between the read and the claim — a customer wrote again, a
   * colleague took the conversation over, the business changed its automation. Nothing was claimed and
   * nothing was sent. The caller must re-read and re-judge before it may try again.
   */
  | { readonly kind: "STATE_CHANGED" };

export interface DeliveryStore {
  /** Re-reads live state. Returns undefined when the job or its conversation no longer exists. */
  /**
   * @param at the instant the decision is being made. Explicit, like `claim`'s, because whether a kill
   * switch is live is a question about a moment, and a store that read its own clock would answer it at a
   * different one from the gate that uses the answer.
   */
  loadForSend(operationId: string, at: Date): Promise<DeliverySendContext | undefined>;
  /**
   * Atomically moves one claimable delivery into SENDING — and only while the state it was judged against is
   * still the live state.
   *
   * The database decides the winner *and* the freshness, in one statement: two workers racing the same
   * operation see one `CLAIMED` and one `NOT_CLAIMABLE`, and a claim whose context has been overtaken sees
   * `STATE_CHANGED` instead of a send. Taking the whole context rather than an id is the point — a claim
   * that has not read the state it is claiming against cannot be expressed.
   */
  claim(context: DeliverySendContext, claimedAt: Date): Promise<ClaimOutcome>;
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
