/**
 * Integration-test database harness. Each call creates a uniquely named, empty PostgreSQL database, applies
 * the committed migrations with `prisma migrate deploy` (proving they apply to an empty database) and drops
 * the database afterwards.
 *
 * Set TEST_DATABASE_URL to a PostgreSQL URL whose user may CREATE DATABASE (e.g. the local `compose.yaml`
 * service). Without it the database suites are skipped, unless REQUIRE_DB_TESTS=1 makes that an error.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pg from "pg";

import { createDbClient, type DbClient } from "../client";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface TestDatabase {
  readonly db: DbClient;
  readonly url: string;
  dispose(): Promise<void>;
}

/** Whether database suites should run; throws when they are required but not configured. */
export function databaseTestsEnabled(): boolean {
  if (process.env.TEST_DATABASE_URL) {
    return true;
  }
  if (process.env.REQUIRE_DB_TESTS === "1") {
    throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
  }
  return false;
}

export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error("TEST_DATABASE_URL is not set");
  }
  const name = `omnichannel_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;

  await withAdminClient(baseUrl, (admin) => admin.query(`CREATE DATABASE "${name}"`));
  try {
    await execFileAsync(path.join(packageDir, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url.toString() },
    });
  } catch (error) {
    await withAdminClient(baseUrl, (admin) => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    throw error;
  }

  const db = createDbClient({ connectionString: url.toString() });
  return {
    db,
    url: url.toString(),
    async dispose() {
      await db.$disconnect();
      await withAdminClient(baseUrl, (admin) => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

async function withAdminClient<T>(connectionString: string, action: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}
