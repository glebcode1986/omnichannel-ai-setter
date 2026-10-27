import { randomUUID } from "node:crypto";

import { STRIPE_PROVIDER } from "@omnichannel/billing-stripe";
import { recordVerifiedBillingEvent, verifyProviderDelivery } from "@omnichannel/db";

import { ensureBillingAdapters } from "../../../../../server/billing-adapters";
import { createBillingWebhookHandler } from "../../../../../server/billing-webhooks";
import { getDb } from "../../../../../server/db";
import { getLogger } from "../../../../../server/logger";

export const dynamic = "force-dynamic";

export const POST = createBillingWebhookHandler({
  provider: STRIPE_PROVIDER,
  verify: verifyProviderDelivery,
  record: (event) => recordVerifiedBillingEvent(getDb(), event),
  logger: getLogger,
  newCorrelationId: randomUUID,
  ensureAdapters: ensureBillingAdapters,
});
