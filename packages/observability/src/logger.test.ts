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

  it("keeps allowlisted diagnostics, causes and aggregate errors but not arbitrary error properties", () => {
    const { logger, lines } = captureLogger("info");
    const rootCause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      port: 5432,
      config: { headers: { authorization: "Bearer should-not-be-logged" } },
    });
    const wrapped = new Error("query failed", { cause: rootCause });
    const aggregate = new AggregateError([new Error("a"), new Error("b")], "many");

    logger.error("failure", { error: wrapped, aggregate });

    const entry = lines[0]?.entry;
    expect(entry).toMatchObject({
      error: {
        message: "query failed",
        cause: { name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED", syscall: "connect", port: 5432 },
      },
      aggregate: { name: "AggregateError", errors: [{ message: "a" }, { message: "b" }] },
    });
    expect(JSON.stringify(entry)).not.toContain("should-not-be-logged");
  });

  it("never trusts an error's own toJSON or non-error causes, codes and aggregate members", () => {
    const { logger, lines } = captureLogger("info");
    const secret = "Bearer should-not-be-logged";
    class HttpClientError extends Error {
      config = { headers: { authorization: secret } };
      toJSON() {
        return { message: this.message, config: this.config };
      }
    }
    const plainCause = Object.assign(new Error("send failed"), { cause: { status: 401, config: { headers: { authorization: secret } } } });
    const objectCode = Object.assign(new Error("weird"), { code: { token: secret } });
    const aggregate = new AggregateError([{ request: { headers: { authorization: secret } } }, new Error("real")], "many");
    const wrapped = new Error("outer", { cause: new HttpClientError("http 401") });

    logger.error("failure", { direct: new HttpClientError("http 401"), plainCause, objectCode, aggregate, wrapped });

    const entry = lines[0]?.entry;
    expect(JSON.stringify(entry)).not.toContain("should-not-be-logged");
    expect(entry).toMatchObject({
      direct: { name: "Error", message: "http 401" },
      plainCause: { message: "send failed", cause: "[non-error object]" },
      aggregate: { errors: ["[non-error object]", { message: "real" }] },
      wrapped: { cause: { message: "http 401" } },
    });
    expect(entry?.objectCode).not.toHaveProperty("code");
  });

  it("serializes errors created in another realm", async () => {
    const { runInNewContext } = await import("node:vm");
    const { logger, lines } = captureLogger("info");
    const foreign = runInNewContext('Object.assign(new Error("from vm"), { config: { secret: "vm-secret" } })') as unknown;

    logger.error("failure", { error: foreign });

    expect(lines[0]?.entry).toMatchObject({ error: { name: "Error", message: "from vm" } });
    expect(JSON.stringify(lines[0]?.entry)).not.toContain("vm-secret");
  });

  it("marks self-referencing error causes as circular", () => {
    const { logger, lines } = captureLogger("info");
    const error = new Error("loop");
    (error as Error & { cause?: unknown }).cause = error;

    logger.error("failure", { error });

    expect(lines[0]?.entry).toMatchObject({ error: { message: "loop", cause: "[Circular]" } });
  });

  it("never lets caller fields replace the entry or throw into the caller", () => {
    const { logger, lines } = captureLogger("info");
    const throwingGetter = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter threw");
      },
    });

    const hostile = Object.assign(JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>, {
      toJSON: () => ({ spoof: true }),
    });
    logger.info("spoof", hostile);
    expect(() => logger.info("getter", throwingGetter)).not.toThrow();
    expect(() => logger.info("nested-getter", { nested: throwingGetter })).not.toThrow();

    expect(lines[0]?.entry).toMatchObject({ level: "info", event: "spoof" });
    expect(lines[0]?.entry).not.toHaveProperty("spoof");
    expect(lines[1]?.entry).toMatchObject({ level: "info", event: "getter", logSerializationError: "Error: getter threw" });
    expect(lines[2]?.entry).toMatchObject({ level: "info", event: "nested-getter", logSerializationError: "Error: getter threw" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("swallows sink failures", () => {
    const logger = createLogger({
      level: "info",
      sink: () => {
        throw new Error("EPIPE");
      },
    });

    expect(() => logger.info("anything")).not.toThrow();
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
