import { toDurationRangeMs, type DurationRangeMs, type MessageDeliveryStatus } from "@omnichannel/domain";

import type { ConversationSnapshot } from "./ports";

/**
 * Stage A debounce starts only for an open conversation with AI enabled that nobody has taken over
 * (ADR-004). Mode/policy checks run later, when the debounce fires and before any send.
 */
export function isEligibleForInboundDebounce(conversation: ConversationSnapshot): boolean {
  return conversation.status === "OPEN" && conversation.aiEnabled && conversation.takeoverState === "NONE";
}

const STATUS_RANK: Readonly<Record<Exclude<MessageDeliveryStatus, "FAILED">, number>> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

/**
 * Status webhooks arrive out of order and repeat. Statuses only move forward; FAILED applies only before
 * the platform confirmed delivery. Returns undefined when the stored status must stay unchanged.
 */
export function nextDeliveryStatus(
  current: MessageDeliveryStatus | null,
  incoming: Exclude<MessageDeliveryStatus, "PENDING">,
): MessageDeliveryStatus | undefined {
  if (current === incoming) {
    return undefined;
  }
  if (incoming === "FAILED") {
    return current === null || current === "PENDING" || current === "SENT" ? "FAILED" : undefined;
  }
  if (current === null || current === "FAILED") {
    return incoming;
  }
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : undefined;
}

/** Uniform sample inside a validated range; `random` must return a number in [0, 1). */
export function sampleDelayMs(range: DurationRangeMs, random: () => number): number {
  const { minMs, maxMs } = toDurationRangeMs(range.minMs, range.maxMs, "delayRange");
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("random() must return a number in [0, 1)");
  }
  return minMs + Math.floor(sample * (maxMs - minMs + 1));
}

/** Exponential outbox retry backoff: 5 s, 10 s, 20 s … capped at 5 minutes. */
export function outboxRetryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
}
