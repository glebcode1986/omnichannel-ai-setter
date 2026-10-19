/**
 * Persistence port for channel onboarding, and its PostgreSQL implementation.
 *
 * The flow itself (state, scopes, token exchange) lives in the web app; everything that touches the database
 * lives here, behind one interface. That keeps authorization where it belongs — every mutating call takes an
 * issued `BusinessProfileContext`, so a caller cannot invent a scope — while letting the flow be tested
 * without a database, exactly as webhook ingestion is.
 */
import type { ChannelCapabilities, ChannelType } from "@omnichannel/domain";

import type { DbClient } from "./client";
import type { CredentialCipher, CredentialPurpose } from "./credentials";
import {
  connectChannelAccount,
  setChannelAccountStatus,
  type ChannelAccountStatusValue,
} from "./repositories/channel-accounts";
import {
  consumeChannelConnectState,
  createChannelConnectState,
  type ConnectStateRecord,
} from "./repositories/channel-connect-states";
import {
  readChannelCredential,
  revokeChannelCredential,
  restoreChannelCredential,
  rotateChannelCredential,
  writeChannelCredential,
  type CredentialRotation,
  type StoredCredential,
} from "./repositories/channel-credentials";
import { recordAuditEvent } from "./audit-store";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export interface ConnectedAccountRef {
  readonly channelAccountId: string;
  readonly credentialId: string | undefined;
}

export interface InstagramOnboardingStore {
  createConnectState(
    context: BusinessProfileContext,
    input: {
      readonly stateId: string;
      readonly nonceHash: Uint8Array;
      readonly channel: ChannelType;
      readonly requestedScopes: readonly string[];
      readonly expiresAt: Date;
    },
  ): Promise<void>;
  /** Single-use: a replayed callback must find nothing. */
  consumeConnectState(input: { readonly stateId: string; readonly now: Date }): Promise<ConnectStateRecord | undefined>;

  findAccountByExternalId(
    context: BusinessProfileContext,
    input: { readonly channel: ChannelType; readonly externalAccountId: string },
  ): Promise<ConnectedAccountRef | undefined>;
  findAccountById(context: BusinessProfileContext, channelAccountId: string): Promise<ConnectedAccountRef | undefined>;

  /**
   * Stores the credential and connects (or reconnects) the account in one transaction, so an account never
   * points at a credential that was not written, and a written credential is never orphaned.
   */
  connectAccount(
    context: BusinessProfileContext,
    input: {
      readonly channel: ChannelType;
      readonly externalAccountId: string;
      readonly displayName?: string;
      readonly capabilities: ChannelCapabilities;
      readonly purpose: CredentialPurpose;
      readonly token: string;
      readonly expiresAt: Date;
      readonly now: Date;
    },
  ): Promise<{ readonly channelAccountId: string }>;

  setAccountStatus(context: BusinessProfileContext, channelAccountId: string, status: ChannelAccountStatusValue): Promise<void>;
  /**
   * Disconnects an account and destroys its stored secret in **one** transaction.
   *
   * The two writes cannot be separated. Done apart, a failure between them leaves an account that reads
   * as disconnected — its live slot freed, its UI saying the connection is gone — while the encrypted
   * token is still there and still usable. That is the worst of the two possible half-states, because it
   * is the one nobody goes looking for.
   */
  disconnectAccount(context: BusinessProfileContext, channelAccountId: string, now: Date): Promise<void>;

  readCredential(
    context: BusinessProfileContext,
    input: { readonly credentialId: string; readonly purpose: CredentialPurpose },
  ): Promise<StoredCredential | undefined>;
  /** Returns `SUPERSEDED` when the credential moved on while the provider call was in flight. */
  rotateCredential(
    context: BusinessProfileContext,
    input: {
      readonly credentialId: string;
      readonly purpose: CredentialPurpose;
      readonly token: string;
      readonly expiresAt: Date;
      readonly refreshedAt: Date;
      /** The mint time the rotation was computed from; the write applies only if it is still current. */
      readonly mintedAt?: Date;
    },
  ): Promise<CredentialRotation>;
  revokeCredential(
    context: BusinessProfileContext,
    input: { readonly credentialId: string; readonly purpose: CredentialPurpose; readonly now: Date },
  ): Promise<void>;
}

