/**
 * How a delivery is assembled from configuration (#16, ADR-014).
 *
 * This lives apart from `main.ts` because `main.ts` starts a worker on import, and the assembly is worth
 * testing on its own. Whether Meta has approved *this app* for the Human Agent exception reaches two
 * independent places from here — the gate that decides whether the exception exists at all, and the
 * transport that dispatches under it — and each of them is correct in isolation while a deployment that
 * told only one of them is broken in a way neither component's own tests can see. That was the actual
 * defect: the gate was hard-coded to `UNKNOWN`, so the transport below it could never be chosen, no
 * matter what a person had authorized.
 *
 * One value, read once, handed to both.
 */
import type { DeliverySendPort } from "@omnichannel/application";
import { createDeliveryStore, createCredentialCipher, type DbClient } from "@omnichannel/db";
import type { InstagramHttpPort } from "@omnichannel/channel-instagram";
import type { Logger } from "@omnichannel/observability";

import { createChannelStateResolver } from "./delivery-policy";
import type { WorkerEnv } from "./env";
import { createInstagramDeliverySender } from "./instagram-sender";

/** Only the configuration delivery actually reads; the worker's full env is assignable to it. */
export type DeliveryEnv = Pick<
  WorkerEnv,
  "INSTAGRAM_APP_SECRET" | "INSTAGRAM_VERIFY_TOKEN" | "CHANNEL_CREDENTIAL_KEY_ID" | "CHANNEL_CREDENTIAL_KEY" | "INSTAGRAM_HUMAN_AGENT_APPROVAL"
>;

export interface DeliveryEngineOverrides {
  /** Injectable so a test can compose the real engine and still read what went on the wire. */
  readonly http?: InstagramHttpPort;
  readonly now?: () => Date;
}

/**
 * Without Meta app credentials there is no adapter, and delivery refuses with a named reason rather than
 * pretending: a rejection that says why is safe, and an accepted send that never happened would not be.
 */
function createSender(env: DeliveryEnv, db: DbClient, logger: Logger, now: () => Date, http?: InstagramHttpPort): DeliverySendPort {
  if (env.INSTAGRAM_APP_SECRET === undefined || env.INSTAGRAM_VERIFY_TOKEN === undefined || env.CHANNEL_CREDENTIAL_KEY_ID === undefined || env.CHANNEL_CREDENTIAL_KEY === undefined) {
    logger.warn("worker.no_channel_adapter", { reason: "instagram app or credential-encryption configuration is missing" });
    return {
      send: () => Promise.resolve({ outcome: "REJECTED", retryable: false, code: "NO_ADAPTER", message: "no channel adapter is configured for delivery" }),
    };
  }
  return createInstagramDeliverySender({
    db,
    cipher: createCredentialCipher({ keyId: env.CHANNEL_CREDENTIAL_KEY_ID, keys: { [env.CHANNEL_CREDENTIAL_KEY_ID]: Buffer.from(env.CHANNEL_CREDENTIAL_KEY, "base64") } }),
    appSecret: env.INSTAGRAM_APP_SECRET,
    verifyToken: env.INSTAGRAM_VERIFY_TOKEN,
    humanAgentApproval: env.INSTAGRAM_HUMAN_AGENT_APPROVAL,
    now,
    ...(http === undefined ? {} : { http }),
    logger,
  });
}

export function createDeliveryEngine(env: DeliveryEnv, db: DbClient, logger: Logger, overrides: DeliveryEngineOverrides = {}) {
  const now = overrides.now ?? ((): Date => new Date());
  return {
    store: createDeliveryStore(db),
    sender: createSender(env, db, logger, now, overrides.http),
    // The same live answer the transport above is given. Two gates that could disagree about whether the
    // exception exists is the bug this function exists to make impossible.
    channel: createChannelStateResolver(now, env.INSTAGRAM_HUMAN_AGENT_APPROVAL),
    log: logger,
    now,
  };
}
