import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { processGuards } from "./process-guards";

function host() {
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

  it("stops on a connection failure too, when nothing owned it", () => {
    const { guards, exits, events } = host();

    // A connection-shaped error that reached this handler was not contained by whatever produced it, so
    // nobody can say what it belonged to. An error code and a dependency's state are circumstantial:
    // two unrelated failures can share both, and excusing on that basis excuses the wrong one sooner or
    // later. The worker stops and its supervisor starts it clean.
    guards.onUnhandledRejection(connectionFailure);

    expect(exits).toEqual([1]);
    expect(events[0]).toMatchObject({ event: "worker.fatal", fields: { errorCode: "ECONNREFUSED", origin: "unhandledRejection" } });
  });

  it("never writes the error itself into the log", () => {
    const { guards, events } = host();

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
