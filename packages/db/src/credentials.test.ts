import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createCredentialCipher, CredentialCryptoError, type CredentialScope, type EncryptedCredential } from "./credentials";

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const TOKEN = "IGQVJlong-lived-token-value";

const cipher = () => createCredentialCipher({ keyId: "k2", keys: { k1: KEY_A, k2: KEY_B } });

const scope: CredentialScope = { workspaceId: "ws_1", credentialId: "cred_1", purpose: "INSTAGRAM_ACCESS_TOKEN" };

describe("credential cipher", () => {
  it("round-trips a token and never stores it in the clear", () => {
    const stored = cipher().encrypt(scope, TOKEN);

    expect(cipher().decrypt(scope, stored)).toBe(TOKEN);
    expect(stored).toMatchObject({ keyId: "k2", algorithm: "aes-256-gcm" });
    expect(Buffer.from(stored.ciphertext).toString("utf8")).not.toContain(TOKEN);
    expect(Buffer.from(stored.ciphertext).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    // A fresh nonce each time, so identical tokens do not produce identical rows.
    expect(Buffer.from(cipher().encrypt(scope, TOKEN).ciphertext).equals(Buffer.from(stored.ciphertext))).toBe(false);
  });

  it("refuses a ciphertext moved to another workspace, credential or purpose", () => {
    const stored = cipher().encrypt(scope, TOKEN);

    for (const wrong of [
      { ...scope, workspaceId: "ws_other" },
      { ...scope, credentialId: "cred_other" },
      { ...scope, purpose: "SOMETHING_ELSE" as CredentialScope["purpose"] },
    ]) {
      expect(() => cipher().decrypt(wrong, stored)).toThrow(CredentialCryptoError);
    }
  });

  it("fails closed on tampering, a downgraded algorithm, a missing tag or an unknown key", () => {
    const stored = cipher().encrypt(scope, TOKEN);
    const flip = (bytes: Uint8Array) => {
      const copy = Buffer.from(bytes);
      copy[0] = (copy[0] ?? 0) ^ 0x01;
      return copy;
    };
    const variants: EncryptedCredential[] = [
      { ...stored, ciphertext: flip(stored.ciphertext) },
      { ...stored, authTag: flip(stored.authTag) },
      { ...stored, nonce: flip(stored.nonce) },
      { ...stored, authTag: new Uint8Array(0) },
      { ...stored, algorithm: "aes-256-cbc" },
      { ...stored, keyId: "k-unknown" },
    ];

    for (const variant of variants) {
      expect(() => cipher().decrypt(scope, variant)).toThrow(CredentialCryptoError);
    }
    // Every failure looks the same from outside.
    expect(new CredentialCryptoError().message).toBe("credential could not be decrypted");
  });

  it("keeps older keys readable so a key can be rotated without re-encrypting everything", () => {
    const old = createCredentialCipher({ keyId: "k1", keys: { k1: KEY_A } }).encrypt(scope, TOKEN);

    expect(cipher().decrypt(scope, old)).toBe(TOKEN);
    expect(cipher().encrypt(scope, TOKEN).keyId).toBe("k2");
    // A retired key that is no longer supplied can no longer be read, which is the point of retiring it.
    expect(() => createCredentialCipher({ keyId: "k2", keys: { k2: KEY_B } }).decrypt(scope, old)).toThrow(CredentialCryptoError);
  });

  it("refuses to start with a wrong-sized key or without its current key", () => {
    expect(() => createCredentialCipher({ keyId: "k1", keys: { k1: randomBytes(16) } })).toThrow(/32 bytes/);
    expect(() => createCredentialCipher({ keyId: "missing", keys: { k1: KEY_A } })).toThrow(/current key id/);
  });
});
