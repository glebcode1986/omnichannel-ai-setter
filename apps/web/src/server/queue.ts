import { createQueueProducer, createRedisConnection, type QueueProducer } from "@omnichannel/queue";

import { loadWebEnv } from "../env";
import { getLogger } from "./logger";

let producer: QueueProducer | undefined;

/** Process-wide BullMQ producer, created on first use rather than at import/build time. */
export function getQueueProducer(): QueueProducer {
  if (producer === undefined) {
    const logger = getLogger();
    producer = createQueueProducer({
      connection: createRedisConnection(loadWebEnv().REDIS_URL, "producer", logger),
      logger,
    });
  }
  return producer;
}
