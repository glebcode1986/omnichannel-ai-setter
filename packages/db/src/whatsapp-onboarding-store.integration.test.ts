/**
 * WhatsApp onboarding persistence, against a real server (Issue #19).
 *
 * Two kinds of case live here and nowhere else.
 *
 * **The invariants the database is asked to hold.** "Connected only after the required verification
 * succeeded" is a CHECK, so the test that matters is the one that tries to write the forbidden row
 * directly in SQL and is refused — a rule enforced only by the store it was written for is a rule that
 * lasts until the next caller.
 *
 * **The states that can only exist across statements.** A credential written without an account, an
 * account connected beside a credential nobody can read, a disconnection that freed the live slot while
 * the token stayed usable. Each is one transaction here, and each is the kind of half-state nobody goes
 * looking for.
 */
import { randomBytes } from "node:crypto";

import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCredentialCipher } from "./credentials";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createBusinessProfile, createWorkspaceWithOwner } from "./repositories/workspaces";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { addTestMember, createTestUser } from "./testing/fixtures";
import { createWhatsAppOnboardingStore, type ConnectWhatsAppInput, type WhatsAppOnboardingStore } from "./whatsapp-onboarding-store";

const TOKEN = "EAAtest-business-token-not-a-real-one";
const PURPOSE = "WHATSAPP_BUSINESS_TOKEN" as const;
const NOW = new Date("2026-10-04T12:00:00.000Z");
const EXPIRES = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);
const WABA_ID = "102290129340398";

