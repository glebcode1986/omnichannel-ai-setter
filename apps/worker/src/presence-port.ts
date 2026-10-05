/**
 * The presence announcer this deployment has, or none (#22, P4-05).
 *
 * The same shape as `media-port.ts` and for the same reason: `main.ts` starts a worker on import, and what
 * a deployment does when it is missing a key is worth a test of its own.
 *
 * Without the credential-encryption key no stored access token can be decrypted, so nothing can be
 * announced. Returning `undefined` rather than an announcer that always fails is deliberate — the handler
 * declines by name, and the scheduler can be told not to queue the work at all.
 */
import { createCredentialCipher, type DbClient } from "@omnichannel/db";
import type { PresenceAnnouncer } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";

import type { WorkerEnv } from "./env";
import { createWhatsAppPresenceAnnouncer } from "./whatsapp-presence";

/** Only the configuration presence reads; the worker's full env is assignable to it. */
export type PresenceEnv = Pick<WorkerEnv, "CHANNEL_CREDENTIAL_KEY_ID" | "CHANNEL_CREDENTIAL_KEY" | "WHATSAPP_GRAPH_VERSION">;

export function createPresenceAnnouncer(env: PresenceEnv, db: DbClient, logger: Logger): PresenceAnnouncer | undefined {
  if (env.CHANNEL_CREDENTIAL_KEY_ID === undefined || env.CHANNEL_CREDENTIAL_KEY === undefined) {
    return undefined;
  }
  return createWhatsAppPresenceAnnouncer({
    db,
    cipher: createCredentialCipher({ keyId: env.CHANNEL_CREDENTIAL_KEY_ID, keys: { [env.CHANNEL_CREDENTIAL_KEY_ID]: Buffer.from(env.CHANNEL_CREDENTIAL_KEY, "base64") } }),
    graphVersion: env.WHATSAPP_GRAPH_VERSION,
    logger,
  });
}
