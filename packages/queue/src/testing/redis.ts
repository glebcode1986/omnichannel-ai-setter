/**
 * Integration-test Redis harness. Set TEST_REDIS_URL (e.g. the local `compose.yaml` service); without it the
 * Redis suites are skipped unless REQUIRE_REDIS_TESTS=1 makes that an error. Each environment uses its own
 * BullMQ key prefix and deletes its keys afterwards, so suites never see each other's jobs.
 */
import { randomUUID } from "node:crypto";

import { createLogger, type Logger, type LogLevel } from "@omnichannel/observability";
import type { Redis } from "ioredis";

import { createRedisConnection } from "../connection";

export function redisTestsEnabled(): boolean {
  if (process.env.TEST_REDIS_URL) {
    return true;
  }
  if (process.env.REQUIRE_REDIS_TESTS === "1") {
    throw new Error("REQUIRE_REDIS_TESTS=1 but TEST_REDIS_URL is not set");
  }
  return false;
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface TestQueueEnvironment {
  readonly prefix: string;
  readonly logger: Logger;
  readonly logs: LogEntry[];
  /** Creates a connection that is closed by `dispose`. */
  connect(role: "producer" | "worker"): Redis;
  dispose(): Promise<void>;
}

export function createTestQueueEnvironment(): TestQueueEnvironment {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error("TEST_REDIS_URL is not set");
  }
  const prefix = `test-${randomUUID()}`;
  const logs: LogEntry[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (line) => {
      logs.push(JSON.parse(line) as LogEntry);
    },
  });
  const connections: Redis[] = [];

  return {
    prefix,
    logger,
    logs,
    connect(role) {
      const connection = createRedisConnection(url, role, logger);
      connections.push(connection);
      return connection;
    },
    async dispose() {
      // Close every connection first so no late writer (e.g. a force-closed worker) recreates keys.
      await Promise.all(connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
      const cleaner = createRedisConnection(url, "producer", logger);
      let cursor = "0";
      do {
        const [next, keys] = await cleaner.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
        cursor = next;
        if (keys.length > 0) {
          await cleaner.del(...keys);
        }
      } while (cursor !== "0");
      await cleaner.quit();
    },
  };
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
