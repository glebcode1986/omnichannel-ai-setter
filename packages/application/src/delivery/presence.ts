/**
 * When to say "read", when to show "typing", and when to say nothing at all (#22, P4-05).
 *
 * Presence is the one thing this product does that is purely cosmetic, and that is exactly why it needs
 * rules. A typing indicator is a promise that a reply is coming — the platform's own guidance is "only
 * display a typing indicator if you are going to respond" — so every case where the reply might not come
 * is a case where nothing should be shown.
 *
 * Three decisions live here and nothing else does.
 *
 * **It is separate from scheduling.** The reply's delay is chosen by the delay engine and is not negotiable
 * by presence; presence only picks a moment inside it. A presence setting can never move, shorten or
 * cancel a send, and there is no path in this file that returns a delay for the reply.
 *
 * **It is announced near the send, not at scheduling time.** The indicator has a short life at the
 * provider — far shorter than this product's human-like delay — so announcing it when the delay starts
 * would show it, drop it, and leave the customer watching nothing for a minute. The lifetime is a platform
 * fact and arrives as configuration, because this package cannot import a channel adapter.
 *
 * **It rests on the send's own judgement, not a second one.** `presenceVerdict` runs the same policy
 * evaluation the coordinator runs, against the same context shape, and announces only on the same
 * `SCHEDULE` answer that would let the reply go out. A shorter list of conditions here would be a second
 * definition of "still valid" that drifts from the real one, and the drift would show up as a customer
 * watching someone type a reply that was cancelled.
 *
 * Nothing in this file knows which channel it is talking about.
 */
import { DEFAULT_PRESENCE_TYPING_LEAD_MS, type PresenceMode } from "@omnichannel/domain";

import { evaluatePolicy } from "../policy/evaluate";

import { policyInputFor } from "./policy-input";
import type { DeliveryChannelStatePort, DeliverySendContext } from "./ports";

