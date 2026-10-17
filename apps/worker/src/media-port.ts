/**
 * How a recording is fetched from configuration (#21).
 *
 * This lives apart from `main.ts` for the same reason `delivery-engine.ts` does: `main.ts` starts a worker
 * on import, and what happens when the deployment is missing a key is worth a test of its own.
 *
 * Without the credential-encryption key there is no way to read a stored access token, and therefore no way
 * to fetch a recording. Refusing with a named reason is safe — the transcript row records it, the draft is
 * marked for review and a person reads the voice note — where pretending would mean every voice note
 * failing with something that reads like a bug. The same choice `createSender` makes about a missing Meta
 * app.
 */
import { createCredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import type { WorkerEnv } from "./env";
import type { MediaFetchPort } from "./transcription-handler";
import { createWhatsAppMediaPort } from "./whatsapp-media";

/** Only the configuration media reads; the worker's full env is assignable to it. */
export type MediaEnv = Pick<WorkerEnv, "CHANNEL_CREDENTIAL_KEY_ID" | "CHANNEL_CREDENTIAL_KEY" | "WHATSAPP_GRAPH_VERSION" | "MEDIA_MAX_DOWNLOAD_MB">;

export interface MediaPortOverrides {
  readonly now?: () => Date;
}

export function createMediaPort(env: MediaEnv, db: DbClient, logger: Logger, overrides: MediaPortOverrides = {}): MediaFetchPort {
  if (env.CHANNEL_CREDENTIAL_KEY_ID === undefined || env.CHANNEL_CREDENTIAL_KEY === undefined) {
    logger.warn("worker.no_media_port", { reason: "credential-encryption configuration is missing" });
    return {
      // Not retryable and not permanent: the deployment is misconfigured, which is neither a fact about
      // this recording nor something a retry would fix. The transcript stays PENDING and says why.
      fetch: () => Promise.resolve({ ok: false, reason: "NO_CIPHER", retryable: false, permanent: false }),
      delete: () => Promise.resolve(false),
    };
  }
  return createWhatsAppMediaPort({
    db,
    cipher: createCredentialCipher({ keyId: env.CHANNEL_CREDENTIAL_KEY_ID, keys: { [env.CHANNEL_CREDENTIAL_KEY_ID]: Buffer.from(env.CHANNEL_CREDENTIAL_KEY, "base64") } }),
    graphVersion: env.WHATSAPP_GRAPH_VERSION,
    maxBytes: env.MEDIA_MAX_DOWNLOAD_MB * 1024 * 1024,
    logger,
    now: overrides.now ?? ((): Date => new Date()),
  });
}
