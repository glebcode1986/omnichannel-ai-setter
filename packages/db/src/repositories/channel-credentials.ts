/**
 * Encrypted provider credentials. Plaintext exists only in memory: callers hand a token in and get one back,
 * and nothing here logs, returns or throws the secret. Reads are a *system* flow — webhook ingestion and the
 * token refresher have no user session — so they take an explicit Workspace scope instead of a context.
 */
import { randomUUID } from "node:crypto";

import type { DbExecutor } from "../client";
import type { CredentialCipher, CredentialPurpose } from "../credentials";
import { TenantRecordNotFoundError } from "../errors";

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
 *
 * A revoked credential is never rotated. Revocation is how a disconnect destroys a secret, and a write
 * that cleared it would hand back a working token for an account somebody had just disconnected.
 */
/**
 * Whether the rotation applied. `SUPERSEDED` means the credential this rotation was computed from is no
 * longer the one in the database — destroyed by a disconnect, or replaced by a reconnect — so there is
 * nothing to rotate and nothing was written.
 */
export type CredentialRotation = "ROTATED" | "SUPERSEDED";

export async function rotateChannelCredential(
  db: DbExecutor,
  cipher: CredentialCipher,
  input: NewCredential & {
    readonly credentialId: string;
    readonly refreshedAt: Date;
    /** The mint time this rotation was computed from; the write applies only if it is still current. */
    readonly mintedAt?: Date;
  },
): Promise<CredentialRotation> {
  const encrypted = cipher.encrypt(
    { workspaceId: input.workspaceId, credentialId: input.credentialId, purpose: input.purpose },
    input.token,
  );
  // Conditional on the credential being exactly the one that was read, in the database rather than in a
  // prior read. A refresh calls the provider and comes back seconds later, and two things can land in
  // that gap: a disconnect, which revoked it — an unconditional write would put a usable token back and
  // clear the revocation that destroyed it — or a reconnect, which re-authorized it with a newer token
  // that this stale refresh must not overwrite. Matching the mint time covers both, and the row count is
  // the answer, so nobody else has to be asked.
  const rotated = await db.channelCredential.updateMany({
    where: {
      workspaceId: input.workspaceId,
      id: input.credentialId,
      revokedAt: null,
      ...(input.mintedAt === undefined ? {} : { OR: [{ refreshedAt: input.mintedAt }, { refreshedAt: null, createdAt: input.mintedAt }] }),
    },
    data: {
      purpose: input.purpose,
      keyId: encrypted.keyId,
      algorithm: encrypted.algorithm,
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.authTag),
      expiresAt: input.expiresAt,
      refreshedAt: input.refreshedAt,
    },
  });
  return rotated.count === 1 ? "ROTATED" : "SUPERSEDED";
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

/**
 * Puts a freshly authorized secret back on an existing credential row, revoked or not.
 *
 * This is the one place a revocation is deliberately cleared, and the distinction from a rotation is the
 * whole reason it is separate. A rotation continues a connection that already exists, so it must never
 * revive what a disconnect destroyed. A restoration happens because a person just re-authorized the
 * account and the provider issued a new token: reviving the row is the intent, the old ciphertext is
 * overwritten in the same statement, and the caller runs it inside the transaction that marks the
 * account connected.
 *
 * It throws when it matches nothing, so a reconnect that cannot restore the credential commits neither
 * half — an account marked connected while its secret stays unreadable is the state this exists to make
 * impossible.
 */
export async function restoreChannelCredential(
  db: DbExecutor,
  cipher: CredentialCipher,
  input: NewCredential & { readonly credentialId: string; readonly restoredAt: Date },
): Promise<void> {
  const encrypted = cipher.encrypt(
    { workspaceId: input.workspaceId, credentialId: input.credentialId, purpose: input.purpose },
    input.token,
  );
  const restored = await db.channelCredential.updateMany({
    where: { workspaceId: input.workspaceId, id: input.credentialId },
    data: {
      purpose: input.purpose,
      keyId: encrypted.keyId,
      algorithm: encrypted.algorithm,
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.authTag),
      expiresAt: input.expiresAt,
      refreshedAt: input.restoredAt,
      revokedAt: null,
    },
  });
  if (restored.count !== 1) {
    throw new TenantRecordNotFoundError("ChannelCredential");
  }
}
