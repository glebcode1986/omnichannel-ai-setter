/**
 * The two queries the Instagram token lifecycle runs outside any member's session (#9).
 *
 * Both are deliberately unscoped — a token expires on Meta's clock, so the process that keeps connections
 * alive runs across every workspace and has no member to be authorized as. That makes the boundary tests
 * here the ones that matter: unscoped must mean "every workspace", never "the wrong workspace's row".
 *
 * The mark is guarded on the credential's mint time, and the guard is the point. Between a provider
 * refusing a token and the mark landing, a person may have re-authorized the account; marking it then would
 * tell them to reconnect what they just reconnected, and the connection would refuse to send until they
 * did it twice.
 */
import { randomBytes } from "node:crypto";

import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCredentialCipher } from "./credentials";
import { createInstagramOnboardingStore, type InstagramOnboardingStore } from "./onboarding-store";
import { findInstagramTokensDueForRefresh, markChannelAccountNeedsReauthorization } from "./repositories/channel-accounts";
import { rotateChannelCredential } from "./repositories/channel-credentials";
import { createBusinessProfile, createWorkspaceWithOwner } from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser } from "./testing/fixtures";

const PURPOSE = "INSTAGRAM_ACCESS_TOKEN" as const;
const DAY = 24 * 60 * 60 * 1000;
/**
 * Anchored to the real clock, not a fixed instant.
 *
 * `channel_credentials` stamps `created_at` itself and a CHECK requires the expiry to come after it, so a
 * fixture dated in the past is rejected by the database rather than by the code under test. The queries
 * here are about relative times, and that is what this keeps.
 */
const NOW = new Date();

