import { describe, expect, it } from "vitest";

import { createLogger, isLogLevel, type LogLevel } from "./logger";

function captureLogger(level: LogLevel) {
  const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
  const logger = createLogger({
    level,
    now: () => new Date("2026-09-16T12:00:00.000Z"),
    sink: (line, entryLevel) => {
      lines.push({ level: entryLevel, entry: JSON.parse(line) as Record<string, unknown> });
    },
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("writes one JSON entry with time, level and event", () => {
    const { logger, lines } = captureLogger("debug");

    logger.info("worker.started", { pid: 42 });

    expect(lines).toEqual([
      {
        level: "info",
        entry: { time: "2026-09-16T12:00:00.000Z", level: "info", event: "worker.started", pid: 42 },
      },
    ]);
  });

  it("drops entries below the configured level", () => {
    const { logger, lines } = captureLogger("warn");

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(lines.map((line) => line.entry.event)).toEqual(["c", "d"]);
  });

  it("merges child bindings without mutating the parent logger", () => {
    const { logger, lines } = captureLogger("info");

    const child = logger.child({ service: "worker" }).child({ correlationId: "corr-1" });
    child.info("job.enqueued");
    logger.info("parent.entry");

    expect(lines[0]?.entry).toMatchObject({ service: "worker", correlationId: "corr-1" });
    expect(lines[1]?.entry).not.toHaveProperty("service");
  });

  it("keeps core fields authoritative over caller fields", () => {
    const { logger, lines } = captureLogger("info");

    logger.info("real.event", { level: "debug", event: "spoofed", time: "yesterday" });

    expect(lines[0]?.entry).toMatchObject({ level: "info", event: "real.event", time: "2026-09-16T12:00:00.000Z" });
  });

  it("serializes errors, bigints and circular references without throwing", () => {
    const { logger, lines } = captureLogger("info");
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    logger.error("failure", { error: new Error("boom"), count: 10n, circular });

    const entry = lines[0]?.entry;
    expect(entry).toMatchObject({ error: { name: "Error", message: "boom" }, count: "10" });
    expect(entry?.circular).toEqual({ name: "loop", self: "[Circular]" });
  });

  it("does not mark repeated non-circular references as circular", () => {
    const { logger, lines } = captureLogger("info");
    const shared = { id: "shared" };

    logger.info("siblings", { first: shared, second: shared });

    expect(lines[0]?.entry).toMatchObject({ first: { id: "shared" }, second: { id: "shared" } });
  });
});

describe("isLogLevel", () => {
  it("accepts only known levels", () => {
    expect(isLogLevel("info")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});
