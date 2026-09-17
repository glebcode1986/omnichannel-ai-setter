import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

export type DbClient = PrismaClient;

/** A client or an interactive-transaction client; repositories accept either. */
export type DbExecutor = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export interface DbClientOptions {
  /** PostgreSQL connection string; read from the validated app environment by the composition root. */
  readonly connectionString: string;
}

/** Creates a Prisma client over the node-postgres driver adapter (Prisma 7 requires a driver adapter). */
export function createDbClient(options: DbClientOptions): DbClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: options.connectionString }) });
}
