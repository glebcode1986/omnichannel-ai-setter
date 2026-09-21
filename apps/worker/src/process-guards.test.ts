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
  const guards = processGuards(logger, (code) => {
    exits.push(code);
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

  it("keeps running after an unhandled rejection, and still says one happened", () => {
    const { guards, exits, events } = host();

    guards.onUnhandledRejection(connectionFailure);

    // The shape this takes in production is a background reconnect to a Redis that is down — the exact
    // outage this worker is built to run through. Exiting would turn it into a crash loop, and take
    // every in-flight job with it.
    expect(exits).toEqual([]);
    expect(events[0]).toMatchObject({ event: "worker.unhandled_rejection", fields: { errorName: "Error", errorCode: "ECONNREFUSED" } });
  });

  it("never writes the error itself into the log", () => {
    const { guards, events } = host();

    guards.onUncaughtException(connectionFailure, "unhandledRejection");
    guards.onUnhandledRejection(connectionFailure);

    // An error object serializes its message and its stack, and a crash log is exactly where a password
    // ends up being read by everyone.
    const written = JSON.stringify(events);
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("10.0.0.4");
    expect(written).not.toContain("ECONNREFUSED redis");
    for (const entry of events) {
      expect(Object.keys(entry.fields)).not.toContain("error");
      expect(Object.keys(entry.fields)).not.toContain("stack");
    }
  });

  it("survives a rejection that is not an error at all", () => {
    const { guards, exits, events } = host();

    guards.onUnhandledRejection("just a string");
    guards.onUnhandledRejection(undefined);

    expect(exits).toEqual([]);
    expect(events.map((entry) => entry.fields.errorName)).toEqual(["string", "undefined"]);
  });
});
