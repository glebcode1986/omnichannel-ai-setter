/**
 * Backpressure, applied (Issue #56).
 *
 * Measures how much work is waiting, hands the numbers to `decideBackpressure`, and turns its answer into
 * the kill switch the policy engine already honours. Reusing that switch rather than adding a second
 * mechanism is the point: there is one place that decides whether automated outbound may proceed, and an
 * automatic stop that took a different route would be a stop the audit trail could not explain.
 *
 * The guard only ever touches the system's own global switch. An operator's switch is untouchable here —
 * nothing automatic should be able to end a pause a person decided on.
 */
import { decideBackpressure, type BacklogReading, type BacklogThresholds } from "@omnichannel/application";
import type { SuspensionStore } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import type { QueueDepth } from "@omnichannel/queue";

import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface BacklogGuardOptions {
  readonly intervalMs: number;
  readonly thresholds: BacklogThresholds;
  readonly depths: () => Promise<readonly QueueDepth[]>;
  readonly suspensions: SuspensionStore;
  readonly logger: Logger;
  readonly now: () => Date;
  /**
   * Queues whose backlog means "stop adding outbound". Inbound is deliberately absent: a pile of customer
   * messages waiting to be stored is a reason to hurry, not a reason to stop, and stopping would lose
   * data no retry can recover.
   */
  readonly watched: readonly string[];
}

export function startBacklogGuard(options: BacklogGuardOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "backlog_guard",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const depths = await options.depths();
      const readings: readonly BacklogReading[] = depths
        .filter((depth) => options.watched.includes(depth.queueName))
        .map((depth) => ({ queue: depth.queueName, waiting: depth.waiting, oldestWaitingMs: depth.oldestWaitingMs }));
      const at = options.now();
      const active = await options.suspensions.activeSystemSuspension("BACKLOG", at);
      const decision = decideBackpressure(readings, options.thresholds, { suspended: active !== undefined }, at);

      if (decision.kind === "SUSPEND") {
        await options.suspensions.holdSystemSuspension({ reason: "BACKLOG", note: decision.detail, until: decision.until, at });
        // Logged on every renewal rather than only on the first: an operator watching a live incident
        // needs to see that the stop is still being held deliberately, not left behind by a dead guard.
        return { decision: decision.kind, detail: decision.detail, until: decision.until.toISOString() };
      }
      if (decision.kind === "LIFT") {
        await options.suspensions.endSystemSuspension("BACKLOG", at);
        return { decision: decision.kind, detail: decision.detail };
      }
      return undefined;
    },
  });
}