describe.skipIf(!databaseTestsEnabled())("whatsapp onboarding store (PostgreSQL)", () => {
  let database: TestDatabase;
  let main: BusinessProfileContext;
  let sibling: BusinessProfileContext;
  let store: WhatsAppOnboardingStore;
  const cipher = createCredentialCipher({ keyId: "k1", keys: { k1: randomBytes(32) } });
  const db = () => database.db;
  let sequence = 0;
  const unique = (prefix: string) => `${prefix}-${String(++sequence)}`;
  /** Provider identifiers are digits; the repositories validate the shape. */
  const phoneNumber = () => `1065403522${String(10_000 + ++sequence)}`;

  const bareProfile = async (label: string): Promise<BusinessProfileContext> => {
    const ownerUserId = await createTestUser(database.db, label);
    const { workspaceId } = await createWorkspaceWithOwner(database.db, { name: `Workspace ${label}`, ownerUserId });
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(database.db, workspace, { name: `Profile ${label}` });
    return authorizeBusinessProfileAccess(database.db, { userId: ownerUserId, workspaceId, businessProfileId });
  };

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = createWhatsAppOnboardingStore(database.db, cipher);
  }, 180_000);

  beforeEach(async () => {
    // A profile connects at most one live WhatsApp number, so each case starts from a fresh profile.
    main = await bareProfile(unique("wa-main"));
    sibling = await bareProfile(unique("wa-sibling"));
  });

  afterAll(async () => {
    await database?.dispose();
  });

  /**
   * Real time, not the frozen `NOW`.
   *
   * `channel_credentials_lifetime_check` forbids a revocation earlier than the row's creation — lifetimes
   * move forward — and the row is created by the test at whatever the server's clock says. A frozen
   * disconnect time is therefore the fixture violating a real invariant, not a case worth having.
   */
  const disconnectedAt = () => new Date();

  const input = (phoneNumberId: string, overrides: Partial<ConnectWhatsAppInput> = {}): ConnectWhatsAppInput => ({
    phoneNumberId,
    wabaId: WABA_ID,
    businessPortfolioId: "2729063490586005",
    asset: {
      phoneNumberId,
      displayPhoneNumber: "+1 555 0100",
      verifiedName: "Test Business",
      qualityRating: "GREEN",
      codeVerificationStatus: "VERIFIED",
      platformType: "CLOUD_API",
    },
    onboardingMode: "NEW_OR_MIGRATED_CLOUD_NUMBER",
    capabilities: { ...NO_CAPABILITIES, text: true, templates: true },
    purpose: PURPOSE,
    token: TOKEN,
    expiresAt: EXPIRES,
    webhookSubscribedAt: NOW,
    phoneRegisteredAt: NOW,
    templates: {
      records: [
        { providerTemplateId: "tpl_1", name: "appointment_reminder", language: "en_US", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY" }] },
        { providerTemplateId: "tpl_2", name: "appointment_reminder", language: "ru", status: "PENDING" },
      ],
      complete: true,
      syncedAt: NOW,
    },
    health: { status: "CONNECTED" },
    now: NOW,
    ...overrides,
  });

  describe("connecting", () => {
    it("writes the credential, the account, the provider assets and the catalogue together", async () => {
      const phoneNumberId = phoneNumber();

      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumberId));

      const connection = await store.readConnection(main, channelAccountId);
      expect(connection).toMatchObject({
        wabaId: WABA_ID,
        businessPortfolioId: "2729063490586005",
        displayPhoneNumber: "+1 555 0100",
        verifiedName: "Test Business",
        onboardingMode: "NEW_OR_MIGRATED_CLOUD_NUMBER",
        status: "CONNECTED",
        templatesComplete: true,
      });
      expect(connection?.connectedAt).toEqual(NOW);
      expect(connection?.credentialId).toBeDefined();
      expect(await store.listTemplates(main, channelAccountId)).toHaveLength(2);
    }, 180_000);

    it("keeps the messaging account and the sending asset as separate identifiers", async () => {
      // Meta is splitting the account model, and `waba_id` now denotes the messaging account. Deriving
      // one from the other is what breaks on the day they finish.
      const phoneNumberId = phoneNumber();

      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumberId));

      const account = await db().channelAccount.findUniqueOrThrow({
        where: { workspaceId_businessProfileId_id: { workspaceId: main.workspaceId, businessProfileId: main.businessProfileId, id: channelAccountId } },
        select: { externalAccountId: true, channel: true },
      });
      expect(account).toEqual({ externalAccountId: phoneNumberId, channel: "WHATSAPP" });
      expect((await store.readConnection(main, channelAccountId))?.wabaId).toBe(WABA_ID);
    }, 180_000);

    it("stores the token encrypted and never in the clear", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));
      const connection = await store.readConnection(main, channelAccountId);

      const row = await db().channelCredential.findFirstOrThrow({
        where: { workspaceId: main.workspaceId, id: connection?.credentialId },
        select: { ciphertext: true, purpose: true, algorithm: true },
      });
      expect(row.purpose).toBe(PURPOSE);
      expect(row.algorithm).toBe("aes-256-gcm");
      expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(TOKEN);
      // And it reads back through the cipher, so the ciphertext is the token rather than merely opaque.
      expect((await store.readCredential(main, { credentialId: connection?.credentialId ?? "", purpose: PURPOSE }))?.token).toBe(TOKEN);
    }, 180_000);

    it("records the connection in the audit trail, with identifiers and no secret", async () => {
      const phoneNumberId = phoneNumber();

      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumberId));

      const event = await db().auditEvent.findFirstOrThrow({
        where: { workspaceId: main.workspaceId, subjectId: channelAccountId, kind: "CHANNEL_CONNECTED" },
        select: { detail: true, summary: true, actorUserId: true },
      });
      expect(event.detail).toMatchObject({ wabaId: WABA_ID, phoneNumberId, onboardingMode: "NEW_OR_MIGRATED_CLOUD_NUMBER", phoneRegistered: true });
      expect(JSON.stringify(event)).not.toContain(TOKEN);
      expect(event.actorUserId).toBe(main.userId);
    }, 180_000);

    it("refuses a member who may not connect a channel", async () => {
      // Only an OWNER or an authorized ADMIN. The check rides inside the account write, so a caller
      // without the role reaches neither the credential nor the provider assets.
      const agentUserId = await createTestUser(database.db, unique("wa-agent"));
      await addTestMember(database.db, main.workspaceId, agentUserId, "AGENT", [main.businessProfileId]);
      const agent = await authorizeBusinessProfileAccess(database.db, {
        userId: agentUserId,
        workspaceId: main.workspaceId,
        businessProfileId: main.businessProfileId,
      });

      await expect(store.connectWhatsAppAccount(agent, input(phoneNumber()))).rejects.toThrow();
      expect(await db().whatsAppConnection.count({ where: { workspaceId: main.workspaceId } })).toBe(0);
      expect(await db().channelCredential.count({ where: { workspaceId: main.workspaceId } })).toBe(0);
    }, 180_000);

    it("refuses the same provider number in a second workspace", async () => {
      const phoneNumberId = phoneNumber();
      await store.connectWhatsAppAccount(main, input(phoneNumberId));

      // One provider number may be live in exactly one Workspace, so webhook routing always resolves to
      // one authorized account — and a business cannot be quietly served by somebody else's tenant.
      await expect(store.connectWhatsAppAccount(sibling, input(phoneNumberId))).rejects.toThrow(/could not be connected/u);
    }, 180_000);

    it("does not leak another profile's connection to a reader", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));

      expect(await store.readConnection(sibling, channelAccountId)).toBeUndefined();
      expect(await store.listTemplates(sibling, channelAccountId)).toEqual([]);
    }, 180_000);
  });

  describe("the invariants the database holds", () => {
    const connectedRow = async (profile: BusinessProfileContext, overrides: Partial<ConnectWhatsAppInput> = {}) => {
      const { channelAccountId } = await store.connectWhatsAppAccount(profile, input(phoneNumber(), overrides));
      return (await store.readConnection(profile, channelAccountId))?.connectionId ?? "";
    };

    it("refuses a connected row whose webhook subscription is missing, in SQL", async () => {
      const connectionId = await connectedRow(main);

      // Written directly, as a later caller or a console would. Without the subscription the connection
      // receives nothing while looking live, which is the state the CHECK exists to forbid.
      await expect(
        db().$executeRaw`UPDATE "whatsapp_connections" SET "webhook_subscribed_at" = NULL WHERE "id" = ${connectionId}`,
      ).rejects.toThrow(/whatsapp_connections_connected_subscribed_check/u);
    }, 180_000);

    it("refuses a connected Cloud API row whose phone registration is missing, in SQL", async () => {
      const connectionId = await connectedRow(main);

      await expect(
        db().$executeRaw`UPDATE "whatsapp_connections" SET "phone_registered_at" = NULL WHERE "id" = ${connectionId}`,
      ).rejects.toThrow(/whatsapp_connections_connected_registered_check/u);
    }, 180_000);

    it("allows a connected coexistence row with no phone registration", async () => {
      // The documented exemption, written out in the constraint rather than implied in code: a number that
      // stays on the WhatsApp Business App is onboarded without a Cloud API registration.
      const connectionId = await connectedRow(main, { onboardingMode: "COEXISTENCE_EXISTING_BUSINESS_APP", phoneRegisteredAt: undefined });

      const row = await db().whatsAppConnection.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: main.workspaceId, id: connectionId } },
        select: { connectedAt: true, phoneRegisteredAt: true, onboardingMode: true },
      });
      expect(row).toMatchObject({ phoneRegisteredAt: null, onboardingMode: "COEXISTENCE_EXISTING_BUSINESS_APP" });
      expect(row.connectedAt).not.toBeNull();
    }, 180_000);

    it("refuses a catalogue that is synced without saying whether it is complete", async () => {
      const connectionId = await connectedRow(main);

      // "Synced, and we do not know whether that is all of them" is a state no screen can explain.
      await expect(
        db().$executeRaw`UPDATE "whatsapp_connections" SET "templates_complete" = NULL WHERE "id" = ${connectionId}`,
      ).rejects.toThrow(/whatsapp_connections_templates_sync_check/u);
    }, 180_000);

    it("refuses an empty health reason, which explains nothing", async () => {
      const connectionId = await connectedRow(main);

      await expect(
        db().$executeRaw`UPDATE "whatsapp_connections" SET "health_reason" = '' WHERE "id" = ${connectionId}`,
      ).rejects.toThrow(/whatsapp_connections_health_reason_check/u);
    }, 180_000);
  });

  describe("health", () => {
    it("keeps the verified claim for a degraded account, because it is still verified", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));

      await store.recordHealth(main, channelAccountId, { status: "DEGRADED", reason: "PROVIDER_QUALITY_RED", now: NOW });

      const connection = await store.readConnection(main, channelAccountId);
      expect(connection).toMatchObject({ status: "DEGRADED", healthReason: "PROVIDER_QUALITY_RED" });
      // Still connected at the provider: a person may approve a reply, and only automation is held.
      expect(connection?.connectedAt).toEqual(NOW);
    }, 180_000);

    it("withdraws the claim when the credential needs re-authorizing", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));

      await store.recordHealth(main, channelAccountId, { status: "NEEDS_REAUTH", reason: "TOKEN_REJECTED", now: NOW });

      // The provider confirmations no longer stand behind a credential Meta refuses, so only a fresh
      // signup can make the claim again.
      expect(await store.readConnection(main, channelAccountId)).toMatchObject({ status: "NEEDS_REAUTH", connectedAt: undefined });
    }, 180_000);

    it("records a connection the provider flagged at connect time as degraded", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(
        main,
        input(phoneNumber(), { health: { status: "DEGRADED", reason: "PROVIDER_QUALITY_RED" } }),
      );

      expect(await store.readConnection(main, channelAccountId)).toMatchObject({ status: "DEGRADED", healthReason: "PROVIDER_QUALITY_RED" });
    }, 180_000);
  });

  describe("the template catalogue", () => {
    it("replaces it, so a template deleted at Meta disappears here too", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));

      await store.syncTemplates(main, channelAccountId, {
        records: [{ providerTemplateId: "tpl_1", name: "appointment_reminder", language: "en_US", status: "APPROVED" }],
        complete: true,
        syncedAt: NOW,
      });

      // A stale row is a template a send could name and the provider would refuse — after the customer
      // was promised a reply.
      expect((await store.listTemplates(main, channelAccountId)).map((template) => template.language)).toEqual(["en_US"]);
    }, 180_000);

    it("keeps one row per name and language, which is how Meta identifies a template", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));
      const connection = await store.readConnection(main, channelAccountId);

      await expect(
        db().whatsAppMessageTemplate.create({
          data: {
            workspaceId: main.workspaceId,
            connectionId: connection?.connectionId ?? "",
            providerTemplateId: "tpl_3",
            name: "appointment_reminder",
            language: "en_US",
            status: "APPROVED",
            syncedAt: NOW,
          },
        }),
      ).rejects.toThrow();
    }, 180_000);

    it("says nothing was written for an account that is not this profile's", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));

      expect(await store.syncTemplates(sibling, channelAccountId, { records: [], complete: true, syncedAt: NOW })).toEqual({ written: 0 });
      expect(await store.listTemplates(main, channelAccountId)).toHaveLength(2);
    }, 180_000);
  });

  describe("reconnecting and disconnecting", () => {
    it("destroys the secret, frees the slot and withdraws the claim in one transaction", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));
      const connection = await store.readConnection(main, channelAccountId);

      await store.disconnectWhatsAppAccount(main, channelAccountId, disconnectedAt());

      expect(await store.readConnection(main, channelAccountId)).toMatchObject({
        status: "DISCONNECTED",
        connectedAt: undefined,
        webhookSubscribedAt: undefined,
        healthReason: "DISCONNECTED",
      });
      // The secret is gone rather than merely unreachable: an account that reads as disconnected while
      // its token is still usable is the half-state nobody goes looking for.
      expect(await store.readCredential(main, { credentialId: connection?.credentialId ?? "", purpose: PURPOSE })).toBeUndefined();
      const row = await db().channelCredential.findFirstOrThrow({
        where: { workspaceId: main.workspaceId, id: connection?.credentialId },
        select: { revokedAt: true },
      });
      expect(row.revokedAt).not.toBeNull();
    }, 180_000);

    it("reconnects the same account rather than creating a second logical tenant", async () => {
      const phoneNumberId = phoneNumber();
      const first = await store.connectWhatsAppAccount(main, input(phoneNumberId));
      await store.disconnectWhatsAppAccount(main, first.channelAccountId, disconnectedAt());

      // Real time again: reviving the credential records when it was restored, and lifetimes move forward.
      const reconnectedAt = disconnectedAt();
      const again = await store.connectWhatsAppAccount(main, input(phoneNumberId, { token: "EAAtest-second-token", now: reconnectedAt }));

      // The same row, so conversations and audit history stay attached to it.
      expect(again.channelAccountId).toBe(first.channelAccountId);
      expect(again.connectionId).toBe(first.connectionId);
      const connection = await store.readConnection(main, again.channelAccountId);
      expect(connection).toMatchObject({ status: "CONNECTED", healthReason: undefined });
      expect(connection?.connectedAt).toEqual(reconnectedAt);
      // And the revived credential carries the new token, not the destroyed one.
      expect((await store.readCredential(main, { credentialId: connection?.credentialId ?? "", purpose: PURPOSE }))?.token).toBe("EAAtest-second-token");
    }, 180_000);

    it("records the disconnection in the audit trail", async () => {
      const { channelAccountId } = await store.connectWhatsAppAccount(main, input(phoneNumber()));

      await store.disconnectWhatsAppAccount(main, channelAccountId, disconnectedAt());

      const event = await db().auditEvent.findFirstOrThrow({
        where: { workspaceId: main.workspaceId, subjectId: channelAccountId, kind: "CHANNEL_DISCONNECTED" },
        select: { detail: true, actorUserId: true },
      });
      expect(event.detail).toMatchObject({ credentialRevoked: true });
      expect(event.actorUserId).toBe(main.userId);
    }, 180_000);

    it("frees the number for a different workspace once it is disconnected", async () => {
      const phoneNumberId = phoneNumber();
      const first = await store.connectWhatsAppAccount(main, input(phoneNumberId));
      await store.disconnectWhatsAppAccount(main, first.channelAccountId, disconnectedAt());

      // A disconnected row is history: it must not stop the business moving its number elsewhere.
      const moved = await store.connectWhatsAppAccount(sibling, input(phoneNumberId));

      expect(moved.channelAccountId).not.toBe(first.channelAccountId);
      expect(await store.readConnection(sibling, moved.channelAccountId)).toMatchObject({ status: "CONNECTED" });
    }, 180_000);
  });
});
