import type { IngestionDependencies } from "@omnichannel/application";
import { createIngestionStore } from "@omnichannel/db";

import { getChannelAdapters } from "./channel-adapters";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { getQueueProducer } from "./queue";
import { createWhatsAppAccountEventPort } from "./whatsapp-account-events";

let dependencies: IngestionDependencies | undefined;

/** Production composition of the webhook ingestion use case. */
export function getIngestionDependencies(): IngestionDependencies {
  dependencies ??= {
    store: createIngestionStore(getDb()),
    adapters: getChannelAdapters(),
    scheduler: getQueueProducer(),
    // The same producer: a reading job is just another family on the same queue (Issue #21).
    transcription: getQueueProducer(),
    // And again for a send (Issue #125). An inbound webhook writes no delivery entry, so this is here to
    // satisfy one dispatcher rather than two: the mechanism that carries a committed reply to the queue
    // must be whole wherever it is composed, because half of it is what made an approved reply vanish.
    delivery: getQueueProducer(),
    log: getLogger(),
    now: () => new Date(),
    random: Math.random,
    // WhatsApp delivers template status changes on the same endpoint as messages, and they are not
    // conversation events. Applied here so a cached `APPROVED` cannot outlive the approval (Issue #20).
    accountEvents: createWhatsAppAccountEventPort({ db: getDb, logger: getLogger, now: () => new Date() }),
  };
  return dependencies;
}
