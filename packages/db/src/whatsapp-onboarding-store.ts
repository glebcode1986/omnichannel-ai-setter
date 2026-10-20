/**
 * Persistence for WhatsApp onboarding (Issue #19, ADR-015, WHATSAPP_ONBOARDING.md).
 *
 * The flow lives in the web app; everything that touches the database lives here, behind one interface, so
 * the flow can be tested without a database exactly as webhook ingestion is. Every mutating call takes an
 * issued `BusinessProfileContext`, so a caller cannot invent a scope, and the admin-role check rides along
 * inside `connectChannelAccount`.
 *
 * **Connecting is one transaction.** The credential, the channel account, the WhatsApp provider assets and
 * the template catalogue are written together or not at all. Split apart, any failure between them leaves
 * one of three bad half-states: an account pointing at a credential that was never written, a credential
 * nothing references, or — the worst, because nobody goes looking for it — a connection that reads as live
 * while its provider assets are missing, so webhook routing resolves a number to a row that cannot say
 * which messaging account it belongs to.
 *
 * **`connected_at` is the claim, and the database checks it.** It is set only in the same statement that
 * records the provider's confirmations, and CHECK constraints refuse the row unless the webhook
 * subscription is present — and, outside coexistence, the phone registration too. That keeps
 * "connected only after required verification succeeded" true against this store, a migration, a console
 * and anything written later.
 */
import type { ChannelCapabilities } from "@omnichannel/domain";

import { recordAuditEvent } from "./audit-store";
import type { DbClient, DbExecutor } from "./client";
import type { CredentialCipher, CredentialPurpose } from "./credentials";
import {
  connectChannelAccount,
  setChannelAccountStatus,
  type ChannelAccountStatusValue,
} from "./repositories/channel-accounts";
import { consumeChannelConnectState, createChannelConnectState } from "./repositories/channel-connect-states";
import {
  readChannelCredential,
  restoreChannelCredential,
  revokeChannelCredential,
  rotateChannelCredential,
  writeChannelCredential,
} from "./repositories/channel-credentials";
import type { ChannelOnboardingStore } from "./onboarding-store";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export type WhatsAppOnboardingModeValue = "NEW_OR_MIGRATED_CLOUD_NUMBER" | "COEXISTENCE_EXISTING_BUSINESS_APP" | "UNKNOWN";

/** What Meta said the number is. Read back from the provider, never taken from a browser payload. */
export interface WhatsAppPhoneAsset {
  readonly phoneNumberId: string;
  readonly displayPhoneNumber?: string;
  readonly verifiedName?: string;
  readonly qualityRating?: string;
  readonly codeVerificationStatus?: string;
  readonly platformType?: string;
}

export interface WhatsAppTemplateInput {
  readonly providerTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly category?: string;
  readonly status: string;
  readonly components?: readonly unknown[];
}

export interface WhatsAppConnectionRecord {
  readonly connectionId: string;
  readonly channelAccountId: string;
  readonly credentialId: string | undefined;
  readonly wabaId: string;
  readonly businessPortfolioId: string | undefined;
  readonly displayPhoneNumber: string | undefined;
  readonly verifiedName: string | undefined;
  readonly qualityRating: string | undefined;
  readonly onboardingMode: WhatsAppOnboardingModeValue;
  readonly webhookSubscribedAt: Date | undefined;
  readonly phoneRegisteredAt: Date | undefined;
  readonly templatesSyncedAt: Date | undefined;
  readonly templatesComplete: boolean | undefined;
  readonly connectedAt: Date | undefined;
  readonly healthReason: string | undefined;
  readonly status: ChannelAccountStatusValue;
}

export interface ConnectWhatsAppInput {
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly businessPortfolioId?: string;
  readonly asset: WhatsAppPhoneAsset;
  readonly onboardingMode: WhatsAppOnboardingModeValue;
  readonly capabilities: ChannelCapabilities;
  readonly purpose: CredentialPurpose;
  readonly token: string;
  readonly expiresAt: Date;
  readonly webhookSubscribedAt: Date;
  /** Absent for a coexistence number, which Meta onboards without a Cloud API registration. */
  readonly phoneRegisteredAt?: Date;
  readonly templates?: {
    readonly records: readonly WhatsAppTemplateInput[];
    readonly complete: boolean;
    readonly syncedAt: Date;
  };
  readonly health: { readonly status: Extract<ChannelAccountStatusValue, "CONNECTED" | "DEGRADED">; readonly reason?: string };
  readonly now: Date;
}

