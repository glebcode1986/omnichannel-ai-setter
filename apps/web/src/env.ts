import { parseEnv, runtimeEnvSchema, type EnvSource } from "@omnichannel/env";

/**
 * Server-side web environment contract. Later issues extend this schema (e.g. database and
 * Auth.js settings in #4). Never expose these values to client components.
 */
export const webEnvSchema = runtimeEnvSchema;

export type WebEnv = ReturnType<typeof loadWebEnv>;

export function loadWebEnv(source: EnvSource = process.env) {
  return parseEnv(webEnvSchema, source);
}
