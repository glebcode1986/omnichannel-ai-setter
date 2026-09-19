import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";

import { loadWebEnv } from "./env";
import { withoutProviderTokens } from "./server/auth-adapter";
import { getDb } from "./server/db";

/**
 * Auth.js with Prisma-backed users, linked accounts and database sessions (ADR-009). Configuration is
 * resolved per request, so importing this module never reads the environment or opens a connection.
 * Authentication identifies the user only; workspace access is authorized separately
 * (see server/request-context.ts).
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = loadWebEnv();
  return {
    adapter: withoutProviderTokens(PrismaAdapter(getDb())),
    session: { strategy: "database" },
    secret: env.AUTH_SECRET,
    // Sign-in providers are chosen with the authenticated app shell (P5-01); none are enabled yet.
    providers: [],
  };
});
