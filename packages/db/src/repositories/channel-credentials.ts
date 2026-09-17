/**
 * Encrypted provider credentials. Plaintext exists only in memory: callers hand a token in and get one back,
 * and nothing here logs, returns or throws the secret. Reads are a *system* flow — webhook ingestion and the
 * token refresher have no user session — so they take an explicit Workspace scope instead of a context.
 */
import { randomUUID } from "node:crypto";

import type { DbExecutor } from "../client";
import type { CredentialCipher, CredentialPurpose } from "../credentials";

export interface StoredCredential {
  readonly credentialId: string;
  readonly token: string;
  readonly expiresAt: Date | null;
  /** When the current token was minted (refresh time, or creation time if never refreshed). */
  readonly mintedAt: Date;
}

export interface NewCredential {
  readonly workspaceId: string;
  readonly purpose: CredentialPurpose;
  readonly token: string;
  readonly expiresAt: Date;
}

export async function writeChannelCredential(
  db: DbExecutor,
  cipher: CredentialCipher,
  input: NewCredential,
): Promise<{ readonly credentialId: string }> {
  // The row ID is generated here because it is bound into the ciphertext's authenticated data.
  const credentialId = randomUUID();
  const encrypted = cipher.encrypt({ workspaceId: input.workspaceId, credentialId, purpose: input.purpose }, input.token);
  await db.channelCredential.create({
    data: {
      id: credentialId,
      workspaceId: input.workspaceId,
      purpose: input.purpose,
      keyId: encrypted.keyId,
      algorithm: encrypted.algorithm,
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.authTag),
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });
  return { credentialId };
}

/**
 * Replaces the secret in place after a refresh or reconnect. The row keeps its identity, so the channel
 * account's reference and all audit history stay valid, and `refreshedAt` records the new mint time.
 */
export async function rotateChannelCredential(
  db: DbExecutor,
  cipher: CredentialCipher,
  input: NewCredential & { readonly credentialId: string; readonly refreshedAt: Date },
): Promise<void> {
  const encrypted = cipher.encrypt(
    { workspaceId: input.workspaceId, credentialId: input.credentialId, purpose: input.purpose },
    input.token,
  );
  await db.channelCredential.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.credentialId } },
    data: {
      purpose: input.purpose,
      keyId: encrypted.keyId,
      algorithm: encrypted.algorithm,
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.authTag),
      expiresAt: input.expiresAt,
      refreshedAt: input.refreshedAt,
      revokedAt: null,
    },
  });
}

/**
 * Placeholder written over a revoked secret. It is encrypted like any other value so the row stays a valid
 * envelope (the schema refuses an empty ciphertext), and `revokedAt` — not its content — makes it unusable.
 */
const REVOKED_MARKER = "__revoked__";

/** Disconnect: the row survives for audit, the secret does not. */
export async function revokeChannelCredential(
  db: DbExecutor,
  cipher: CredentialCipher,
  input: { readonly workspaceId: string; readonly credentialId: string; readonly purpose: CredentialPurpose; readonly now: Date },
): Promise<void> {
  const tombstone = cipher.encrypt(
    { workspaceId: input.workspaceId, credentialId: input.credentialId, purpose: input.purpose },
    REVOKED_MARKER,
  );
  await db.channelCredential.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.credentialId } },
    data: {
      keyId: tombstone.keyId,
      algorithm: tombstone.algorithm,
      ciphertext: Buffer.from(tombstone.ciphertext),
      nonce: Buffer.from(tombstone.nonce),
      authTag: Buffer.from(tombstone.authTag),
      expiresAt: null,
      revokedAt: input.now,
    },
  });
}

/**
 * Reads and decrypts a credential for a system flow. Returns undefined when the credential is missing or
 * revoked; decryption failure throws `CredentialCryptoError` and never reveals why.
 */
export async function readChannelCredential(
  db: DbExecutor,
  cipher: CredentialCipher,
  input: { readonly workspaceId: string; readonly credentialId: string; readonly purpose: CredentialPurpose },
): Promise<StoredCredential | undefined> {
  const row = await db.channelCredential.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.credentialId } },
    select: {
      id: true,
      purpose: true,
      keyId: true,
      algorithm: true,
      ciphertext: true,
      nonce: true,
      authTag: true,
      expiresAt: true,
      refreshedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  if (row === null || row.revokedAt !== null || row.authTag === null || row.purpose !== input.purpose) {
    return undefined;
  }
  const token = cipher.decrypt(
    { workspaceId: input.workspaceId, credentialId: row.id, purpose: input.purpose },
    { keyId: row.keyId, algorithm: row.algorithm, ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.authTag },
  );
  return { credentialId: row.id, token, expiresAt: row.expiresAt, mintedAt: row.refreshedAt ?? row.createdAt };
}
