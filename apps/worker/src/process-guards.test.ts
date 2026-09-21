import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { processGuards } from "./process-guards";
import { createRedisOutageWatch } from "./redis-outage";

function host(survivable?: (reason: unknown) => boolean) {
  const exits: number[] = [];
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    error: (event: string, fields?: Readonly<Record<string, unknown>>) => {
      events.push({ event, fields: { ...fields } });
    },
  } as unknown as Logger;
  const guards = processGuards({
    logger,
    exit: (code: number) => {
      exits.push(code);
    },
    ...(survivable === undefined ? {} : { survivable }),
  });
  return { exits, events, guards };
}

/** A connection failure carries the host, the user and, in a real deployment, the password. */
const connectionFailure = Object.assign(new Error("connect ECONNREFUSED redis://user:hunter2@10.0.0.4:6379"), {
  code: "ECONNREFUSED",
});

describe("what the worker does when an error escapes everything", () => {
  it("stops on an uncaught exception, because what it interrupted is unknown", () => {
    const { guards, exits, events } = host();

    guards.onUncaughtException(new TypeError("boom"), "uncaughtException");

    expect(exits).toEqual([1]);
    expect(events[0]).toMatchObject({ event: "worker.fatal", fields: { errorName: "TypeError", origin: "uncaughtException" } });
  });

  it("stops on an escaped rejection it cannot account for", () => {
    const { guards, exits, events } = host();

    guards.onUnhandledRejection(new TypeError("something else entirely"));

    // A rejection can escape after a partial write. Continuing then means processing policy-critical work
    // on invariants nobody can vouch for, so an unknown cause is treated exactly like an uncaught throw.
    expect(exits).toEqual([1]);
    expect(events[0]).toMatchObject({ event: "worker.fatal", fields: { origin: "unhandledRejection" } });
  });

  it("survives only the failure it can positively identify as its own reconnecting client", () => {
    const { guards, exits, events } = host(() => true);

    guards.onUnhandledRejection(connectionFailure);

    expect(exits).toEqual([]);
    expect(events[0]).toMatchObject({ event: "worker.unhandled_rejection", fields: { errorCode: "ECONNREFUSED", survived: true } });
  });

  it("never writes the error itself into the log", () => {
    const { guards, events } = host(() => true);

    guards.onUncaughtException(connectionFailure, "uncaughtException");
    guards.onUnhandledRejection(connectionFailure);

    // An error object serializes its message and its stack, and a crash log is exactly where a password
    // ends up being read by everyone.
    const written = JSON.stringify(events);
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("10.0.0.4");
    for (const entry of events) {
      expect(Object.keys(entry.fields)).not.toContain("error");
      expect(Object.keys(entry.fields)).not.toContain("stack");
    }
  });
});

describe("deciding that a rejection is our own Redis reconnecting", () => {
  const watch = (status: string) => {
    const outage = createRedisOutageWatch();
    outage.watch({ status });
    return outage;
  };

  it("excuses a connection failure only while one of our clients is down", () => {
    expect(watch("reconnecting").survivable(connectionFailure)).toBe(true);
    expect(watch("end").survivable(connectionFailure)).toBe(true);
    // The same error arriving while every client is healthy is not the reconnect case. Excusing it would
    // mean excusing a connection error from anything at all, which is the blanket rule this replaced.
    expect(watch("ready").survivable(connectionFailure)).toBe(false);
  });

  it("excuses nothing that is not a connection-level failure", () => {
    const outage = watch("reconnecting");

    // A rejected command carries no code; an application error that merely happened during the outage is
    // still an application error, and its invariants are still unknown.
    expect(outage.survivable(new Error("WRONGTYPE Operation against a key"))).toBe(false);
    expect(outage.survivable(Object.assign(new Error("boom"), { code: "ERR_UNHANDLED" }))).toBe(false);
    expect(outage.survivable(Object.assign(new Error("boom"), { code: 42 }))).toBe(false);
    expect(outage.survivable("a string")).toBe(false);
    expect(outage.survivable(undefined)).toBe(false);
  });

  it("excuses nothing at all before a client exists", () => {
    // Nothing has been created yet, so nothing can be attributed to it.
    expect(createRedisOutageWatch().survivable(connectionFailure)).toBe(false);
  });
});
