import { randomBytes } from "node:crypto";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialCipher } from "./credentials";
import { createInstagramOnboardingStore, type InstagramOnboardingStore } from "./onboarding-store";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createBusinessProfile } from "./repositories/workspaces";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, createPaidWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const EXPIRES = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);

describe.skipIf(!databaseTestsEnabled())("slot check after disconnect", () => {
  let database: TestDatabase;
  let store: InstagramOnboardingStore;
  const cipher = createCredentialCipher({ keyId: "k1", keys: { k1: randomBytes(32) } });

  const bareProfile = async (label: string): Promise<BusinessProfileContext> => {
    const ownerUserId = await createTestUser(database.db, label);
    const { workspaceId } = await createPaidWorkspace(database.db, { name: `W ${label}`, ownerUserId });
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(database.db, workspace, { name: `P ${label}` });
    return authorizeBusinessProfileAccess(database.db, { userId: ownerUserId, workspaceId, businessProfileId });
  };

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = createInstagramOnboardingStore(database.db, cipher);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const connect = (profile: BusinessProfileContext, externalAccountId: string) =>
    store.connectAccount(profile, {
      channel: "INSTAGRAM",
      externalAccountId,
      displayName: "acct",
      capabilities: NO_CAPABILITIES,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      token: "tok-value",
      expiresAt: EXPIRES,
      now: NOW,
    });

  it("reports what happens when a profile connects a DIFFERENT account after disconnecting", async () => {
    const profile = await bareProfile("slot-check");
    const a = await connect(profile, "ig-A-slotcheck");
    await store.setAccountStatus(profile, a.channelAccountId, "DISCONNECTED");

    const outcome = await connect(profile, "ig-B-slotcheck").then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
    // eslint-disable-next-line no-console
    console.log("CONNECT-B OUTCOME:", JSON.stringify(outcome));

    // Raw DB check: does the partial unique index itself permit a second live row?
    const rawInsert = await database.db
      .$executeRawUnsafe(
        `INSERT INTO channel_accounts (id, workspace_id, business_profile_id, channel, external_account_id, status, capabilities, default_ai_mode, created_at, updated_at)
         VALUES ('raw-slot-check-id', $1, $2, 'INSTAGRAM', 'ig-C-slotcheck', 'CONNECTED', '{}', 'OFF', now(), now())`,
        profile.workspaceId,
        profile.businessProfileId,
      )
      .then(
        (rows) => `inserted:${rows}`,
        (error: unknown) => `rejected:${String(error).slice(0, 200)}`,
      );
    // eslint-disable-next-line no-console
    console.log("RAW INSERT OUTCOME:", rawInsert);

    // Re-connecting the SAME account after disconnect must still work.
    const again = await connect(profile, "ig-A-slotcheck").then(
      () => "ok",
      (error: unknown) => String(error),
    );
    // eslint-disable-next-line no-console
    console.log("RECONNECT-A OUTCOME:", again);

    expect(outcome).toBeDefined();
  }, 120_000);
});
