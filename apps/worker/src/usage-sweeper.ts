/**
 * Giving back allowance nobody settled (#39, USAGE_METERING.md).
 *
 * A reservation holds part of a customer's allowance while work that may consume it runs. If the worker
 * holding it dies between reserving and finishing, nothing ever commits or releases it — and without this
 * loop that hold would sit on the counter until the cycle turned over, so a business would lose
 * transcription minutes to our crash rather than to its own use.
 *
 * Its own loop rather than a line in the retention sweeper, because the urgency is different: an expired
 * OAuth nonce row costs nothing by waiting an hour, and a held allowance costs a customer the thing they
 * paid for. The interval is minutes, not hours.
 *
 * Each expiry is a release, written to the ledger like any other, so the allowance reappears with a reason
 * attached instead of simply reappearing.
 */
import type { Logger } from "@omnichannel/observability";

import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface UsageSweeperOptions {
  readonly intervalMs: number;
  /** Releases holds that expired before this instant; returns how many were actually given back. */
  readonly releaseStaleReservations: (at: Date) => Promise<number>;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function startUsageSweeper(options: UsageSweeperOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "usage_reservations_released",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const released = await options.releaseStaleReservations(options.now());
      // Nothing at all on a quiet tick. A log line per hour saying "zero" trains an operator to ignore
      // the one that says something.
      return released === 0 ? undefined : { released };
    },
  });
}
