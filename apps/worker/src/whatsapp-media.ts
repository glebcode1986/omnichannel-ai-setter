/**
 * Fetching and deleting a WhatsApp customer's media, as the transcription handler needs it (Issue #21).
 *
 * The handler knows nothing about Graph URLs and the adapter knows nothing about transcripts; this module
 * is the only place the two meet. Everything the provider calls need — the phone number, the messaging
 * account, the access token, the connection's own state — is read **per fetch**, because a transcription
 * job may have been queued minutes ago and none of those are facts about the past: a number disconnected
 * since, or a credential revoked since, must fail this fetch rather than the one after a cache expires.
 *
 * Failures are translated into the handler's own vocabulary, and the translation carries the one judgement
 * that matters: whether asking again could produce a different answer. An expired download URL is
 * retryable and the provider documents re-resolving it; an unsupported type never will be. Getting that
 * backwards either spends a queue's attempts on an answer that cannot change, or gives up on a recording
 * because the network blinked.
 */
import {
  deleteMedia,
  downloadMedia,
  mediaIdUsable,
  resolveConfig,
  resolveMediaUrl,
  createFetchHttpPort,
  type MediaFailureReason,
  type WhatsAppHttpPort,
} from "@omnichannel/channel-whatsapp";
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import type { MediaFetchPort, MediaFetchResult } from "./transcription-handler";

export interface WhatsAppMediaConfig {
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly graphVersion: string;
  readonly http?: WhatsAppHttpPort;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Largest recording this deployment will download, on top of the platform's own per-type limits. */
  readonly maxBytes?: number;
}

/**
 * How each provider failure is answered.
 *
 * `retryable` means the queue should try again; `permanent` means the row is terminal and the review item
 * is the final answer. They are not opposites: a credential that was refused is neither — worth another
 * attempt once somebody reconnects, but not something this job can wait out.
 */
interface FailureJudgement {
  readonly retryable: boolean;
  readonly permanent: boolean;
}

const FAILURES: Readonly<Record<MediaFailureReason, FailureJudgement>> = {
  // Neither: a reconnect makes the same fetch valid, but no amount of retrying this job brings one about.
  ACCOUNT_NOT_CONNECTED: { retryable: false, permanent: false },
  // The provider will never read it, however many times it is asked.
  UNSUPPORTED_TYPE: { retryable: false, permanent: true },
  TOO_LARGE: { retryable: false, permanent: true },
  MIME_MISMATCH: { retryable: false, permanent: true },
  // Documented remedy: resolve the media ID again for a fresh URL. Worth exactly that.
  EXPIRED: { retryable: true, permanent: false },
  // The recording is gone from the provider's side — after seven days it always is.
  NOT_FOUND: { retryable: false, permanent: true },
  PROVIDER_REJECTED: { retryable: false, permanent: false },
  UNAVAILABLE: { retryable: true, permanent: false },
  NO_CREDENTIALS: { retryable: false, permanent: false },
  INVALID_RESPONSE: { retryable: true, permanent: false },
};

