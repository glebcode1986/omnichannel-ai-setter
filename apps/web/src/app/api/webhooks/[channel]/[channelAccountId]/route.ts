import { randomUUID } from "node:crypto";

import { ingestWebhook } from "@omnichannel/application";

import { getIngestionDependencies } from "../../../../../server/ingestion";
import { getLogger } from "../../../../../server/logger";
import { createWebhookHandlers } from "../../../../../server/webhooks";

export const dynamic = "force-dynamic";

export const { GET, POST } = createWebhookHandlers({
  ingest: (request) => ingestWebhook(getIngestionDependencies(), request),
  newCorrelationId: randomUUID,
  logger: getLogger,
});
