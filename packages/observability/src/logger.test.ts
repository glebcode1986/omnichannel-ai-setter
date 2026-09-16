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

  it("never executes an error's toJSON or discloses exceptions from toJSON/getters (R1-04)", () => {
    const secret = "r1-fake-secret-DO-NOT-LOG";
    const { logger, lines } = captureLogger("info");
    let toJsonCalls = 0;
    const throwingToJson = Object.assign(new Error("request failed"), {
      toJSON() {
        toJsonCalls += 1;
        throw new Error(secret);
      },
    });
    const throwingGetter = Object.defineProperty(new Error("getter failed"), "code", {
      get() {
        throw new Error(secret);
      },
    });
    const throwingField = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const throwingPlainToJson = {
      toJSON() {
        throw new Error(secret);
      },
    };

    logger.error("request.failed", { error: throwingToJson });
    logger.error("getter.failed", { error: throwingGetter, throwingField, throwingPlainToJson });

    const output = JSON.stringify(lines);
    expect(output).not.toContain(secret);
    expect(toJsonCalls).toBe(0);
    expect(lines[0]?.entry).toMatchObject({ event: "request.failed", error: { name: "Error", message: "request failed" } });
    expect(lines[1]?.entry).toMatchObject({
      event: "getter.failed",
      error: { message: "getter failed", code: "[unserializable]" },
      throwingField: { value: "[unserializable]" },
      throwingPlainToJson: "[unserializable]",
    });
  });

  it("honours an array's own toJSON and ignores Symbol.species tricks (R1-04 follow-up)", () => {
    const secret = "r104-fake-secret-DO-NOT-LOG";
    const { logger, lines } = captureLogger("info");
    const apiKeys = Object.assign([secret], { toJSON: () => "[1 key redacted]" });
    const leakyError = Object.assign(new Error("species"), { toJSON: () => ({ config: secret }) });
    const speciesArray = Object.defineProperty([1], "constructor", {
      value: { [Symbol.species]: function Species() { return leakyError; } },
    });
    const aggregate = new AggregateError([], "many");
    (aggregate as AggregateError & { errors: unknown[] }).errors = Object.defineProperty([new Error("inner")], "constructor", {
      value: { [Symbol.species]: function Species() { return leakyError; } },
    });

    logger.info("arrays", { apiKeys, list: speciesArray, aggregate });

    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(lines[0]?.entry).toMatchObject({
      apiKeys: "[1 key redacted]",
      list: [1],
      aggregate: { errors: [{ message: "inner" }] },
    });
  });

  it("treats cross-realm tagged errors and proxied errors as errors, never calling their toJSON (R1-04 follow-up)", async () => {
    const { runInNewContext } = await import("node:vm");
    const secret = "r104-fake-secret-DO-NOT-LOG";
    const { logger, lines } = captureLogger("info");
    const tagged = runInNewContext(
      `class HttpClientError extends Error {
         get [Symbol.toStringTag]() { return "HttpClientError"; }
         constructor(message, token) { super(message); this.config = { headers: { Authorization: "Bearer " + token } }; }
         toJSON() { return { message: this.message, config: this.config }; }
       }
       new HttpClientError("Request failed with status code 401", secret);`,
      { secret },
    ) as object;
    const proxied = new Proxy(runInNewContext('Object.assign(new Error("proxied"), { toJSON: () => ({ leak: secret }) })', { secret }) as object, {});

    logger.error("cross.realm", { tagged, proxied });

    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(lines[0]?.entry).toMatchObject({
      tagged: { message: "Request failed with status code 401" },
      proxied: { message: "proxied" },
    });
  });

  it("passes the property key to a non-error toJSON, like JSON.stringify (R1-04 follow-up)", () => {
    const secret = "R1-SYNTHETIC-keyed-redaction";
    const seenKeys: string[] = [];
    const redactor = {
      toJSON(key: string) {
        seenKeys.push(key);
        return key === "credential" || key === "0" ? "[REDACTED]" : secret;
      },
    };
    const fields = {
      credential: redactor,
      nested: { credential: redactor },
      list: [redactor],
    };
    const { logger, lines } = captureLogger("info");

    logger.child({ credential: redactor }).info("test", fields);
    const loggedKeys = [...seenKeys];

    expect(loggedKeys).toEqual(["credential", "credential", "credential", "0"]);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(lines[0]?.entry).toMatchObject({ credential: "[REDACTED]", nested: { credential: "[REDACTED]" }, list: ["[REDACTED]"] });
    expect(JSON.stringify({ credential: redactor })).toBe('{"credential":"[REDACTED]"}');
  });

  it("does not ask a toJSON result for toJSON again, matching JSON.stringify", () => {
    const { logger, lines } = captureLogger("info");
    const inner = { toJSON: () => "inner-called" };
    const outer = { toJSON: () => ({ inner: "plain", wrapped: inner }) };
    const direct = { toJSON: () => inner };

    logger.info("nested", { outer, direct });

    expect(JSON.parse(JSON.stringify({ outer, direct }))).toEqual({ outer: { inner: "plain", wrapped: "inner-called" }, direct: {} });
    expect(lines[0]?.entry).toMatchObject({ outer: { inner: "plain", wrapped: "inner-called" }, direct: {} });
  });

  it("keeps bindings and other fields when message and stack are logged as plain fields", () => {
    const { logger, lines } = captureLogger("info");
    const failure = new Error("OAuth token exchange failed");

    logger
      .child({ service: "worker", correlationId: "corr-123" })
      .error("job.failed", { message: failure.message, stack: failure.stack, jobId: "job-1", nested: { message: "m", stack: "s", digest: "d" } });

    expect(lines[0]?.entry).toMatchObject({
      service: "worker",
      correlationId: "corr-123",
      message: "OAuth token exchange failed",
      jobId: "job-1",
      nested: { message: "m", stack: "s", digest: "d" },
    });
    expect(lines[0]?.entry).not.toHaveProperty("name");
  });

  it("keeps both errors of a SuppressedError", () => {
    const { logger, lines } = captureLogger("info");
    const SuppressedErrorCtor = (globalThis as { SuppressedError?: new (error: unknown, suppressed: unknown, message: string) => Error })
      .SuppressedError;
    const suppressed = SuppressedErrorCtor
      ? new SuppressedErrorCtor(new Error("redis quit timed out"), new Error("channel send rejected (131047)"), "suppressed")
      : Object.assign(new Error("suppressed"), {
          error: new Error("redis quit timed out"),
          suppressed: new Error("channel send rejected (131047)"),
        });

    logger.error("job.failed", { error: suppressed });

    expect(lines[0]?.entry).toMatchObject({
      error: { error: { message: "redis quit timed out" }, suppressed: { message: "channel send rejected (131047)" } },
    });
  });

  it("bounds the total work for shared-reference graphs and huge arrays", () => {
    const { logger, lines } = captureLogger("info");
    let dag: Record<string, unknown> = { id: "leaf" };
    for (let level = 0; level < 30; level += 1) {
      dag = { left: dag, right: dag };
    }

    logger.info("dag", { dag, big: Array.from({ length: 20_000 }, (_, index) => index) });

    const serialized = JSON.stringify(lines[0]?.entry);
    expect(serialized).toContain("[Truncated]");
    expect(serialized.length).toBeLessThan(5_000_000);
  });

  it("never runs toJSON of a proxied cross-realm error behind a deep class chain", async () => {
    const { runInNewContext } = await import("node:vm");
    const secret = "r104-deep-chain-secret";
    const { logger, lines } = captureLogger("info");
    const deep = runInNewContext(
      `let C = Error; for (let i = 0; i < 40; i++) { C = class extends C {}; }
       const e = new C("deep"); e.config = { authorization: "Bearer " + secret };
       e.toJSON = function () { return { config: this.config }; }; e;`,
      { secret },
    ) as object;

    logger.error("deep", { error: new Proxy(deep, {}) });

    expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it("uses fixed text when the entry cannot be serialized at all", () => {
    const { logger, lines } = captureLogger("info");
    const hostileKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("r1-fake-secret-DO-NOT-LOG");
        },
      },
    );

    logger.info("hostile", hostileKeys);

    expect(lines[0]?.entry).toMatchObject({ event: "hostile", logSerializationError: "[unserializable]" });
    expect(JSON.stringify(lines)).not.toContain("r1-fake-secret");
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
    expect(lines[1]?.entry).toMatchObject({ level: "info", event: "getter", boom: "[unserializable]" });
    expect(lines[2]?.entry).toMatchObject({ level: "info", event: "nested-getter", nested: { boom: "[unserializable]" } });
    expect(JSON.stringify(lines)).not.toContain("getter threw");
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
