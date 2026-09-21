import { randomBytes, randomUUID } from "node:crypto";

import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCredentialCipher, CredentialCryptoError } from "./credentials";
import { TenantRecordNotFoundError } from "./errors";
import { createInstagramOnboardingStore, type InstagramOnboardingStore } from "./onboarding-store";
import { readChannelCredential, restoreChannelCredential } from "./repositories/channel-credentials";
import { authorizeBusinessProfileAccess, type BusinessProfileContext } from "./tenancy";
import { createBusinessProfile, createWorkspaceWithOwner } from "./repositories/workspaces";
import { authorizeWorkspaceAccess } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser } from "./testing/fixtures";

const TOKEN = "IGQVJlong-lived-token";
const OTHER_TOKEN = "IGQVJrefreshed-token";
const PURPOSE = "INSTAGRAM_ACCESS_TOKEN" as const;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const EXPIRES = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);

describe.skipIf(!databaseTestsEnabled())("instagram onboarding store (PostgreSQL)", () => {
  let database: TestDatabase;
  /** Bare Business Profiles: no channel account yet, which is what onboarding starts from. */
  let main: BusinessProfileContext;
  let sibling: BusinessProfileContext;
  let foreign: BusinessProfileContext;
  let store: InstagramOnboardingStore;
  const cipher = createCredentialCipher({ keyId: "k1", keys: { k1: randomBytes(32) } });
  const db = () => database.db;
  let sequence = 0;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  const bareProfile = async (label: string): Promise<BusinessProfileContext> => {
    const ownerUserId = await createTestUser(database.db, label);
    const { workspaceId } = await createWorkspaceWithOwner(database.db, { name: `Workspace ${label}`, ownerUserId });
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(database.db, workspace, { name: `Profile ${label}` });
    return authorizeBusinessProfileAccess(database.db, { userId: ownerUserId, workspaceId, businessProfileId });
  };

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    foreign = await bareProfile("onboard-other");
    store = createInstagramOnboardingStore(database.db, cipher);
  }, 120_000);

  beforeEach(async () => {
    // A profile connects at most one Instagram account, so each case starts from a fresh one.
    main = await bareProfile(unique("onboard-main"));
    sibling = await bareProfile(unique("onboard-sibling"));
  });

  afterAll(async () => {
    await database?.dispose();
  });

  const connect = (profile: BusinessProfileContext, externalAccountId: string, overrides: { token?: string; now?: Date } = {}) =>
    store.connectAccount(profile, {
      channel: "INSTAGRAM",
      externalAccountId,
      displayName: "studio",
      capabilities: { ...NO_CAPABILITIES, text: true },
      purpose: PURPOSE,
      token: overrides.token ?? TOKEN,
      expiresAt: EXPIRES,
      now: overrides.now ?? NOW,
    });

  it("stores the token encrypted and never in the clear", async () => {
    const { channelAccountId } = await connect(main, unique("ig-account"));

    const account = await db().channelAccount.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
      select: { credentialId: true, status: true, displayName: true },
    });
    expect(account).toMatchObject({ status: "CONNECTED", displayName: "studio" });

    const row = await db().channelCredential.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId: main.workspaceId, id: account.credentialId ?? "" } },
    });
    expect(row).toMatchObject({ algorithm: "aes-256-gcm", purpose: PURPOSE });
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    expect(row.nonce).toHaveLength(12);
    expect(row.authTag).toHaveLength(16);

    const decrypted = await store.readCredential(main, { credentialId: account.credentialId ?? "", purpose: PURPOSE });
    expect(decrypted).toMatchObject({ token: TOKEN, expiresAt: EXPIRES, mintedAt: row.createdAt });
  });

  it("refuses to decrypt a credential read under another Workspace's scope", async () => {
    const { channelAccountId } = await connect(main, unique("ig-account"));
    const account = await db().channelAccount.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
      select: { credentialId: true },
    });
    const credentialId = account.credentialId ?? "";

    // Same row, wrong Workspace in the additional authenticated data: the bytes do not decrypt.
    await expect(
      readChannelCredential(db(), cipher, { workspaceId: foreign.workspaceId, credentialId, purpose: PURPOSE }),
    ).resolves.toBeUndefined();
    await expect(
      (async () => {
        await db().channelCredential.update({ where: { id: credentialId }, data: { workspaceId: foreign.workspaceId } });
      })(),
    ).rejects.toThrow();
  });

  it("rejects a tampered ciphertext instead of returning something", async () => {
    const { channelAccountId } = await connect(main, unique("ig-account"));
    const account = await db().channelAccount.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
      select: { credentialId: true },
    });
    const credentialId = account.credentialId ?? "";
    const row = await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId } });
    const tampered = Buffer.from(row.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    await db().channelCredential.update({ where: { id: credentialId }, data: { ciphertext: tampered } });

    await expect(store.readCredential(main, { credentialId, purpose: PURPOSE })).rejects.toThrow(CredentialCryptoError);
  });

  it("reconnects in place, keeping the account row, its history and its credential row", async () => {
    const external = unique("ig-account");
    const first = await connect(main, external);
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: first.channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";
    // Something that references the account, to prove a reconnect does not recreate it.
    await db().inboundEvent.create({
      data: {
        workspaceId: main.workspaceId,
        businessProfileId: main.businessProfileId,
        channelAccountId: first.channelAccountId,
        sourceEventId: unique("evt"),
        eventType: "INBOUND_MESSAGE",
        occurredAt: NOW,
      },
    });

    // Real time, like the revocation below and for the same reason: `created_at` is written by the
    // database, and the schema refuses a refresh stamped earlier than the row itself. A fixed logical
    // instant works only until the wall clock passes it, which is a test that fails on a date rather
    // than on a change.
    const later = new Date(Date.now() + 1_000);
    const again = await connect(main, external, { token: OTHER_TOKEN, now: later });

    expect(again.channelAccountId).toBe(first.channelAccountId);
    const credentials = await db().channelCredential.count({ where: { workspaceId: main.workspaceId } });
    expect(await db().inboundEvent.count({ where: { channelAccountId: first.channelAccountId } })).toBe(1);
    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toMatchObject({ token: OTHER_TOKEN, mintedAt: later });
    expect(credentials).toBeGreaterThan(0);
  });

  it("refuses to rebind a profile to a different Instagram account", async () => {
    await connect(sibling, unique("ig-account"));

    await expect(connect(sibling, unique("ig-account"))).rejects.toMatchObject({ reason: "different_account" });
  });

  it("refuses an Instagram account that is already live elsewhere, without saying where", async () => {
    const shared = unique("ig-shared");
    const elsewhere = await bareProfile(unique("onboard-elsewhere"));
    await connect(main, shared);

    const rejection = await connect(elsewhere, shared).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ reason: "already_connected" });
    // The failure must not disclose which Workspace holds the account.
    expect(String(rejection)).not.toContain(main.workspaceId);
  });

  it("lets a profile connect a different account after disconnecting the wrong one", async () => {
    const wrong = unique("ig-wrong");
    const right = unique("ig-right");
    const first = await connect(main, wrong);
    await store.setAccountStatus(main, first.channelAccountId, "DISCONNECTED");

    // Connecting the wrong Instagram account is an ordinary mistake; the profile must be recoverable.
    const second = await connect(main, right);

    expect(second.channelAccountId).not.toBe(first.channelAccountId);
    const rows = await db().channelAccount.findMany({
      where: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId },
      select: { externalAccountId: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    // The disconnected row stays for audit; only one account is live.
    expect(rows).toEqual([
      { externalAccountId: wrong, status: "DISCONNECTED" },
      { externalAccountId: right, status: "CONNECTED" },
    ]);
    // A live account still blocks a different one, which is what the guard is actually for.
    await expect(connect(main, unique("ig-third"))).rejects.toMatchObject({ reason: "different_account" });
  });

  it("reconnecting a previously disconnected account revives its own row", async () => {
    const external = unique("ig-account");
    const first = await connect(main, external);
    await store.setAccountStatus(main, first.channelAccountId, "DISCONNECTED");

    const again = await connect(main, external, { now: new Date(Date.now() + 1_000) });

    expect(again.channelAccountId).toBe(first.channelAccountId);
    expect(await db().channelAccount.count({ where: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId } })).toBe(1);
  });

  it("refuses a context that did not come from authorization", async () => {
    const forged = { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, userId: "u", workspaceMemberId: "m", role: "OWNER" } as unknown as BusinessProfileContext;
    const { channelAccountId } = await connect(main, unique("ig-account"));
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";

    // Every store method must reject a hand-made context, not just the ones that delegate to repositories.
    await expect(store.readCredential(forged, { credentialId, purpose: PURPOSE })).rejects.toThrow();
    await expect(store.findAccountById(forged, channelAccountId)).rejects.toThrow();
    await expect(store.findAccountByExternalId(forged, { channel: "INSTAGRAM", externalAccountId: "x" })).rejects.toThrow();
    await expect(store.rotateCredential(forged, { credentialId, purpose: PURPOSE, token: "t", expiresAt: EXPIRES, refreshedAt: new Date() })).rejects.toThrow();
    await expect(store.revokeCredential(forged, { credentialId, purpose: PURPOSE, now: new Date() })).rejects.toThrow();
    await expect(
      store.connectAccount(forged, {
        channel: "INSTAGRAM",
        externalAccountId: unique("ig-forged"),
        capabilities: { ...NO_CAPABILITIES, text: true },
        purpose: PURPOSE,
        token: TOKEN,
        expiresAt: EXPIRES,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("disconnect frees both live slots and destroys the secret while keeping the row", async () => {
    const external = unique("ig-account");
    const { channelAccountId } = await connect(main, external);
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";

    await store.disconnectAccount(main, channelAccountId, new Date());

    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toBeUndefined();
    const row = await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(row.revokedAt).not.toBeNull();
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    // The freed slot lets the same Instagram account be connected in another Workspace.
    await expect(connect(await bareProfile(unique("onboard-next")), external)).resolves.toBeDefined();
  });

  it("commits the disconnect and the revocation together, or neither", async () => {
    const { channelAccountId } = await connect(main, unique("ig-account"));
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";

    // Fault injection: the credential write fails after the status write has already happened. Done as
    // two operations this left the worst possible half-state — an account reading as disconnected, its
    // live slot freed, while the encrypted token was still there and still usable.
    const failing = createInstagramOnboardingStore(db(), {
      ...cipher,
      // The only thing a disconnect encrypts is the tombstone that replaces the secret, so failing every
      // encryption on this instance fails exactly the second half of the operation and nothing else.
      encrypt: () => {
        throw new Error("credential write failed");
      },
    });
    await expect(failing.disconnectAccount(main, channelAccountId, new Date())).rejects.toThrow(/credential write failed/);

    const account = await db().channelAccount.findUniqueOrThrow({ where: { id: channelAccountId }, select: { status: true } });
    const credential = await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId }, select: { revokedAt: true } });
    // Neither half landed: still connected, still holding its secret. A failure that leaves the account
    // usable is recoverable; one that leaves a live token behind a "disconnected" label is not.
    expect(account.status).toBe("CONNECTED");
    expect(credential.revokedAt).toBeNull();
    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toMatchObject({ token: TOKEN });
  });

  it("does not let a refresh in flight resurrect a credential a disconnect destroyed", async () => {
    const { channelAccountId } = await connect(main, unique("ig-account"));
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";

    // The interleaving: a refresh has read the credential and is waiting on Meta; the disconnect lands;
    // the refresh then comes back with a brand-new token and tries to write it.
    await store.disconnectAccount(main, channelAccountId, new Date());
    const rotation = await store.rotateCredential(main, {
      credentialId,
      purpose: PURPOSE,
      token: OTHER_TOKEN,
      expiresAt: EXPIRES,
      refreshedAt: new Date(Date.now() + 1_000),
    });

    expect(rotation).toBe("SUPERSEDED");
    const row = await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.expiresAt).toBeNull();
    // Neither the old token nor the newly minted one is readable, and the account stays disconnected.
    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toBeUndefined();
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(OTHER_TOKEN, "utf8"))).toBe(false);
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    expect((await db().channelAccount.findUniqueOrThrow({ where: { id: channelAccountId }, select: { status: true } })).status).toBe("DISCONNECTED");
  });

  it("reconnects a disconnected account with a usable new credential", async () => {
    const external = unique("ig-account");
    const { channelAccountId } = await connect(main, external);
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";
    await store.disconnectAccount(main, channelAccountId, new Date());
    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toBeUndefined();

    // A person re-authorizes: the provider issues a new token and the account comes back. Reviving the
    // revoked row is the intent here, which is exactly what a refresh must never do.
    const again = await connect(main, external, { token: OTHER_TOKEN, now: new Date(Date.now() + 1_000) });

    expect(again.channelAccountId).toBe(channelAccountId);
    const account = await db().channelAccount.findUniqueOrThrow({ where: { id: channelAccountId }, select: { status: true, credentialId: true } });
    expect(account).toMatchObject({ status: "CONNECTED", credentialId });
    // Connected *and* usable: an account marked connected beside an unreadable secret is the state this
    // test exists for, and it is not visible from the account row alone.
    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toMatchObject({ token: OTHER_TOKEN });
    const row = await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(row.revokedAt).toBeNull();
    // The token the disconnect destroyed does not come back with it.
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
  });

  it("leaves a disconnected account disconnected when the reconnect cannot restore its secret", async () => {
    const external = unique("ig-account");
    const { channelAccountId } = await connect(main, external);
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";
    await store.disconnectAccount(main, channelAccountId, new Date());

    const failing = createInstagramOnboardingStore(db(), {
      ...cipher,
      encrypt: () => {
        throw new Error("credential restore failed");
      },
    });
    await expect(
      failing.connectAccount(main, {
        channel: "INSTAGRAM",
        externalAccountId: external,
        capabilities: { ...NO_CAPABILITIES, text: true },
        purpose: PURPOSE,
        token: OTHER_TOKEN,
        expiresAt: EXPIRES,
        now: new Date(),
      }),
    ).rejects.toThrow(/credential restore failed/);

    // Fails closed: the account does not come back connected beside a secret nobody can read.
    expect((await db().channelAccount.findUniqueOrThrow({ where: { id: channelAccountId }, select: { status: true } })).status).toBe("DISCONNECTED");
    expect((await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId }, select: { revokedAt: true } })).revokedAt).not.toBeNull();
  });

  it("refuses to report a restoration that matched nothing", async () => {
    // The count check exists for the case the encrypt-failure test cannot reach: the write succeeds as a
    // statement and changes no row. Reporting that as a restored credential would let a reconnect commit
    // an account as connected beside a secret that was never written.
    await expect(
      restoreChannelCredential(db(), cipher, {
        workspaceId: main.workspaceId,
        credentialId: "01a0b40c-0000-7000-8000-0000000000ff",
        purpose: PURPOSE,
        token: OTHER_TOKEN,
        expiresAt: EXPIRES,
        restoredAt: new Date(),
      }),
    ).rejects.toThrow(TenantRecordNotFoundError);
  });

  it("does not let a refresh in flight overwrite a token a reconnect just authorized", async () => {
    const external = unique("ig-account");
    const { channelAccountId } = await connect(main, external);
    const credentialId =
      (
        await db().channelAccount.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
          select: { credentialId: true },
        })
      ).credentialId ?? "";
    const beforeRefresh = await store.readCredential(main, { credentialId, purpose: PURPOSE });

    // The other direction of the same race: the refresh read the old credential, and while Meta was
    // answering a person disconnected and re-authorized. The refreshed token belongs to an authorization
    // that has been replaced, so it must not land on top of the new one.
    await store.disconnectAccount(main, channelAccountId, new Date());
    await connect(main, external, { token: OTHER_TOKEN, now: new Date(Date.now() + 1_000) });

    const rotation = await store.rotateCredential(main, {
      credentialId,
      purpose: PURPOSE,
      token: "IGQVJstale-refresh",
      expiresAt: EXPIRES,
      refreshedAt: new Date(Date.now() + 2_000),
      mintedAt: beforeRefresh?.mintedAt ?? new Date(0),
    });

    expect(rotation).toBe("SUPERSEDED");
    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toMatchObject({ token: OTHER_TOKEN });
  });

  describe("connect state", () => {
    const nonceHash = () => randomBytes(32);

    it("is consumed exactly once, even by concurrent callbacks", async () => {
      const stateId = randomUUID();
      await store.createConnectState(main, {
        stateId,
        nonceHash: nonceHash(),
        channel: "INSTAGRAM",
        requestedScopes: ["instagram_business_basic"],
        expiresAt: new Date(Date.now() + 60_000),
      });

      const attempts = await Promise.all([1, 2, 3].map(() => store.consumeConnectState({ stateId, now: new Date() })));

      expect(attempts.filter((row) => row !== undefined)).toHaveLength(1);
      expect(attempts.find((row) => row !== undefined)).toMatchObject({
        workspaceId: main.workspaceId,
        businessProfileId: main.businessProfileId,
        userId: main.userId,
      });
    });

    it("cannot be consumed after it expires, and an unknown state is indistinguishable", async () => {
      const stateId = randomUUID();
      await store.createConnectState(main, {
        stateId,
        nonceHash: nonceHash(),
        channel: "INSTAGRAM",
        requestedScopes: [],
        expiresAt: new Date(Date.now() + 50),
      });
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(await store.consumeConnectState({ stateId, now: new Date() })).toBeUndefined();
      expect(await store.consumeConnectState({ stateId: randomUUID(), now: new Date() })).toBeUndefined();
    });
  });
});
