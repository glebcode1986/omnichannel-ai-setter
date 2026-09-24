import { createLogger, type Logger } from "@omnichannel/observability";

import { loadWebEnv } from "../env";

let logger: Logger | undefined;

/** Process-wide structured logger for server code, created on first use. */
export function getLogger(): Logger {
  logger ??= createLogger({ level: loadWebEnv().LOG_LEVEL, bindings: { service: "web" } });
  return logger;
}
