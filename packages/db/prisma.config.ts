import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7 no longer reads the datasource URL from schema.prisma). The CLI needs
 * DATABASE_URL only for commands that touch a database (migrate, db); `prisma generate` and `prisma
 * validate` work without it.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    // Only needed by `prisma migrate dev` / `migrate diff --from-migrations` (drift checks).
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
