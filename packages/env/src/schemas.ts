import { z } from "zod";

export const NODE_ENVS = ["development", "test", "production"] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export const ENV_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** Variables every runtime process (web, worker) understands. Apps extend this schema. */
export const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default("development"),
  LOG_LEVEL: z.enum(ENV_LOG_LEVELS).default("info"),
});

export type RuntimeEnv = z.output<typeof runtimeEnvSchema>;