export function createInstagramOnboardingStore(db: DbClient, cipher: CredentialCipher): InstagramOnboardingStore {
  return {
    // Every method is async so that a rejected context reaches the caller as a rejected promise, never as a
    // synchronous throw from what the port declares as an async call.
    createConnectState: async (context, input) => createChannelConnectState(db, context, input),

    consumeConnectState: async (input) => consumeChannelConnectState(db, input),

    async findAccountByExternalId(context, input) {
      // Rejects a context that did not come from authorization, exactly as the repositories do.
      const scope = profileScopeOf(context);
      const account = await db.channelAccount.findFirst({
        where: {
          ...scope,
          channel: input.channel,
          externalAccountId: input.externalAccountId,
        },
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

    async connectAccount(context, input) {
      const scope = profileScopeOf(context);
      return db.$transaction(async (tx) => {
        const existing = await tx.channelAccount.findFirst({
          where: { ...scope, channel: input.channel, externalAccountId: input.externalAccountId },
          select: { credentialId: true },
        });
        const existingCredentialId = existing?.credentialId ?? undefined;
        if (existingCredentialId === undefined) {
          const { credentialId } = await writeChannelCredential(tx, cipher, {
            workspaceId: scope.workspaceId,
            purpose: input.purpose,
            token: input.token,
            expiresAt: input.expiresAt,
          });
          const account = await connectChannelAccount(tx, context, {
            channel: input.channel,
            externalAccountId: input.externalAccountId,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            capabilities: input.capabilities,
            credentialId,
          });
          return { channelAccountId: account.id };
        }
        // Reconnect: the credential row keeps its identity so the account's history stays attached to it.
        //
        // Restored, not rotated. A rotation refuses a revoked credential on purpose — that is what stops
        // a refresh in flight from resurrecting a token a disconnect destroyed — and a reconnect after a
        // disconnect is exactly that case, except that here reviving the row is the point: a person has
        // just re-authorized and the provider issued a new token. It throws if it restores nothing, so
        // the account cannot end up connected beside a credential nobody can read.
        await restoreChannelCredential(tx, cipher, {
          workspaceId: scope.workspaceId,
          credentialId: existingCredentialId,
          purpose: input.purpose,
          token: input.token,
          expiresAt: input.expiresAt,
          restoredAt: input.now,
        });
        const account = await connectChannelAccount(tx, context, {
          channel: input.channel,
          externalAccountId: input.externalAccountId,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          capabilities: input.capabilities,
          credentialId: existingCredentialId,
        });
        return { channelAccountId: account.id };
      });
    },

    async setAccountStatus(context, channelAccountId, status) {
      await setChannelAccountStatus(db, context, channelAccountId, status);
    },

    async disconnectAccount(context, channelAccountId, now) {
      const scope = profileScopeOf(context);
      await db.$transaction(async (tx) => {
        // The status write carries the authorization check, so it runs first and a caller without the
        // role reaches nothing. Both statements then commit together or neither does.
        await setChannelAccountStatus(tx, context, channelAccountId, "DISCONNECTED");
        const account = await tx.channelAccount.findUnique({
          where: { workspaceId_businessProfileId_id: { ...scope, id: channelAccountId } },
          select: { credential: { select: { id: true, purpose: true } } },
        });
        const credential = account?.credential;
        if (credential !== null && credential !== undefined) {
          // The purpose comes from the row rather than from a caller's constant: it is bound into the
          // tombstone's authenticated data, and a mismatched one would write an unreadable record.
          await revokeChannelCredential(tx, cipher, {
            workspaceId: scope.workspaceId,
            credentialId: credential.id,
            // The column is the same closed set as `CredentialPurpose`; the cast is the Prisma enum
            // crossing back into our own type, not a widening of it.
            purpose: credential.purpose as CredentialPurpose,
            now,
          });
        }
        // In the same transaction as the status change and the credential tombstone: a disconnection
        // nobody appears to have made is the one question this record exists to answer.
        await recordAuditEvent(tx, context, {
          kind: "CHANNEL_DISCONNECTED",
          summary: "Disconnected a channel account",
          subjectType: "channel_accounts",
          subjectId: channelAccountId,
          actorUserId: context.userId,
          channelAccountId,
          detail: { credentialRevoked: credential !== null && credential !== undefined },
          occurredAt: now,
        });
      });
    },

    readCredential: async (context, input) =>
      readChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, credentialId: input.credentialId, purpose: input.purpose }),

    rotateCredential: async (context, input) => rotateChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input }),

    revokeCredential: async (context, input) => revokeChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input }),
  };
}
