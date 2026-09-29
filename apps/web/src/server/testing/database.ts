/**
 * Integration-test database for the web app: a uniquely named PostgreSQL database with the committed
 * migrations applied, dropped afterwards.
 *
 * The web composition root has to be proven against the real schema — a webhook that is accepted but
 * persists nothing, or persists into the wrong Business Profile, is invisible against a stubbed store —
 * and `@omnichannel/db` deliberately does not publish its test helpers, so each app owns this the way
 * `apps/worker` does.
 *
 * Needs TEST_DATABASE_URL pointing at a user that may CREATE DATABASE (the local `compose.yaml` service).
 * Without it these suites are skipped, unless REQUIRE_DB_TESTS=1 makes that an error.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { createDbClient, type DbClient } from "@omnichannel/db";

const execFileAsync = promisify(execFile);

export interface TestDatabase {
  readonly db: DbClient;
  dispose(): Promise<void>;
}

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
  const name = `omnichannel_web_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;

  await withAdminClient(baseUrl, (admin) => admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  const dropDatabase = () => withAdminClient(baseUrl, (admin) => admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
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
  return {
    db,
    async dispose() {
      await db.$disconnect().catch(() => undefined);
      await dropDatabase();
    },
  };
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
