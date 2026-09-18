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
  rotateChannelCredential,
  writeChannelCredential,
  type StoredCredential,
} from "./repositories/channel-credentials";
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

  readCredential(
    context: BusinessProfileContext,
    input: { readonly credentialId: string; readonly purpose: CredentialPurpose },
  ): Promise<StoredCredential | undefined>;
  rotateCredential(
    context: BusinessProfileContext,
    input: {
      readonly credentialId: string;
      readonly purpose: CredentialPurpose;
      readonly token: string;
      readonly expiresAt: Date;
      readonly refreshedAt: Date;
    },
  ): Promise<void>;
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
        await rotateChannelCredential(tx, cipher, {
          workspaceId: scope.workspaceId,
          credentialId: existingCredentialId,
          purpose: input.purpose,
          token: input.token,
          expiresAt: input.expiresAt,
          refreshedAt: input.now,
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

    readCredential: async (context, input) =>
      readChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, credentialId: input.credentialId, purpose: input.purpose }),

    rotateCredential: async (context, input) => rotateChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input }),

    revokeCredential: async (context, input) => revokeChannelCredential(db, cipher, { workspaceId: profileScopeOf(context).workspaceId, ...input }),
  };
}
