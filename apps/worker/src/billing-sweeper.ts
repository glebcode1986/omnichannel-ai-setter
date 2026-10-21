/**
 * Releasing the charge path an abandoned checkout is holding (#46, ADR-019).
 *
 * A workspace may have one live charge path, and a partial unique index enforces it — which is what makes
 * "one active commercial arrangement must not be double-charged across two providers" an impossibility
 * rather than a rule. The cost of that guarantee is that an unfinished checkout holds the slot: somebody
 * opens a checkout, goes to find their card, closes the tab, and without this loop every later attempt is
 * refused until an operator looks at the table.
 *
 * So the slot is released when the quote's own clock runs out, or after `CHECKOUT_TTL_MS` for a checkout
 * that had no clock. Each release is audited, because the acceptance snapshot the attempt carried stays
 * and somebody may later ask why that attempt ended.
 *
 * Its own loop rather than a line in the retention sweeper, for the reason the usage sweeper has its own:
 * an expired OAuth nonce costs nothing by waiting an hour, and a blocked purchase costs a sale.
 */
import type { Logger } from "@omnichannel/observability";

import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface BillingSweeperOptions {
  readonly intervalMs: number;
  /** Releases the charge paths of checkouts that expired before this instant; returns how many. */
  readonly expireStaleCheckouts: (at: Date) => Promise<number>;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function startBillingSweeper(options: BillingSweeperOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "checkouts_expired",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const released = await options.expireStaleCheckouts(options.now());
      // Nothing at all on a quiet tick. A line per hour saying "zero" trains an operator to ignore the
      // one that says something.
      return released === 0 ? undefined : { released };
    },
  });
}
