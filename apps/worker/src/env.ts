import { parseEnv, runtimeEnvSchema, type EnvSource } from "@omnichannel/env";
import { z } from "zod";

/**
 * Worker environment contract. Later issues extend this schema instead of reading `process.env` elsewhere.
 */
export const workerEnvSchema = runtimeEnvSchema.extend({
  /** PostgreSQL (ADR-005): the outbox sweeper reads pending queue work committed by the web app. */
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  /** Redis for BullMQ scheduling and coordination (ADR-005); not the durable source of truth. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;

export function loadWorkerEnv(source: EnvSource = process.env) {
  return parseEnv(workerEnvSchema, source);
}
