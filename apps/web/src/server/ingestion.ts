import type { IngestionDependencies } from "@omnichannel/application";
import { createIngestionStore } from "@omnichannel/db";

import { channelAdapters } from "./channel-adapters";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { getQueueProducer } from "./queue";

let dependencies: IngestionDependencies | undefined;

/** Production composition of the webhook ingestion use case. */
export function getIngestionDependencies(): IngestionDependencies {
  dependencies ??= {
    store: createIngestionStore(getDb()),
    adapters: channelAdapters,
    scheduler: getQueueProducer(),
    log: getLogger(),
    now: () => new Date(),
    random: Math.random,
  };
  return dependencies;
}