export interface PresenceSettings {
  /** What the business asked for; the vocabulary is the domain's, so there is one definition of it. */
  readonly mode: PresenceMode;
  /**
   * How long before the reply the indicator is raised.
   *
   * A product setting bounded by a platform one: see `presenceLeadMs`, which refuses to exceed the
   * indicator's own lifetime because showing it earlier would display it and drop it.
   */
  readonly typingLeadMs: number;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = { mode: "OFF", typingLeadMs: DEFAULT_PRESENCE_TYPING_LEAD_MS };

/** Why nothing was announced. Named rather than boolean, because an operator reading a log needs the why. */
export type PresenceSkipReason =
  | "MODE_OFF"
  | "CHANNEL_CANNOT"
  | "NO_INBOUND_MESSAGE"
  | "INBOUND_TOO_OLD"
  | "DELIVERY_NOT_SCHEDULED"
  | "SEND_NO_LONGER_APPROVED"
  | "ALREADY_DUE";

export type PresencePlan =
  | { readonly kind: "NONE"; readonly reason: PresenceSkipReason }
  /** Announce this many milliseconds from now, and whether the indicator is part of it. */
  | { readonly kind: "ANNOUNCE"; readonly delayMs: number; readonly typing: boolean };

/** What the channel can carry, taken from the account's own capabilities rather than from its name. */
export interface PresenceCapabilities {
  readonly readReceipts: boolean;
  readonly typingIndicator: boolean;
}

export interface PresencePlanInput {
  readonly settings: PresenceSettings;
  readonly capabilities: PresenceCapabilities;
  /** The reply's own delay, chosen by the delay engine. Presence fits inside it and never changes it. */
  readonly replyDelayMs: number;
  /**
   * How long this channel keeps a typing indicator up. A platform fact, injected because this package
   * cannot import the adapter that knows it.
   */
  readonly typingTtlMs: number;
  /**
   * Whether this deployment can actually deliver a reply on this channel.
   *
   * Not a channel capability and not a business setting: a deployment with no transport configured for a
   * channel will refuse the send when it comes due, and announcing that someone is typing a reply which
   * cannot be sent is the specific user experience the platform asks implementers to avoid.
   */
  readonly deliverable: boolean;
}

/**
 * How far ahead of the reply the indicator may be raised.
 *
 * Three bounds, and the tightest wins. It cannot exceed the indicator's own lifetime, or the customer sees
 * it vanish and then waits; it cannot exceed the reply's delay, or it would be scheduled before the reply
 * was decided; and it cannot be negative.
 */
export function presenceLeadMs(input: { readonly typingLeadMs: number; readonly replyDelayMs: number; readonly typingTtlMs: number }): number {
  const bounded = Math.min(Math.max(input.typingLeadMs, 0), Math.max(input.typingTtlMs, 0), Math.max(input.replyDelayMs, 0));
  return Number.isFinite(bounded) ? bounded : 0;
}

/**
 * Whether to schedule a presence announcement for a reply that was just scheduled, and when.
 *
 * Called at scheduling time, so it answers only the questions that are already settled then. Everything
 * that can still change between now and the announcement is asked again at `presenceVerdict`.
 */
export function planPresence(input: PresencePlanInput): PresencePlan {
  if (input.settings.mode === "OFF") {
    return { kind: "NONE", reason: "MODE_OFF" };
  }
  const typing = input.settings.mode === "READ_AND_TYPING" && input.capabilities.typingIndicator;
  if (!input.capabilities.readReceipts && !typing) {
    // Nothing this channel can carry. Scheduling the job anyway would be work that always declines.
    return { kind: "NONE", reason: "CHANNEL_CANNOT" };
  }
  if (!input.deliverable) {
    return { kind: "NONE", reason: "CHANNEL_CANNOT" };
  }
  if (!typing) {
    // A read receipt is a statement about a message that has already arrived, so it waits for nothing.
    return { kind: "ANNOUNCE", delayMs: 0, typing: false };
  }
  const lead = presenceLeadMs({ typingLeadMs: input.settings.typingLeadMs, replyDelayMs: input.replyDelayMs, typingTtlMs: input.typingTtlMs });
  return { kind: "ANNOUNCE", delayMs: Math.max(input.replyDelayMs - lead, 0), typing: true };
}

export interface PresenceVerdictInput {
  readonly settings: PresenceSettings;
  readonly capabilities: PresenceCapabilities;
  readonly context: DeliverySendContext;
  /** The customer's message the reply answers, as the provider identifies it. */
  readonly inboundProviderMessageId?: string;
  readonly inboundOccurredAt?: Date;
  /** How late the provider still accepts a read receipt. A platform fact, injected for the same reason. */
  readonly markReadMaxAgeMs: number;
  readonly now: Date;
}

export type PresenceVerdict =
  | { readonly kind: "SILENT"; readonly reason: PresenceSkipReason }
  | { readonly kind: "ANNOUNCE"; readonly inboundProviderMessageId: string; readonly typing: boolean };

/**
 * Whether to say anything, asked at the moment of announcing.
 *
 * The order is cheapest-first, but the one that carries the weight is the policy evaluation: it is the
 * same call the coordinator makes before it claims the send, so a conversation that has been taken over,
 * superseded by a newer customer message, switched off, suspended or disconnected answers `SILENT` here
 * for exactly the reason it would refuse the send a few seconds later.
 */
export function presenceVerdict(
  dependencies: { readonly channel: DeliveryChannelStatePort; readonly now: () => Date },
  input: PresenceVerdictInput,
): PresenceVerdict {
  if (input.settings.mode === "OFF") {
    return { kind: "SILENT", reason: "MODE_OFF" };
  }
  const typing = input.settings.mode === "READ_AND_TYPING" && input.capabilities.typingIndicator;
  if (!input.capabilities.readReceipts && !typing) {
    return { kind: "SILENT", reason: "CHANNEL_CANNOT" };
  }
  if (input.inboundProviderMessageId === undefined || input.inboundProviderMessageId === "") {
    // The provider identifies the message to mark by its own id. Without one there is nothing to say.
    return { kind: "SILENT", reason: "NO_INBOUND_MESSAGE" };
  }
  if (input.inboundOccurredAt !== undefined && input.now.getTime() - input.inboundOccurredAt.getTime() > input.markReadMaxAgeMs) {
    // Past the provider's own bound. Only reachable after an outage long enough that announcing presence
    // would be absurd anyway, which is why it is refused here rather than discovered as a provider error.
    return { kind: "SILENT", reason: "INBOUND_TOO_OLD" };
  }
  if (input.context.status !== "SCHEDULED") {
    // Claimed, sent, cancelled or held. One status covers all four, and it is the same one the claim uses.
    return { kind: "SILENT", reason: "DELIVERY_NOT_SCHEDULED" };
  }
  if (input.context.alreadySent) {
    return { kind: "SILENT", reason: "DELIVERY_NOT_SCHEDULED" };
  }
  const decision = evaluatePolicy(policyInputFor(dependencies, input.context));
  if (decision.action !== "SCHEDULE") {
    // The reply would not go out right now. Showing that somebody is typing it would be a promise this
    // product has already decided not to keep.
    return { kind: "SILENT", reason: "SEND_NO_LONGER_APPROVED" };
  }
  return { kind: "ANNOUNCE", inboundProviderMessageId: input.inboundProviderMessageId, typing };
}

/**
 * The effect itself, as the application sees it.
 *
 * A boolean, because nothing a caller can do about a failed presence effect is worth changing a reply for.
 * The implementation is a channel adapter's; this package never learns what the request looks like.
 */
export interface PresenceAnnouncer {
  announce(input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly channelAccountId: string;
    readonly inboundProviderMessageId: string;
    readonly typing: boolean;
  }): Promise<boolean>;
}
