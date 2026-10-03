/**
 * Reading how much work is waiting, and how long it has been waiting (Issue #56).
 *
 * Depth alone is a poor signal. A thousand jobs that entered a second ago is a burst, and a queue that
 * drains bursts is working; twelve jobs whose oldest has been waiting eleven minutes is a queue that has
 * stopped, and it is the second one that needs a person. So both numbers are read, and the age is the one
 * the guard and the health surface lean on.
 *
 * Nothing here mutates a queue. It is deliberately read-only: a monitor that could also drain or retry
 * would be a second path to sending, and there is supposed to be exactly one.
 */
import type { Logger } from "@omnichannel/observability";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { closeAll } from "./close-all";
import { DEFAULT_QUEUE_PREFIX, JOB_FAMILIES } from "./families";

export interface QueueDepth {
  readonly queueName: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  /** Age of the oldest job waiting to start, or 0 when nothing is waiting. */
  readonly oldestWaitingMs: number;
}

export interface QueueMonitor {
  depths(): Promise<readonly QueueDepth[]>;
  close(): Promise<void>;
}

export interface QueueMonitorOptions {
  /** Shared ioredis connection; owned and closed by the caller, as everywhere else in this package. */
  readonly connection: Redis;
  /**
   * Required, not optional.
   *
   * The queues below are objects this module constructs, so their failures are its to own — the same
   * rule the producer states. An optional logger would let a caller omit it and put the raw error back
   * outside the structured log, which is the defect this parameter exists to close.
   */
  readonly logger: Logger;
  readonly prefix?: string;
  readonly now?: () => Date;
}

export function createQueueMonitor(options: QueueMonitorOptions): QueueMonitor {
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const now = options.now ?? (() => new Date());
  const failing = new Set<string>();
  const queues = JOB_FAMILIES.map((family) => {
    const queue = new Queue(family.queueName, { connection: options.connection, prefix });
    // We construct this object, so its failures are ours to own — the same rule the producer states, and
    // the one this module was missing. Without a listener a connection failure here left BullMQ to
    // reject a promise nobody awaited: an unhandled rejection, which the worker's process guard reads as
    // unknown state and answers by exiting 1.
    //
    // That is how "rides out its own Redis being unreachable" failed about once in thirteen runs, and
    // more often under load. The worker was not riding anything out; it was being killed by its own
    // monitor's silence.
    queue.on("error", (error: Error) => {
      if (!failing.has(family.queueName)) {
        failing.add(family.queueName);
        // Name and code only: a connection error's message carries the host and can carry a password.
        options.logger.warn("queue.client_error", {
          queue: family.queueName,
          errorName: error.name,
          errorCode: typeof (error as { code?: unknown }).code === "string" ? (error as { code?: string }).code : undefined,
        });
      }
    });
    return queue;
  });

  return {
    async depths() {
      return Promise.all(
        queues.map(async (queue) => {
          // One waiting job, oldest first. `getWaiting(0, 0)` is the cheapest way to ask "how long has
          // the front of this queue been stuck", and BullMQ keeps waiting jobs in insertion order.
          const [counts, oldest] = await Promise.all([queue.getJobCounts("waiting", "active", "delayed", "failed"), queue.getWaiting(0, 0)]);
          const head = oldest[0];
          return {
            queueName: queue.name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            // `timestamp` is when the job was created. A delayed job is not waiting yet, and is not in
            // this list, so this age is time spent genuinely queued rather than time spent scheduled.
            oldestWaitingMs: head === undefined ? 0 : Math.max(0, now().getTime() - head.timestamp),
          } satisfies QueueDepth;
        }),
      );
    },
    async close() {
      await closeAll("monitor", queues, async (queue) => queue.close(), options.logger);
    },
  };
}
