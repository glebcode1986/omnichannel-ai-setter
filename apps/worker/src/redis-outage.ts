/**
 * Owning the one escaped rejection this worker is allowed to survive (R2 finding on PR #51).
 *
 * A Redis client that is reconnecting rejects promises that nothing awaited — BullMQ's internals hold
 * several — and Node promotes an unhandled rejection to a fatal. That would turn the outage this worker
 * is built to run through into a crash loop, so it has to be excused. But excusing *every* escaped
 * rejection is not the same thing: a rejection can escape after a partial write, and then continuing
 * means processing policy-critical jobs on invariants nobody can vouch for.
 *
 * So the exemption is narrow in two independent ways, and both must hold:
 *
 * - the failure is a **connection-level** error code, not an application error that merely happened while
 *   Redis was down;
 * - one of the clients **this worker created** is not `ready` right now. An outage we are already in is
 *   the only thing this excuses, and the moment the client recovers the exemption goes with it.
 *
 * Everything else stays fatal, which is the direction to fail when the cause is unknown.
 */

/**
 * Error codes ioredis surfaces when a socket cannot be established or is lost. Every one of them means
 * the connection, not the command: a rejected `SET` carries no code at all.
 */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/** The slice of an ioredis client this needs. Narrow on purpose: nothing here may issue a command. */
export interface WatchedConnection {
  readonly status: string;
}

export interface RedisOutageWatch {
  watch(connection: WatchedConnection): void;
  /** True only when the reason is a connection failure *and* one of our clients is currently down. */
  survivable(reason: unknown): boolean;
}

export function createRedisOutageWatch(): RedisOutageWatch {
  const connections = new Set<WatchedConnection>();
  return {
    watch(connection) {
      connections.add(connection);
    },
    survivable(reason) {
      const code = (reason as { code?: unknown } | null | undefined)?.code;
      if (typeof code !== "string" || !CONNECTION_FAILURE_CODES.has(code)) {
        return false;
      }
      // Not "was Redis ever down" but "is it down now". A connection error arriving while every client
      // is healthy is not the reconnect case and is not excused.
      return [...connections].some((connection) => connection.status !== "ready");
    },
  };
}
