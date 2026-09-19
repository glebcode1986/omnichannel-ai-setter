import type { AdapterAccount } from "next-auth/adapters";
import { describe, expect, it, vi } from "vitest";

import { withoutProviderTokens } from "./auth-adapter";

describe("withoutProviderTokens", () => {
  it("links accounts without persisting provider tokens", async () => {
    const linkAccount = vi.fn((account: AdapterAccount) => Promise.resolve(account));
    const adapter = withoutProviderTokens({ linkAccount });

    await adapter.linkAccount?.({
      userId: "user_1",
      type: "oidc",
      provider: "fake-idp",
      providerAccountId: "subject-1",
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
      id_token: "fake-id-token",
      expires_at: 1,
      scope: "openid",
      token_type: "bearer",
    });

    expect(linkAccount).toHaveBeenCalledWith({
      userId: "user_1",
      type: "oidc",
      provider: "fake-idp",
      providerAccountId: "subject-1",
    });
  });

  it("leaves adapters without account linking unchanged", () => {
    const adapter = {};
    expect(withoutProviderTokens(adapter)).toBe(adapter);
  });
});
