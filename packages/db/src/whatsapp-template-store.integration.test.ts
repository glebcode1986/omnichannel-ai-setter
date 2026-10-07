/**
 * The template catalogue as the send path and the provider's webhooks reach it (Issue #20).
 *
 * Two things can only be tested against a real server. **A status update applies to every number on the
 * messaging account**, because the template belongs to the account rather than to one of them — and
 * updating only the number a webhook happened to arrive on would leave the others sending on a status Meta
 * has withdrawn. And **the shape columns hold what the parser wrote**, including the CHECKs that refuse a
 * format the code does not have.
 */
import { randomBytes } from "node:crypto";

import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCredentialCipher } from "./credentials";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createBusinessProfile } from "./repositories/workspaces";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, createPaidWorkspace } from "./testing/fixtures";
import { applyTemplateStatusUpdate, readTemplateCatalogue } from "./whatsapp-template-store";
import { createWhatsAppOnboardingStore, type ConnectWhatsAppInput, type WhatsAppOnboardingStore } from "./whatsapp-onboarding-store";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const WABA_ID = "102290129340398";

describe.skipIf(!databaseTestsEnabled())("whatsapp template catalogue (PostgreSQL)", () => {
  let database: TestDatabase;
  let main: BusinessProfileContext;
  let other: BusinessProfileContext;
  let store: WhatsAppOnboardingStore;
  const cipher = createCredentialCipher({ keyId: "k1", keys: { k1: randomBytes(32) } });
  const db = () => database.db;
  let sequence = 0;
  const phoneNumber = () => `1065403522${String(20_000 + ++sequence)}`;
  /**
   * A messaging account per case.
   *
   * The suite shares one database, and a status update applies to every connection on its messaging
   * account — which is the property under test. Reusing one id would make each case's row count include
   * every earlier case's connections, so the assertion would measure the suite rather than the behaviour.
   */
  const messagingAccount = () => `10229012934${String(1_000 + ++sequence)}`;

  const bareProfile = async (label: string): Promise<BusinessProfileContext> => {
    const ownerUserId = await createTestUser(database.db, `${label}-${String(++sequence)}`);
    const { workspaceId } = await createPaidWorkspace(database.db, { name: `Workspace ${label}`, ownerUserId });
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(database.db, workspace, { name: `Profile ${label}` });
    return authorizeBusinessProfileAccess(database.db, { userId: ownerUserId, workspaceId, businessProfileId });
  };

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = createWhatsAppOnboardingStore(database.db, cipher);
  }, 180_000);

  beforeEach(async () => {
    main = await bareProfile("tpl-main");
    other = await bareProfile("tpl-other");
  });

  afterAll(async () => {
    await database?.dispose();
  });

  const connect = async (
    context: BusinessProfileContext,
    overrides: { readonly wabaId?: string; readonly templates?: ConnectWhatsAppInput["templates"] } = {},
  ) => {
    const phoneNumberId = phoneNumber();
    const connected = await store.connectWhatsAppAccount(context, {
      phoneNumberId,
      wabaId: overrides.wabaId ?? WABA_ID,
      asset: { phoneNumberId, verifiedName: "Test Business" },
      onboardingMode: "NEW_OR_MIGRATED_CLOUD_NUMBER",
      capabilities: { ...NO_CAPABILITIES, text: true, templates: true },
      purpose: "WHATSAPP_BUSINESS_TOKEN",
      token: `EAAtest-${phoneNumberId}`,
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
      webhookSubscribedAt: NOW,
      phoneRegisteredAt: NOW,
      templates: overrides.templates ?? {
        records: [
          {
            providerTemplateId: `tpl_${phoneNumberId}_1`,
            name: "appointment_reminder",
            language: "en_US",
            category: "UTILITY",
            status: "APPROVED",
            parameterFormat: "POSITIONAL",
            parameters: ["1", "2"],
          },
          {
            providerTemplateId: `tpl_${phoneNumberId}_2`,
            name: "order_confirmation",
            language: "en_US",
            status: "APPROVED",
            parameterFormat: "NAMED",
            parameters: ["first_name", "order_number"],
          },
        ],
        complete: true,
        syncedAt: NOW,
      },
      health: { status: "CONNECTED" },
      now: NOW,
    });
    return connected;
  };

  describe("reading the catalogue for a send decision", () => {
    it("returns the parsed shape, not the provider's components", async () => {
      // The shape is parsed once at sync. Deriving it on the way to a customer would put a parser in the
      // dispatch path, and a parser that changed its mind would change what customers receive.
      const { channelAccountId } = await connect(main);

      const catalogue = await readTemplateCatalogue(db(), { workspaceId: main.workspaceId, channelAccountId });

      expect(catalogue.map((template) => `${template.name}/${template.format}/${template.parameters.join("+")}`)).toEqual([
        "appointment_reminder/POSITIONAL/1+2",
        "order_confirmation/NAMED/first_name+order_number",
      ]);
      expect(catalogue[0]?.syncedAt).toEqual(NOW);
      expect(catalogue[0]?.status).toBe("APPROVED");
    }, 180_000);

    it("is scoped to the account, so one tenant's catalogue is not another's", async () => {
      const mine = await connect(main);
      await connect(other);

      // No authorization context reaches this far — it is a worker read — so the scope is the workspace
      // and the channel account that were already resolved, and both are required.
      expect(await readTemplateCatalogue(db(), { workspaceId: other.workspaceId, channelAccountId: mine.channelAccountId })).toEqual([]);
    }, 180_000);

    it("returns nothing for an account with no connection at all", async () => {
      expect(await readTemplateCatalogue(db(), { workspaceId: main.workspaceId, channelAccountId: "ca_nonexistent" })).toEqual([]);
    }, 180_000);
  });

  describe("a status change arriving from the provider", () => {
    it("applies to every number on the messaging account", async () => {
      // One messaging account, two numbers. The template belongs to the account.
      const wabaId = messagingAccount();
      const first = await connect(main, { wabaId });
      const second = await connect(other, { wabaId });
      const at = new Date(NOW.getTime() + 60_000);

      const { updated } = await applyTemplateStatusUpdate(db(), {
        wabaId,
        name: "appointment_reminder",
        languageCode: "en_US",
        status: "PAUSED",
        at,
      });

      expect(updated).toBe(2);
      for (const [context, connected] of [
        [main, first],
        [other, second],
      ] as const) {
        const catalogue = await readTemplateCatalogue(db(), { workspaceId: context.workspaceId, channelAccountId: connected.channelAccountId });
        expect(catalogue.find((template) => template.name === "appointment_reminder")).toMatchObject({ status: "PAUSED", syncedAt: at });
      }
    }, 180_000);

    it("moves the sync time, because the provider has just stated the current status", async () => {
      // Leaving the old timestamp would let a freshness bound refuse a template the webhook had only just
      // confirmed as approved.
      const wabaId = messagingAccount();
      const { channelAccountId } = await connect(main, { wabaId });
      const at = new Date(NOW.getTime() + 3_600_000);

      await applyTemplateStatusUpdate(db(), { wabaId, name: "order_confirmation", languageCode: "en_US", status: "APPROVED", at });

      const catalogue = await readTemplateCatalogue(db(), { workspaceId: main.workspaceId, channelAccountId });
      expect(catalogue.find((template) => template.name === "order_confirmation")?.syncedAt).toEqual(at);
    }, 180_000);

    it("leaves other languages of the same template alone", async () => {
      // A template's identity is its name *and* its language: pausing the English one says nothing about
      // the Russian one.
      const wabaId = messagingAccount();
      const { channelAccountId } = await connect(main, {
        wabaId,
        templates: {
          records: [
            { providerTemplateId: "tpl_en", name: "appointment_reminder", language: "en_US", status: "APPROVED", parameterFormat: "POSITIONAL", parameters: ["1"] },
            { providerTemplateId: "tpl_ru", name: "appointment_reminder", language: "ru", status: "APPROVED", parameterFormat: "POSITIONAL", parameters: ["1"] },
          ],
          complete: true,
          syncedAt: NOW,
        },
      });

      await applyTemplateStatusUpdate(db(), { wabaId, name: "appointment_reminder", languageCode: "en_US", status: "REJECTED", at: NOW });

      const catalogue = await readTemplateCatalogue(db(), { workspaceId: main.workspaceId, channelAccountId });
      expect(catalogue.map((template) => `${template.languageCode}/${template.status}`)).toEqual(["en_US/REJECTED", "ru/APPROVED"]);
    }, 180_000);

    it("changes nothing for a messaging account nobody connected", async () => {
      await connect(main);

      expect(await applyTemplateStatusUpdate(db(), { wabaId: "999999999999999", name: "appointment_reminder", languageCode: "en_US", status: "PAUSED", at: NOW })).toEqual({
        updated: 0,
      });
    }, 180_000);

    it("is idempotent, because the provider retries a failed delivery for days", async () => {
      // Meta retries with decreasing frequency for up to seven days and delivers retries to every
      // subscribed app, so a duplicate is ordinary rather than exceptional.
      const wabaId = messagingAccount();
      const { channelAccountId } = await connect(main, { wabaId });
      const update = { wabaId, name: "appointment_reminder", languageCode: "en_US", status: "DISABLED", at: NOW } as const;

      await applyTemplateStatusUpdate(db(), update);
      await applyTemplateStatusUpdate(db(), update);

      const catalogue = await readTemplateCatalogue(db(), { workspaceId: main.workspaceId, channelAccountId });
      expect(catalogue.filter((template) => template.name === "appointment_reminder")).toHaveLength(1);
      expect(catalogue.find((template) => template.name === "appointment_reminder")?.status).toBe("DISABLED");
    }, 180_000);
  });

  describe("the invariants the database holds", () => {
    it("refuses a parameter format the code does not have", async () => {
      const { channelAccountId } = await connect(main);
      const row = await db().whatsAppMessageTemplate.findFirstOrThrow({
        where: { workspaceId: main.workspaceId, connection: { channelAccountId } },
        select: { id: true },
      });

      await expect(
        db().$executeRaw`UPDATE "whatsapp_message_templates" SET "parameter_format" = 'ORDINAL' WHERE "id" = ${row.id}`,
      ).rejects.toThrow(/whatsapp_message_templates_parameter_format_check/u);
    }, 180_000);

    it("refuses a placeholder with no name, which is a hole nothing can fill", async () => {
      const { channelAccountId } = await connect(main);
      const row = await db().whatsAppMessageTemplate.findFirstOrThrow({
        where: { workspaceId: main.workspaceId, connection: { channelAccountId } },
        select: { id: true },
      });

      await expect(
        db().$executeRaw`UPDATE "whatsapp_message_templates" SET "parameters" = ARRAY['1', ''] WHERE "id" = ${row.id}`,
      ).rejects.toThrow(/whatsapp_message_templates_parameter_names_check/u);
    }, 180_000);
  });
});
