/**
 * @omnichannel/observability
 *
 * Correlation IDs, structured logs and audit helpers shared by apps and infrastructure packages.
 * Phase 1 scaffold (issue #2) provides only the structured logger used by the app entrypoints.
 */
export {
  createLogger,
  isLogLevel,
  LOG_LEVELS,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
} from "./logger";
