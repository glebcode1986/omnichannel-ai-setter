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
import type { WhatsAppHttpPort } from "@omnichannel/channel-whatsapp";
import type { Logger } from "@omnichannel/observability";

import { createChannelStateResolver } from "./delivery-policy";
import type { WorkerEnv } from "./env";
import { createInstagramDeliverySender } from "./instagram-sender";
import { createWhatsAppDeliverySender } from "./whatsapp-sender";

/** Only the configuration delivery actually reads; the worker's full env is assignable to it. */
export type DeliveryEnv = Pick<
  WorkerEnv,
  | "INSTAGRAM_APP_SECRET"
  | "INSTAGRAM_VERIFY_TOKEN"
  | "CHANNEL_CREDENTIAL_KEY_ID"
  | "CHANNEL_CREDENTIAL_KEY"
  | "INSTAGRAM_HUMAN_AGENT_APPROVAL"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_VERIFY_TOKEN"
>;

export interface DeliveryEngineOverrides {
  /** Injectable so a test can compose the real engine and still read what went on the wire. */
  readonly http?: InstagramHttpPort;
  readonly whatsappHttp?: WhatsAppHttpPort;
  readonly now?: () => Date;
}

/**
 * Without Meta app credentials there is no adapter, and delivery refuses with a named reason rather than
 * pretending: a rejection that says why is safe, and an accepted send that never happened would not be.
 */
function createSender(env: DeliveryEnv, db: DbClient, logger: Logger, now: () => Date, overrides: DeliveryEngineOverrides = {}): DeliverySendPort {
  const { CHANNEL_CREDENTIAL_KEY_ID: cipherKeyId, CHANNEL_CREDENTIAL_KEY: cipherKey } = env;
  if (cipherKeyId === undefined || cipherKey === undefined) {
    // Without the credential key no stored token can be decrypted, so no channel can send at all.
    logger.warn("worker.no_channel_adapter", { reason: "credential-encryption configuration is missing" });
    return { send: () => Promise.resolve(NO_ADAPTER) };
  }
  const cipher = createCredentialCipher({ keyId: cipherKeyId, keys: { [cipherKeyId]: Buffer.from(cipherKey, "base64") } });

  const senders = new Map<string, DeliverySendPort>();
  if (env.INSTAGRAM_APP_SECRET !== undefined && env.INSTAGRAM_VERIFY_TOKEN !== undefined) {
    senders.set(
      "INSTAGRAM",
      createInstagramDeliverySender({
        db,
        cipher,
        appSecret: env.INSTAGRAM_APP_SECRET,
        verifyToken: env.INSTAGRAM_VERIFY_TOKEN,
        humanAgentApproval: env.INSTAGRAM_HUMAN_AGENT_APPROVAL,
        now,
        ...(overrides.http === undefined ? {} : { http: overrides.http }),
        logger,
      }),
    );
  } else {
    logger.warn("worker.no_channel_adapter", { reason: "instagram app configuration is missing" });
  }
  if (env.WHATSAPP_APP_SECRET !== undefined && env.WHATSAPP_VERIFY_TOKEN !== undefined) {
    senders.set(
      "WHATSAPP",
      createWhatsAppDeliverySender({
        db,
        cipher,
        appSecret: env.WHATSAPP_APP_SECRET,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        ...(overrides.whatsappHttp === undefined ? {} : { http: overrides.whatsappHttp }),
        logger,
      }),
    );
  } else {
    logger.warn("worker.no_channel_adapter", { reason: "whatsapp app configuration is missing" });
  }

  return {
    async send(command) {
      // The channel comes from the account the delivery names, read here rather than carried on the
      // command: which transport a reply leaves on is a fact about the account, and a command that could
      // state it would be a command that could state the wrong one.
      const account = await db.channelAccount.findFirst({ where: { id: command.channelAccountId }, select: { channel: true } });
      const sender = account === null ? undefined : senders.get(account.channel);
      if (sender === undefined) {
        return NO_ADAPTER;
      }
      return sender.send(command);
    },
  };
}

/**
 * Refusing with a reason rather than pretending.
 *
 * A rejection that says why is safe — the delivery is held and a person sees it — where an accepted send
 * that never happened would not be. Not retryable: no amount of waiting configures a deployment.
 */
const NO_ADAPTER = {
  outcome: "REJECTED",
  retryable: false,
  code: "NO_ADAPTER",
  message: "no channel adapter is configured for delivery",
} as const satisfies Awaited<ReturnType<DeliverySendPort["send"]>>;

/**
 * The channels this deployment can actually put a reply on.
 *
 * Derived from the same configuration `createSender` reads, and exported so that nothing else has to guess
 * it. Presence is the caller that needs it: announcing that somebody is typing a reply this process will
 * refuse to send is the one presence failure a customer actually notices, and the only component able to
 * answer "can we send on this channel at all" is the one that builds the sender.
 *
 * Both channels are here since P4-07 wired WhatsApp's transport, and presence followed without another
 * decision being made anywhere else — which is what this function existing is for.
 */
export function deliverableChannels(env: DeliveryEnv): ReadonlySet<string> {
  if (env.CHANNEL_CREDENTIAL_KEY_ID === undefined || env.CHANNEL_CREDENTIAL_KEY === undefined) {
    return new Set();
  }
  const channels = new Set<string>();
  if (env.INSTAGRAM_APP_SECRET !== undefined && env.INSTAGRAM_VERIFY_TOKEN !== undefined) {
    channels.add("INSTAGRAM");
  }
  if (env.WHATSAPP_APP_SECRET !== undefined && env.WHATSAPP_VERIFY_TOKEN !== undefined) {
    channels.add("WHATSAPP");
  }
  return channels;
}

export function createDeliveryEngine(env: DeliveryEnv, db: DbClient, logger: Logger, overrides: DeliveryEngineOverrides = {}) {
  const now = overrides.now ?? ((): Date => new Date());
  return {
    store: createDeliveryStore(db),
    sender: createSender(env, db, logger, now, overrides),
    // The same live answer the transport above is given. Two gates that could disagree about whether the
    // exception exists is the bug this function exists to make impossible.
    channel: createChannelStateResolver(now, env.INSTAGRAM_HUMAN_AGENT_APPROVAL),
    log: logger,
    now,
  };
}
