/**
 * Next.js server startup hook: validates the environment once at server start. On invalid
 * configuration Next.js logs the (value-free) validation error and refuses to serve requests
 * (HTTP 500) instead of running with a partially valid config.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { createLogger } = await import("@omnichannel/observability");
  const { loadWebEnv } = await import("./env");

  const env = loadWebEnv();
  createLogger({ level: env.LOG_LEVEL, bindings: { service: "web" } }).info("web.started", {
    nodeEnv: env.NODE_ENV,
  });
}
