/**
 * End-to-end test harness for the worker: a freshly migrated PostgreSQL database plus an isolated BullMQ key
 * prefix on Redis. Needs TEST_DATABASE_URL (a user that may CREATE DATABASE) and TEST_REDIS_URL, e.g. the local
 * `compose.yaml` services. Without them the suites are skipped, unless REQUIRE_DB_TESTS=1 or
 * REQUIRE_REDIS_TESTS=1 makes that an error.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { createDbClient, type DbClient } from "@omnichannel/db";
import { createLogger, type Logger } from "@omnichannel/observability";
import { createRedisConnection } from "@omnichannel/queue";
import type { Redis } from "ioredis";

const execFileAsync = promisify(execFile);

export function endToEndTestsEnabled(): boolean {
  if (process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL) {
    return true;
  }
  if (process.env.REQUIRE_DB_TESTS === "1" || process.env.REQUIRE_REDIS_TESTS === "1") {
    throw new Error("worker end-to-end tests are required but TEST_DATABASE_URL and TEST_REDIS_URL are not both set");
  }
  return false;
}

export interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface EndToEndInfrastructure {
  readonly db: DbClient;
  /** BullMQ key prefix unique to this environment. */
  readonly prefix: string;
  readonly logger: Logger;
  readonly logs: LogLine[];
  /** Creates a Redis connection that `dispose` closes. */
  connect(role: "producer" | "worker"): Redis;
  dispose(): Promise<void>;
}

export async function createEndToEndInfrastructure(): Promise<EndToEndInfrastructure> {
  const databaseUrl = requiredEnv("TEST_DATABASE_URL");
  const redisUrl = requiredEnv("TEST_REDIS_URL");
  const logs: LogLine[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => logs.push(JSON.parse(line) as LogLine) });

  const name = `omnichannel_e2e_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  await withAdminClient(databaseUrl, (admin) => admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  const dropDatabase = () => withAdminClient(databaseUrl, (admin) => admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  try {
    const dbPackageDir = resolveDbPackageDir();
    await execFileAsync(path.join(dbPackageDir, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: dbPackageDir,
      env: { ...process.env, DATABASE_URL: url.toString() },
    });
  } catch (error) {
    await dropDatabase();
    throw error;
  }

  const db = createDbClient({ connectionString: url.toString() });
  const prefix = `e2e-${randomUUID()}`;
  const connections: Redis[] = [];

  return {
    db,
    prefix,
    logger,
    logs,
    connect(role) {
      const connection = createRedisConnection(redisUrl, role, logger);
      connections.push(connection);
      return connection;
    },
    async dispose() {
      await Promise.all(connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
      const cleaner = createRedisConnection(redisUrl, "producer", logger);
      let cursor = "0";
      do {
        const [next, keys] = await cleaner.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
        cursor = next;
        if (keys.length > 0) {
          await cleaner.del(...keys);
        }
      } while (cursor !== "0");
      await cleaner.quit();
      await db.$disconnect();
      await dropDatabase();
    },
  };
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** @omnichannel/db owns the Prisma schema, migrations and CLI; its entry point is src/index.ts. */
function resolveDbPackageDir(): string {
  const loader = createRequire(import.meta.url);
  return path.resolve(path.dirname(loader.resolve("@omnichannel/db")), "..");
}

async function withAdminClient<T>(connectionString: string, action: (admin: DbClient) => Promise<T>): Promise<T> {
  const admin = createDbClient({ connectionString });
  try {
    return await action(admin);
  } finally {
    await admin.$disconnect();
  }
}
