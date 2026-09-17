import type { Adapter, AdapterAccount } from "next-auth/adapters";

/**
 * Stores only the link between a user and a sign-in provider account. Provider access/refresh/ID tokens are
 * not needed for login and are never persisted (the schema has no columns for them).
 */
export function withoutProviderTokens(adapter: Adapter): Adapter {
  if (adapter.linkAccount === undefined) {
    return adapter;
  }
  const linkAccount = adapter.linkAccount.bind(adapter);
  return {
    ...adapter,
    linkAccount: (account: AdapterAccount) =>
      linkAccount({
        userId: account.userId,
        type: account.type,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      }),
  };
}