describe.skipIf(!databaseTestsEnabled())("instagram token lifecycle queries (PostgreSQL)", () => {
  let database: TestDatabase;
  let store: InstagramOnboardingStore;
  const cipher = createCredentialCipher({ keyId: "k1", keys: { k1: randomBytes(32) } });
  const db = () => database.db;
  let sequence = 0;

  const bareProfile = async (label: string): Promise<BusinessProfileContext> => {
    const ownerUserId = await createTestUser(database.db, label);
    const { workspaceId } = await createWorkspaceWithOwner(database.db, { name: `Workspace ${label}`, ownerUserId });
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(database.db, workspace, { name: `Profile ${label}` });
    return authorizeBusinessProfileAccess(database.db, { userId: ownerUserId, workspaceId, businessProfileId });
  };

  interface Connected {
    readonly profile: BusinessProfileContext;
    readonly channelAccountId: string;
    readonly credentialId: string;
    /** The database's own `created_at`, which is the mint time until the first refresh moves it. */
    readonly mintedAt: Date;
  }

  /** One connected Instagram account with a stored token that expires when the case needs it to. */
  const connect = async (expiresInDays: number, label: string): Promise<Connected> => {
    sequence += 1;
    const profile = await bareProfile(`token-${label}-${sequence}`);
    const connected = await store.connectAccount(profile, {
      channel: "INSTAGRAM",
      externalAccountId: `ig-${sequence}-${label}`,
      displayName: "studio",
      capabilities: { ...NO_CAPABILITIES, text: true },
      purpose: PURPOSE,
      token: "IGQVJlong-lived",
      expiresAt: new Date(NOW.getTime() + expiresInDays * DAY),
      now: NOW,
    });
    const account = await db().channelAccount.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { workspaceId: profile.workspaceId, businessProfileId: profile.businessProfileId, id: connected.channelAccountId } },
      select: { credentialId: true, credential: { select: { createdAt: true } } },
    });
    return {
      profile,
      channelAccountId: connected.channelAccountId,
      credentialId: account.credentialId ?? "",
      mintedAt: account.credential?.createdAt ?? NOW,
    };
  };

  const due = (horizonDays: number, limit = 50) =>
    findInstagramTokensDueForRefresh(db(), { dueBefore: new Date(NOW.getTime() + horizonDays * DAY), limit });

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = createInstagramOnboardingStore(database.db, cipher);
  }, 120_000);

  beforeEach(async () => {
    // Each case reasons about the whole table, because the query it is testing does.
    await db().channelAccount.deleteMany({});
    await db().channelCredential.deleteMany({});
  });

  afterAll(async () => {
    await database?.dispose();
  });

  describe("finding the tokens that are due", () => {
    it("returns a connection expiring inside the horizon and leaves the rest alone", async () => {
      const soon = await connect(3, "soon");
      await connect(59, "later");

      const found = await due(14);

      expect(found.map((row) => row.channelAccountId)).toEqual([soon.channelAccountId]);
      expect(found[0]).toMatchObject({
        workspaceId: soon.profile.workspaceId,
        businessProfileId: soon.profile.businessProfileId,
        credentialId: soon.credentialId,
        mintedAt: soon.mintedAt,
        expiresAt: new Date(NOW.getTime() + 3 * DAY),
      });
    });

    it("crosses every workspace, because a token does not wait for anyone to sign in", async () => {
      const first = await connect(2, "ws-a");
      const second = await connect(5, "ws-b");

      const found = await due(14);

      expect(new Set(found.map((row) => row.workspaceId))).toEqual(new Set([first.profile.workspaceId, second.profile.workspaceId]));
    });

    it("orders by expiry so the connection closest to dying is refreshed first", async () => {
      const last = await connect(9, "third");
      const first = await connect(1, "first");
      const middle = await connect(4, "second");

      const found = await due(14);

      expect(found.map((row) => row.channelAccountId)).toEqual([first.channelAccountId, middle.channelAccountId, last.channelAccountId]);
    });

    it("respects the batch size, keeping the rest for the next sweep", async () => {
      await connect(1, "a");
      await connect(2, "b");
      await connect(3, "c");

      expect(await due(14, 2)).toHaveLength(2);
    });

    it("skips a connection a person already owns: disconnected, or already told to reconnect", async () => {
      const disconnected = await connect(2, "gone");
      const waiting = await connect(2, "waiting");
      await db().channelAccount.update({ where: { workspaceId_businessProfileId_id: { workspaceId: disconnected.profile.workspaceId, businessProfileId: disconnected.profile.businessProfileId, id: disconnected.channelAccountId } }, data: { status: "DISCONNECTED" } });
      await db().channelAccount.update({ where: { workspaceId_businessProfileId_id: { workspaceId: waiting.profile.workspaceId, businessProfileId: waiting.profile.businessProfileId, id: waiting.channelAccountId } }, data: { status: "NEEDS_REAUTH" } });

      expect(await due(14)).toEqual([]);
    });

    it("skips a revoked credential and one with no expiry at all", async () => {
      const revoked = await connect(2, "revoked");
      const endless = await connect(2, "endless");
      await db().channelCredential.update({ where: { workspaceId_id: { workspaceId: revoked.profile.workspaceId, id: revoked.credentialId } }, data: { revokedAt: revoked.mintedAt } });
      await db().channelCredential.update({ where: { workspaceId_id: { workspaceId: endless.profile.workspaceId, id: endless.credentialId } }, data: { expiresAt: null } });

      expect(await due(14)).toEqual([]);
    });

    it("reports the mint time a refresh has actually moved", async () => {
      const account = await connect(2, "rotated");
      const refreshedAt = new Date(account.mintedAt.getTime() + DAY);
      await rotateChannelCredential(db(), cipher, {
        workspaceId: account.profile.workspaceId,
        credentialId: account.credentialId,
        purpose: PURPOSE,
        token: "IGQVJsecond",
        expiresAt: new Date(NOW.getTime() + 4 * DAY),
        refreshedAt,
      });

      // Creation time is only the mint time until the first refresh; after that it would be a lie, and the
      // 24-hour eligibility rule is computed from it.
      expect((await due(14))[0]).toMatchObject({ mintedAt: refreshedAt });
    });
  });

  describe("marking a connection as needing re-authorization", () => {
    it("marks a connected account whose credential has not moved", async () => {
      const account = await connect(2, "mark");

      expect(await markChannelAccountNeedsReauthorization(db(), { workspaceId: account.profile.workspaceId, channelAccountId: account.channelAccountId, mintedAt: account.mintedAt })).toBe(true);
      expect(await status(account)).toBe("NEEDS_REAUTH");
    });

    it("leaves a connection alone when its credential was replaced in the meantime", async () => {
      const account = await connect(2, "raced");
      await rotateChannelCredential(db(), cipher, {
        workspaceId: account.profile.workspaceId,
        credentialId: account.credentialId,
        purpose: PURPOSE,
        token: "IGQVJfresh",
        expiresAt: new Date(NOW.getTime() + 60 * DAY),
        refreshedAt: new Date(account.mintedAt.getTime() + 60_000),
      });

      // The mint time the caller read belongs to a token nobody is using any more. Marking here would tell
      // an operator to reconnect an account that was just reconnected.
      const marked = await markChannelAccountNeedsReauthorization(db(), { workspaceId: account.profile.workspaceId, channelAccountId: account.channelAccountId, mintedAt: account.mintedAt });

      expect(marked).toBe(false);
      expect(await status(account)).toBe("CONNECTED");
    });

    it("does not revive a disconnected account, or re-mark one already waiting", async () => {
      for (const state of ["DISCONNECTED", "NEEDS_REAUTH"] as const) {
        const account = await connect(2, `keep-${state}`);
        await db().channelAccount.update({ where: { workspaceId_businessProfileId_id: { workspaceId: account.profile.workspaceId, businessProfileId: account.profile.businessProfileId, id: account.channelAccountId } }, data: { status: state } });

        expect(await markChannelAccountNeedsReauthorization(db(), { workspaceId: account.profile.workspaceId, channelAccountId: account.channelAccountId, mintedAt: account.mintedAt })).toBe(false);
        expect(await status(account)).toBe(state);
      }
    });

    it("will not mark an account named from another workspace", async () => {
      const account = await connect(2, "mine");
      const other = await connect(2, "theirs");

      // The ID is real and the mint time matches; only the workspace is wrong. Unscoped access is how a
      // background process reaches every tenant, so this is the boundary that has to hold.
      const marked = await markChannelAccountNeedsReauthorization(db(), { workspaceId: other.profile.workspaceId, channelAccountId: account.channelAccountId, mintedAt: account.mintedAt });

      expect(marked).toBe(false);
      expect(await status(account)).toBe("CONNECTED");
      expect(await status(other)).toBe("CONNECTED");
    });

    it("answers no for an identifier that is not one", async () => {
      expect(await markChannelAccountNeedsReauthorization(db(), { workspaceId: "01HWORKSPACE00000000000000", channelAccountId: "' OR 1=1 --", mintedAt: NOW })).toBe(false);
    });
  });

  const status = async (account: { profile: BusinessProfileContext; channelAccountId: string }): Promise<string> =>
    (
      await db().channelAccount.findUniqueOrThrow({
        where: { workspaceId_businessProfileId_id: { workspaceId: account.profile.workspaceId, businessProfileId: account.profile.businessProfileId, id: account.channelAccountId } },
        select: { status: true },
      })
    ).status;
});
