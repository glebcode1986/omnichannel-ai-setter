/**
 * Envelope encryption for provider credentials.
 *
 * Tokens are stored as AES-256-GCM ciphertext with the key held outside the database, so a database dump is
 * not a set of working credentials. Three decisions matter for review:
 *
 * - the algorithm is a pinned literal that is *compared* to the stored value, never taken from the row: a
 *   row that names a weaker algorithm is rejected rather than honoured;
 * - the additional authenticated data binds each ciphertext to its Workspace, its credential row and its
 *   purpose, so a ciphertext copied into another tenant's row fails to decrypt instead of working;
 * - every failure is the same opaque error, and no failure path includes plaintext, key material or the
 *   provider's own message.
 *
 * Key rotation is by key ID: new writes use the current key, and older keys stay available for reads only.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** The only algorithm this codebase writes or accepts. */
export const CREDENTIAL_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AAD_VERSION = "v1";

/** Never widened casually: each purpose is bound into the ciphertext and cannot be reinterpreted later. */
export type CredentialPurpose = "INSTAGRAM_ACCESS_TOKEN";

export interface CredentialScope {
  readonly workspaceId: string;
  readonly credentialId: string;
  readonly purpose: CredentialPurpose;
}

/** Exactly the columns of `channel_credentials` that carry the encrypted value. */
export interface EncryptedCredential {
  readonly keyId: string;
  readonly algorithm: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
}

export class CredentialCryptoError extends Error {
  constructor() {
    // One message for every failure: which check failed is not something a caller should learn.
    super("credential could not be decrypted");
    this.name = "CredentialCryptoError";
  }
}

export interface CredentialCipher {
  readonly keyId: string;
  encrypt(scope: CredentialScope, plaintext: string): EncryptedCredential;
  decrypt(scope: CredentialScope, stored: EncryptedCredential): string;
}

export interface CredentialCipherOptions {
  /** Identifier of the key used for new writes; stored with each row so rotation stays readable. */
  readonly keyId: string;
  /** 32-byte keys by key ID, including the current one and any still needed for decryption. */
  readonly keys: Readonly<Record<string, Uint8Array>>;
}

export function createCredentialCipher(options: CredentialCipherOptions): CredentialCipher {
  const keys = new Map<string, Buffer>();
  for (const [keyId, key] of Object.entries(options.keys)) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`credential key ${keyId} must be ${String(KEY_BYTES)} bytes`);
    }
    keys.set(keyId, Buffer.from(key));
  }
  const current = keys.get(options.keyId);
  if (current === undefined) {
    throw new Error("credential key set does not contain the current key id");
  }

  return {
    keyId: options.keyId,

    encrypt(scope, plaintext) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(CREDENTIAL_ALGORITHM, current, nonce, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(additionalData(scope, options.keyId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { keyId: options.keyId, algorithm: CREDENTIAL_ALGORITHM, ciphertext, nonce, authTag: cipher.getAuthTag() };
    },

    decrypt(scope, stored) {
      // An attacker who can write the row must not be able to pick the algorithm or skip authentication.
      if (!constantTimeEquals(stored.algorithm, CREDENTIAL_ALGORITHM)) {
        throw new CredentialCryptoError();
      }
      const key = keys.get(stored.keyId);
      if (key === undefined || stored.nonce.length !== NONCE_BYTES || stored.authTag.length !== AUTH_TAG_BYTES) {
        throw new CredentialCryptoError();
      }
      try {
        const decipher = createDecipheriv(CREDENTIAL_ALGORITHM, key, stored.nonce, { authTagLength: AUTH_TAG_BYTES });
        decipher.setAAD(additionalData(scope, stored.keyId));
        decipher.setAuthTag(stored.authTag);
        return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Includes the authentication failure a tampered ciphertext, nonce, tag or scope produces.
        throw new CredentialCryptoError();
      }
    },
  };
}

/**
 * Binds the ciphertext to where it lives. The parts are NUL-joined, which is unambiguous because identifiers
 * may not contain control characters.
 */
function additionalData(scope: CredentialScope, keyId: string): Buffer {
  return Buffer.from([AAD_VERSION, scope.workspaceId, scope.credentialId, scope.purpose, keyId, CREDENTIAL_ALGORITHM].join("\0"), "utf8");
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
