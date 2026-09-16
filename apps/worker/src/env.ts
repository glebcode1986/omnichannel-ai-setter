import { parseEnv, runtimeEnvSchema, type EnvSource } from "@omnichannel/env";

/**
 * Worker environment contract. Later issues extend this schema (e.g. Redis/PostgreSQL connection
 * settings in #4/#5) instead of reading `process.env` elsewhere.
 */
export const workerEnvSchema = runtimeEnvSchema;

export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;

export function loadWorkerEnv(source: EnvSource = process.env) {
  return parseEnv(workerEnvSchema, source);
}
