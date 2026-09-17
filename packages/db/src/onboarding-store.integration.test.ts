import { randomBytes, randomUUID } from "node:crypto";

import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCredentialCipher, CredentialCryptoError } from "./credentials";
import { createInstagramOnboardingStore, type InstagramOnboardingStore } from "./onboarding-store";
import { readChannelCredential } from "./repositories/channel-credentials";
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

    const later = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
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

    // Revocation is stamped with real time: the schema refuses a revocation older than the row itself.
    const revokedAt = new Date();
    await store.setAccountStatus(main, channelAccountId, "DISCONNECTED");
    await store.revokeCredential(main, { credentialId, purpose: PURPOSE, now: revokedAt });

    expect(await store.readCredential(main, { credentialId, purpose: PURPOSE })).toBeUndefined();
    const row = await db().channelCredential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(row.revokedAt).toEqual(revokedAt);
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    // The freed slot lets the same Instagram account be connected in another Workspace.
    await expect(connect(await bareProfile(unique("onboard-next")), external)).resolves.toBeDefined();
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
