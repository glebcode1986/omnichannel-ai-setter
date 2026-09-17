import type { Logger } from "@omnichannel/observability";
import { Redis } from "ioredis";

export type RedisRole = "producer" | "worker";

/**
 * Creates an ioredis connection for BullMQ. Workers need `maxRetriesPerRequest: null` so blocking
 * commands survive reconnects; producers give up after a few reconnect attempts so an enqueue fails
 * instead of hanging a request. Connection errors are logged once per outage without the URL (it may
 * embed credentials).
 */
export function createRedisConnection(url: string, role: RedisRole, logger: Logger): Redis {
  const connection = new Redis(url, { maxRetriesPerRequest: role === "worker" ? null : 3 });

  let unavailable = false;
  connection.on("error", (error: unknown) => {
    if (!unavailable) {
      unavailable = true;
      logger.warn("queue.redis_unavailable", {
        role,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: (error as { code?: unknown } | undefined)?.code,
      });
    }
  });
  connection.on("ready", () => {
    if (unavailable) {
      unavailable = false;
      logger.info("queue.redis_recovered", { role });
    }
  });
  return connection;
}
