import type { Logger } from "@omnichannel/observability";

/**
 * Closes several BullMQ clients, observing every failure and absorbing the ones that arrive late.
 *
 * Two separate defects live here, and both killed the worker during a Redis outage it had just survived.
 *
 * **`Promise.all` leaves rejections unobserved.** It settles on the first one, so closing four clients
 * against an unreachable Redis produced up to three unhandled rejections. `allSettled` observes each.
 *
 * **BullMQ removes the listener that would have handled a late failure.** Every `Queue` and `Worker` owns
 * a `RedisConnection` whose constructor does `this.initializing.catch(err => this.emit('error', err))`,
 * and whose `close()` ends with `removeAllListeners()`. A connection attempt still in flight at close
 * therefore rejects afterwards and emits `error` with nothing listening — and an `error` event with no
 * listener throws, inside a `.catch()` callback, which Node reports as an *unhandled rejection* carrying
 * the original `ECONNREFUSED` and only native frames. That is why it took reading BullMQ to place.
 *
 * `process-guards.ts` then does exactly what it documents: an unhandled rejection is unknown state, so
 * the process exits 1. It also says where the fix belongs — "a reconnect failure that genuinely may be
 * survived is contained where it is produced — by the client or emitter that owns it" — and we construct
 * these clients, so their late failures are ours to absorb. Re-attaching after `close()` is that
 * containment.
 *
 * Errors are logged by name only: a connection failure's message carries the host and can carry a
 * password, and a shutdown log is read by everyone.
 */
export async function closeAll<T>(
  what: string,
  items: readonly T[],
  close: (item: T) => Promise<unknown>,
  logger: Logger,
): Promise<void> {
  const outcomes = await Promise.allSettled(
    items.map(async (item) => {
      try {
        await close(item);
      } finally {
        absorbLateConnectionErrors(item, what, logger);
      }
    }),
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      logger.warn("queue.close_failed", { what, errorName: nameOf(outcome.reason) });
    }
  }
}

/**
 * Re-attaches an error listener to a closed client's connections.
 *
 * Both field names on purpose: a `Worker` keeps its blocking client on `blockingConnection` and its
 * ordinary one on `connection`, and a `Queue` has only the latter. Neither is declared publicly, hence
 * the cast — attaching to the `Worker` or `Queue` itself is not enough, because the emit happens on the
 * connection after its forwarding to the owner was removed.
 */
function absorbLateConnectionErrors(item: unknown, what: string, logger: Logger): void {
  const owner = item as Record<string, { on?: (event: string, listener: (error: unknown) => void) => void } | undefined>;
  for (const field of ["blockingConnection", "connection"]) {
    owner[field]?.on?.("error", (error: unknown) => {
      logger.debug("queue.client_error_after_close", { what, errorName: nameOf(error) });
    });
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
