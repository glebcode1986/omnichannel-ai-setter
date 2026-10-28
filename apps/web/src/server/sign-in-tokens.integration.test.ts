/**
 * The one-time sign-in token, against a real database (#117).
 *
 * The product's security here rests on a claim about somebody else's code, so the claim is tested rather
 * than quoted: **single use is enforced by the adapter, not by Auth.js.** The core calls
 * `useVerificationToken` and trusts what comes back, and the Prisma adapter's guarantee is that a `delete`
 * either returns the row or raises `P2025` — one atomic statement. A hand-rolled or wrapped adapter that
 * did find-then-delete would make every magic link replayable under concurrency, and no test that clicks a
 * link twice *sequentially* would notice. So the concurrent case is the point of this file.
 *
 * The adapter under test is the one the app actually composes, `withoutProviderTokens(PrismaAdapter(db))`,
 * because a wrapper is exactly where this guarantee could be lost.
 */
import { PrismaAdapter } from "@auth/prisma-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withoutProviderTokens } from "./auth-adapter";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";

describe.skipIf(!databaseTestsEnabled())("the one-time sign-in token", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 240_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** Exactly what `auth.ts` builds, wrapper included. */
  const adapter = () => withoutProviderTokens(PrismaAdapter(database.db));

  const future = () => new Date(Date.now() + 15 * 60_000);
  let sequence = 0;
  const address = () => `token-${String((sequence += 1))}@example.test`;

  it("is accepted once and refused the second time", async () => {
    const subject = adapter();
    const identifier = address();
    await subject.createVerificationToken?.({ identifier, token: "token-one", expires: future() });

    const first = await subject.useVerificationToken?.({ identifier, token: "token-one" });
    const replay = await subject.useVerificationToken?.({ identifier, token: "token-one" });

    expect(first).toMatchObject({ identifier });
    // A replayed link is not an error and not a sign-in: it is simply gone.
    expect(replay).toBeNull();
  }, 240_000);

  it("is won by exactly one of two simultaneous clicks", async () => {
    // The case a sequential test cannot see, and the reason the adapter's single atomic `delete` matters.
    const subject = adapter();
    const identifier = address();
    await subject.createVerificationToken?.({ identifier, token: "token-race", expires: future() });

    const outcomes = await Promise.all([
      subject.useVerificationToken?.({ identifier, token: "token-race" }),
      subject.useVerificationToken?.({ identifier, token: "token-race" }),
    ]);

    expect(outcomes.filter((outcome) => outcome !== null && outcome !== undefined)).toHaveLength(1);
    expect(await database.db.verificationToken.count({ where: { identifier } })).toBe(0);
  }, 240_000);

  it("refuses a token nobody issued, without saying anything about the address", async () => {
    const subject = adapter();

    expect(await subject.useVerificationToken?.({ identifier: address(), token: "never-issued" })).toBeNull();
  }, 240_000);

  it("consumes an expired token rather than leaving it to be retried", async () => {
    // Documented because it is surprising and because a test asserting the opposite would be wrong about
    // the product: the adapter deletes the row, and only then does the core compare the expiry. So an
    // expired click burns the link, and "ask for a new one" is the only true advice the page can give.
    const subject = adapter();
    const identifier = address();
    await subject.createVerificationToken?.({ identifier, token: "token-stale", expires: new Date(Date.now() - 60_000) });

    const used = await subject.useVerificationToken?.({ identifier, token: "token-stale" });

    expect(used).toMatchObject({ identifier });
    expect(used?.expires.getTime()).toBeLessThan(Date.now());
    expect(await database.db.verificationToken.count({ where: { identifier } })).toBe(0);
  }, 240_000);

  it("distinguishes two tokens issued for the same address", async () => {
    // Asking twice must not invalidate the first link before it is used: the primary key is the pair.
    const subject = adapter();
    const identifier = address();
    await subject.createVerificationToken?.({ identifier, token: "token-a", expires: future() });
    await subject.createVerificationToken?.({ identifier, token: "token-b", expires: future() });

    expect(await subject.useVerificationToken?.({ identifier, token: "token-a" })).toMatchObject({ identifier });
    expect(await subject.useVerificationToken?.({ identifier, token: "token-b" })).toMatchObject({ identifier });
  }, 240_000);

  it("knows nothing about an address that has never signed in", async () => {
    // `getUserByEmail` is one of the three methods the email flow requires of an adapter, and the sign-in
    // path must be able to ask it without that answer reaching a browser.
    expect(await adapter().getUserByEmail?.(address())).toBeNull();
  }, 240_000);

  it("stores no provider token when a Google account is linked", async () => {
    // The wrapper's whole purpose, checked here because this is the file that composes it: an account row
    // records who the person is at the provider and keeps none of the provider's credentials.
    const subject = adapter();
    const user = await subject.createUser?.({ id: "", email: address(), emailVerified: new Date(), name: "Token Tester" });
    expect(user).toBeDefined();

    await subject.linkAccount?.({
      userId: user?.id ?? "",
      type: "oidc",
      provider: "google",
      providerAccountId: `google-${String(sequence)}`,
      access_token: "an access token that must not be stored",
      refresh_token: "a refresh token that must not be stored",
      id_token: "an id token that must not be stored",
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      scope: "openid email profile",
      token_type: "bearer",
    });

    const stored = await database.db.account.findFirstOrThrow({
      where: { userId: user?.id ?? "" },
      select: { provider: true, type: true, providerAccountId: true },
    });
    expect(stored).toMatchObject({ provider: "google", type: "oidc" });
    // Nothing else was kept. Asserted against the row's own columns rather than against the object we
    // passed, so a schema that grew a token column would fail this.
    const columns = Object.keys(
      await database.db.account.findFirstOrThrow({ where: { userId: user?.id ?? "" } }),
    );
    for (const secret of ["access_token", "refresh_token", "id_token", "accessToken", "refreshToken", "idToken"]) {
      expect(columns, secret).not.toContain(secret);
    }
  }, 240_000);
});