export interface WhatsAppOnboardingStore extends ChannelOnboardingStore {
  connectWhatsAppAccount(context: BusinessProfileContext, input: ConnectWhatsAppInput): Promise<{ readonly channelAccountId: string; readonly connectionId: string }>;
  readConnection(context: BusinessProfileContext, channelAccountId: string): Promise<WhatsAppConnectionRecord | undefined>;
  /** Health only: never a path back to CONNECTED, which requires the provider confirmations above. */
  recordHealth(
    context: BusinessProfileContext,
    channelAccountId: string,
    input: { readonly status: Extract<ChannelAccountStatusValue, "DEGRADED" | "NEEDS_REAUTH">; readonly reason: string; readonly now: Date },
  ): Promise<void>;
  syncTemplates(
    context: BusinessProfileContext,
    channelAccountId: string,
    input: { readonly records: readonly WhatsAppTemplateInput[]; readonly complete: boolean; readonly syncedAt: Date },
  ): Promise<{ readonly written: number }>;
  listTemplates(context: BusinessProfileContext, channelAccountId: string): Promise<readonly WhatsAppTemplateInput[]>;
  disconnectWhatsAppAccount(context: BusinessProfileContext, channelAccountId: string, now: Date): Promise<void>;
}

export function createWhatsAppOnboardingStore(db: DbClient, cipher: CredentialCipher): WhatsAppOnboardingStore {
  return {
    createConnectState: async (context, input) => createChannelConnectState(db, context, input),
    consumeConnectState: async (input) => consumeChannelConnectState(db, input),

    async findAccountByExternalId(context, input) {
      const scope = profileScopeOf(context);
      const account = await db.channelAccount.findFirst({
        where: { ...scope, channel: input.channel, externalAccountId: input.externalAccountId },
        select: { id: true, credentialId: true },
      });
      return account === null ? undefined : { channelAccountId: account.id, credentialId: account.credentialId ?? undefined };
    },

    async findAccountById(context, channelAccountId) {
      const scope = profileScopeOf(context);
      const account = await db.channelAccount.findUnique({
        where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
        select: { id: true, credentialId: true },
      });
      return account === null ? undefined : { channelAccountId: account.id, credentialId: account.credentialId ?? undefined };
    },

    async connectWhatsAppAccount(context, input) {
      const scope = profileScopeOf(context);
      return db.$transaction(async (tx) => {
        const existing = await tx.channelAccount.findFirst({
          where: { ...scope, channel: "WHATSAPP", externalAccountId: input.phoneNumberId },
          select: { credentialId: true },
        });
        const existingCredentialId = existing?.credentialId ?? undefined;
        const credentialId =
          existingCredentialId ??
          (
            await writeChannelCredential(tx, cipher, {
              workspaceId: scope.workspaceId,
              purpose: input.purpose,
              token: input.token,
              expiresAt: input.expiresAt,
            })
          ).credentialId;
        if (existingCredentialId !== undefined) {
          // Reconnect: the credential row keeps its identity so the account's history stays attached to
          // it. Restored rather than rotated — a rotation refuses a revoked credential on purpose, and a
          // reconnect after a disconnect is exactly that case, except that reviving it is the point.
          await restoreChannelCredential(tx, cipher, {
            workspaceId: scope.workspaceId,
            credentialId: existingCredentialId,
            purpose: input.purpose,
            token: input.token,
            expiresAt: input.expiresAt,
            restoredAt: input.now,
          });
        }

        // Carries the admin-role check and the live-account uniqueness, so a caller without the role or a
        // number already live elsewhere reaches nothing below this line.
        const account = await connectChannelAccount(tx, context, {
          channel: "WHATSAPP",
          externalAccountId: input.phoneNumberId,
          ...(input.asset.verifiedName === undefined ? {} : { displayName: input.asset.verifiedName }),
          capabilities: input.capabilities,
          credentialId,
        });

        const connection = await upsertConnection(tx, scope, account.id, input);
        if (input.templates !== undefined) {
          await replaceTemplates(tx, scope.workspaceId, connection.id, input.templates);
        }
        if (input.health.status !== "CONNECTED") {
          // Set after the connection row exists, so the CHECKs have already passed on a complete row.
          await setChannelAccountStatus(tx, context, account.id, input.health.status);
        }
        await recordAuditEvent(tx, context, {
          kind: "CHANNEL_CONNECTED",
          summary: `Connected a WhatsApp number (${input.onboardingMode})`,
          subjectType: "channel_accounts",
          subjectId: account.id,
          actorUserId: context.userId,
          channelAccountId: account.id,
          // Identifiers and states only. No token, no PIN, no provider prose.
          detail: {
            wabaId: input.wabaId,
            phoneNumberId: input.phoneNumberId,
            onboardingMode: input.onboardingMode,
            phoneRegistered: input.phoneRegisteredAt !== undefined,
            templatesSynced: input.templates !== undefined,
            health: input.health.status,
          },
        });
        return { channelAccountId: account.id, connectionId: connection.id };
      });
    },

    async readConnection(context, channelAccountId) {
      const scope = profileScopeOf(context);
      const row = await db.whatsAppConnection.findFirst({
        where: { ...scope, channelAccountId },
        select: {
          id: true,
          channelAccountId: true,
          wabaId: true,
          businessPortfolioId: true,
          displayPhoneNumber: true,
          verifiedName: true,
          qualityRating: true,
          onboardingMode: true,
          webhookSubscribedAt: true,
          phoneRegisteredAt: true,
          templatesSyncedAt: true,
          templatesComplete: true,
          connectedAt: true,
          healthReason: true,
          channelAccount: { select: { status: true, credentialId: true } },
        },
      });
      if (row === null) {
        return undefined;
      }
      return {
        connectionId: row.id,
        channelAccountId: row.channelAccountId,
        credentialId: row.channelAccount.credentialId ?? undefined,
        wabaId: row.wabaId,
        businessPortfolioId: row.businessPortfolioId ?? undefined,
        displayPhoneNumber: row.displayPhoneNumber ?? undefined,
        verifiedName: row.verifiedName ?? undefined,
        qualityRating: row.qualityRating ?? undefined,
        onboardingMode: row.onboardingMode,
        webhookSubscribedAt: row.webhookSubscribedAt ?? undefined,
        phoneRegisteredAt: row.phoneRegisteredAt ?? undefined,
        templatesSyncedAt: row.templatesSyncedAt ?? undefined,
        templatesComplete: row.templatesComplete ?? undefined,
        connectedAt: row.connectedAt ?? undefined,
        healthReason: row.healthReason ?? undefined,
        status: row.channelAccount.status,
      };
    },

    async recordHealth(context, channelAccountId, input) {
      const scope = profileScopeOf(context);
      await db.$transaction(async (tx) => {
        // The status write carries the authorization check, so it runs first.
        await setChannelAccountStatus(tx, context, channelAccountId, input.status);
        await tx.whatsAppConnection.updateMany({
          where: { ...scope, channelAccountId },
          data: {
            healthReason: input.reason,
            // A token or permission failure means the provider confirmations no longer stand, so the claim
            // is withdrawn and only a fresh signup can make it again. DEGRADED is a quality warning about
            // a connection that is still verified, so it keeps its claim.
            ...(input.status === "NEEDS_REAUTH" ? { connectedAt: null } : {}),
          },
        });
      });
    },

    async syncTemplates(context, channelAccountId, input) {
      const scope = profileScopeOf(context);
      const connection = await db.whatsAppConnection.findFirst({ where: { ...scope, channelAccountId }, select: { id: true } });
      if (connection === null) {
        return { written: 0 };
      }
      return db.$transaction(async (tx) => {
        await replaceTemplates(tx, scope.workspaceId, connection.id, input);
        return { written: input.records.length };
      });
    },

    async listTemplates(context, channelAccountId) {
      const scope = profileScopeOf(context);
      const rows = await db.whatsAppMessageTemplate.findMany({
        where: { workspaceId: scope.workspaceId, connection: { ...scope, channelAccountId } },
        orderBy: [{ name: "asc" }, { language: "asc" }],
        select: { providerTemplateId: true, name: true, language: true, category: true, status: true, components: true },
      });
      return rows.map((row) => ({
        providerTemplateId: row.providerTemplateId,
        name: row.name,
        language: row.language,
        status: row.status,
        ...(row.category === null ? {} : { category: row.category }),
        ...(Array.isArray(row.components) ? { components: row.components } : {}),
      }));
    },

    async readCredential(context, input) {
      return readChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input });
    },

    async rotateCredential(context, input) {
      return rotateChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input });
    },

    async revokeCredential(context, input) {
      await revokeChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input });
    },

    async setAccountStatus(context, channelAccountId, status) {
      await setChannelAccountStatus(db, context, channelAccountId, status);
    },

    async disconnectWhatsAppAccount(context, channelAccountId, now) {
      const scope = profileScopeOf(context);
      await db.$transaction(async (tx) => {
        await setChannelAccountStatus(tx, context, channelAccountId, "DISCONNECTED");
        // The claim goes with the status, in the same transaction: a disconnected account that still
        // claims a verified connection is the state a later reconnect would skip its checks on.
        await tx.whatsAppConnection.updateMany({
          where: { ...scope, channelAccountId },
          data: { connectedAt: null, webhookSubscribedAt: null, healthReason: "DISCONNECTED" },
        });
        const account = await tx.channelAccount.findUnique({
          where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
          select: { credential: { select: { id: true, purpose: true } } },
        });
        const credential = account?.credential;
        if (credential !== null && credential !== undefined) {
          // The purpose comes from the row rather than a caller's constant: it is bound into the
          // tombstone's authenticated data, and a mismatched one would write an unreadable record.
          await revokeChannelCredential(tx, cipher, {
            workspaceId: scope.workspaceId,
            credentialId: credential.id,
            purpose: credential.purpose as CredentialPurpose,
            now,
          });
        }
        await recordAuditEvent(tx, context, {
          kind: "CHANNEL_DISCONNECTED",
          summary: "Disconnected a WhatsApp number",
          subjectType: "channel_accounts",
          subjectId: channelAccountId,
          actorUserId: context.userId,
          channelAccountId,
          detail: { credentialRevoked: credential !== null && credential !== undefined },
        });
      });
    },
  };
}

