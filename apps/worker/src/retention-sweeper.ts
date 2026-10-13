/**
 * The housekeeping that keeps short-lived rows from living for ever (#57, P3-04).
 *
 * `channel_connect_states` holds the hash of an OAuth nonce and the scopes a connection asked for. Each
 * row is single-use and carries its own expiry, and `deleteExpiredChannelConnectStates` has existed to
 * remove them since onboarding was written — with no caller anywhere. Exported, tested, never run: the
 * same shape as Issue #9, and the same consequence, which is that the behaviour everybody believed was
 * happening was not.
 *
 * It is a loop rather than a one-off at boot because expiry is continuous: a worker that swept once at
 * startup would leave everything that expired afterwards until the next deploy.
 *
 * Deliberately not a queue job. There is no per-tenant work here and nothing to coordinate — it is one
 * statement over rows nobody owns, and putting it on a queue would make a failure something to retry
 * rather than something to run again in an hour anyway.
 */
import type { Logger } from "@omnichannel/observability";

import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface RetentionSweeperOptions {
  readonly intervalMs: number;
  /** Removes connect states that expired before this instant; returns how many went. */
  readonly deleteExpiredConnectStates: (before: Date) => Promise<number>;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function startRetentionSweeper(options: RetentionSweeperOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "retention_swept",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const connectStates = await options.deleteExpiredConnectStates(options.now());
      // Counts only, and nothing at all on a quiet tick. These rows carry a nonce hash and the scopes a
      // connection asked for, and neither belongs in a log line.
      return connectStates === 0 ? undefined : { connectStates };
    },
  });
}
