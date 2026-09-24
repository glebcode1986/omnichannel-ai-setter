/**
 * Process-wide credential cipher, built once from validated environment. The key lives only here and in the
 * environment: `packages/db` never reads configuration, so the composition root injects it.
 */
import { createCredentialCipher, type CredentialCipher } from "@omnichannel/db";

import { loadWebEnv } from "../env";

let cipher: CredentialCipher | undefined;

export function getCredentialCipher(): CredentialCipher {
  if (cipher === undefined) {
    const env = loadWebEnv();
    cipher = createCredentialCipher({
      keyId: env.CHANNEL_CREDENTIAL_KEY_ID,
      keys: { [env.CHANNEL_CREDENTIAL_KEY_ID]: Buffer.from(env.CHANNEL_CREDENTIAL_KEY, "base64") },
    });
  }
  return cipher;
}