async function upsertConnection(
  tx: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  channelAccountId: string,
  input: ConnectWhatsAppInput,
): Promise<{ readonly id: string }> {
  const data = {
    wabaId: input.wabaId,
    businessPortfolioId: input.businessPortfolioId ?? null,
    displayPhoneNumber: input.asset.displayPhoneNumber ?? null,
    verifiedName: input.asset.verifiedName ?? null,
    qualityRating: input.asset.qualityRating ?? null,
    codeVerificationStatus: input.asset.codeVerificationStatus ?? null,
    platformType: input.asset.platformType ?? null,
    onboardingMode: input.onboardingMode,
    webhookSubscribedAt: input.webhookSubscribedAt,
    phoneRegisteredAt: input.phoneRegisteredAt ?? null,
    templatesSyncedAt: input.templates?.syncedAt ?? null,
    templatesComplete: input.templates?.complete ?? null,
    connectedAt: input.now,
    healthReason: input.health.reason ?? null,
  };
  const existing = await tx.whatsAppConnection.findFirst({ where: { ...scope, channelAccountId }, select: { id: true } });
  if (existing === null) {
    return tx.whatsAppConnection.create({ data: { ...scope, channelAccountId, ...data }, select: { id: true } });
  }
  return tx.whatsAppConnection.update({ where: { workspaceId_id: { workspaceId: scope.workspaceId, id: existing.id } }, data, select: { id: true } });
}

/**
 * Replaces the catalogue for one connection.
 *
 * Replaced rather than merged, because a template the business deleted at Meta must disappear here too: a
 * stale row is a template a send could name and the provider would refuse, and the refusal would arrive
 * after the customer was promised a reply.
 */
async function replaceTemplates(
  tx: DbExecutor,
  workspaceId: string,
  connectionId: string,
  input: { readonly records: readonly WhatsAppTemplateInput[]; readonly complete: boolean; readonly syncedAt: Date },
): Promise<void> {
  await tx.whatsAppMessageTemplate.deleteMany({ where: { workspaceId, connectionId } });
  if (input.records.length > 0) {
    await tx.whatsAppMessageTemplate.createMany({
      data: input.records.map((record) => ({
        workspaceId,
        connectionId,
        providerTemplateId: record.providerTemplateId,
        name: record.name,
        language: record.language,
        category: record.category ?? null,
        status: record.status,
        components: record.components === undefined ? undefined : (record.components as object),
        syncedAt: input.syncedAt,
      })),
    });
  }
  await tx.whatsAppConnection.update({
    where: { workspaceId_id: { workspaceId, id: connectionId } },
    data: { templatesSyncedAt: input.syncedAt, templatesComplete: input.complete },
  });
}