export function createWhatsAppMediaPort(config: WhatsAppMediaConfig): MediaFetchPort {
  const http = config.http ?? createFetchHttpPort();

  /** Everything the provider calls are bound to, read at the moment of the call. */
  const bind = async (input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly channelAccountId: string;
  }): Promise<ReturnType<typeof resolveConfig> | undefined> => {
    const account = await config.db.channelAccount.findFirst({
      where: { id: input.channelAccountId, workspaceId: input.workspaceId, channel: "WHATSAPP" },
      select: { id: true, workspaceId: true, businessProfileId: true, status: true, externalAccountId: true, whatsappConnection: { select: { wabaId: true } } },
    });
    const wabaId = account?.whatsappConnection?.wabaId;
    if (account === null || account === undefined || wabaId === undefined) {
      return undefined;
    }
    return resolveConfig({
      binding: {
        workspaceId: account.workspaceId,
        businessProfileId: account.businessProfileId,
        channelAccountId: account.id,
        phoneNumberId: account.externalAccountId,
        wabaId,
      },
      secrets: {
        // Neither is used on this path and neither is asked for: a media call carries a bearer token and
        // no signature, and it answers no subscription handshake. Requiring an app secret here would make
        // reading a voice note depend on configuration that has nothing to do with it.
        appSecret: "",
        verifyToken: "",
        accessToken: async () => currentAccessToken(config, account.workspaceId, account.id),
      },
      http,
      graphVersion: config.graphVersion,
      // Carried through rather than assumed: a disconnected number's media is not ours to fetch, and the
      // adapter refuses it on this value rather than on our say-so.
      connectionState: account.status === "DISCONNECTED" ? "DISCONNECTED" : account.status === "NEEDS_REAUTH" ? "NEEDS_REAUTH" : "CONNECTED",
      logger: config.logger,
    });
  };

  return {
    async fetch(input): Promise<MediaFetchResult> {
      const bound = await bind(input);
      if (bound === undefined) {
        // No account, no WhatsApp connection, or no messaging account recorded. Nothing to retry against.
        return { ok: false, reason: "NO_BINDING", retryable: false, permanent: true };
      }
      const located = await resolveMediaUrl(bound, input.providerMediaId);
      if (!located.ok) {
        const judgement = judgementFor(located.reason);
        return {
          ok: false,
          reason: located.reason,
          retryable: judgement.retryable,
          permanent: judgement.permanent,
          ...(located.code === undefined ? {} : { code: located.code }),
        };
      }
      const downloaded = await downloadMedia(bound, located.value, config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes });
      if (!downloaded.ok) {
        const judgement = judgementFor(downloaded.reason);
        return {
          ok: false,
          reason: downloaded.reason,
          retryable: judgement.retryable,
          permanent: judgement.permanent,
          ...(downloaded.code === undefined ? {} : { code: downloaded.code }),
        };
      }
      return { ok: true, bytes: downloaded.value.bytes, mimeType: downloaded.value.mimeType, sizeBytes: downloaded.value.sizeBytes };
    },

    async delete(input): Promise<boolean> {
      const bound = await bind(input);
      if (bound === undefined) {
        return false;
      }
      const result = await deleteMedia(bound, input.providerMediaId);
      if (!result.ok) {
        // Best effort by contract: the retention record is only written when the provider agreed, so a
        // failure here leaves the row saying the recording is still theirs — which is the truth.
        config.logger.warn("worker.whatsapp_media_delete_failed", {
          workspaceId: input.workspaceId,
          channelAccountId: input.channelAccountId,
          reason: result.reason,
          ...(result.code === undefined ? {} : { code: result.code }),
        });
      }
      return result.ok;
    },
  };
}

/**
 * Whether a media ID from a webhook is still worth asking the provider for.
 *
 * Re-exported through this module so the handler can refuse a hopeless fetch without importing the
 * channel package: after seven days the provider has forgotten the recording, and a job that keeps
 * retrying past that is spending attempts on a 404.
 */
export { mediaIdUsable };

/**
 * The judgement for one provider failure.
 *
 * The table covers the whole union, so the fallback is unreachable today — and it is a fallback rather
 * than a cast because the alternative is worse: a reason added to the adapter later would otherwise be
 * read as `undefined` and crash the handler, where this makes it a non-retryable failure with a review
 * item, which is the safe reading of a failure nobody has classified yet.
 */
function judgementFor(reason: MediaFailureReason): FailureJudgement {
  return FAILURES[reason] ?? { retryable: false, permanent: false };
}

async function currentAccessToken(config: WhatsAppMediaConfig, workspaceId: string, channelAccountId: string): Promise<string | undefined> {
  // Through the relation, because that is the direction the link runs: the account names its credential,
  // and `channel_credentials` has no account column.
  const credential = await config.db.channelCredential.findFirst({
    where: { workspaceId, purpose: "WHATSAPP_BUSINESS_TOKEN", revokedAt: null, channelAccount: { id: channelAccountId } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (credential === null) {
    return undefined;
  }
  const stored = await readChannelCredential(config.db, config.cipher, { workspaceId, credentialId: credential.id, purpose: "WHATSAPP_BUSINESS_TOKEN" });
  return stored?.token;
}
