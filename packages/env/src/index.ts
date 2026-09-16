/**
 * @omnichannel/env
 *
 * Environment validation helpers for composition roots (`apps/web`, `apps/worker`).
 * Infrastructure-free leaf package: apps validate their environment once at startup and pass
 * typed configuration inward; core packages never read `process.env` directly.
 */
export {
  EnvValidationError,
  parseEnv,
  type EnvIssue,
  type EnvSource,
  type ParseEnvOptions,
} from "./parse-env";
export {
  ENV_LOG_LEVELS,
  NODE_ENVS,
  runtimeEnvSchema,
  type NodeEnv,
  type RuntimeEnv,
} from "./schemas";
