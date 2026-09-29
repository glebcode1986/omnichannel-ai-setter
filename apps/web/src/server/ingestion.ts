import type { IngestionDependencies } from "@omnichannel/application";
import { createIngestionStore } from "@omnichannel/db";

import { getChannelAdapters } from "./channel-adapters";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { getQueueProducer } from "./queue";

let dependencies: IngestionDependencies | undefined;

/** Production composition of the webhook ingestion use case. */
export function getIngestionDependencies(): IngestionDependencies {
  dependencies ??= {
    store: createIngestionStore(getDb()),
    adapters: getChannelAdapters(),
    scheduler: getQueueProducer(),
    log: getLogger(),
    now: () => new Date(),
    random: Math.random,
  };
  return dependencies;
}
