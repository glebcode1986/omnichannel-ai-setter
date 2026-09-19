import { createDbClient, type DbClient } from "@omnichannel/db";

import { loadWebEnv } from "../env";

let client: DbClient | undefined;

/** Process-wide Prisma client, created on first use rather than at import/build time. */
export function getDb(): DbClient {
  client ??= createDbClient({ connectionString: loadWebEnv().DATABASE_URL });
  return client;
}
