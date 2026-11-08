/**
 * The one list of stderr events two spawning tests check against.
 *
 * Worth a test of its own because it is now load-bearing for both of them, and because the defect it
 * replaced was invisible: `main.test.ts` permitted five events and `bundle.test.ts` kept its own copy of
 * four, so the same worker's output was legal in one file and a build failure in the other. Nothing
 * failed until a machine was loaded enough to produce the missing one.
 */
import { describe, expect, it } from "vitest";

import { PERMITTED_STDERR_EVENTS, stderrEvents, unexpectedStderrEvents } from "./testing/permitted-stderr";

const line = (event: string, extra: Readonly<Record<string, unknown>> = {}) => `${JSON.stringify({ level: "warn", event, ...extra })}\n`;

describe("the events a credential-less run may produce", () => {
  it("allows the shutdown warning that a loaded machine actually produces", () => {
    // The exact failure: the worker outlived its shutdown deadline because a library's handle stayed
    // open, reported it, and exited 0 — and one of the two tests called that a build failure.
    const stderr = line("queue.redis_unavailable") + line("worker.lingering_after_stop", { signal: "SIGTERM", trigger: "deadline" });

    expect(unexpectedStderrEvents(stderr)).toEqual([]);
  });

  it("allows each of the five on its own, so none of them is carried by another", () => {
    for (const event of PERMITTED_STDERR_EVENTS) {
      expect(unexpectedStderrEvents(line(event)), event).toEqual([]);
    }
  });
});

describe("what it still refuses", () => {
  it("reports an event nobody decided was acceptable", () => {
    // Without this the list is a way of saying yes to everything, which is what an allowlist becomes the
    // moment nothing proves it can say no.
    expect(unexpectedStderrEvents(line("worker.shutdown_timeout"))).toEqual(["worker.shutdown_timeout"]);
    expect(unexpectedStderrEvents(line("queue.redis_unavailable") + line("worker.crashed"))).toEqual(["worker.crashed"]);
  });

  it("reports a line that is not a log line at all, rather than dropping it", () => {
    // A stack trace or a native crash dump is not JSON. Skipping unparseable lines would let the one
    // output that matters most pass a check named after keeping output clean.
    expect(unexpectedStderrEvents("Segmentation fault: 11\n")).toEqual(["Segmentation fault: 11"]);
    expect(unexpectedStderrEvents('{"event":')).toEqual(['{"event":']);
  });

  it("reports a log line whose event is not a string", () => {
    expect(unexpectedStderrEvents(`${JSON.stringify({ event: 42 })}\n`)).toEqual(["42"]);
    expect(unexpectedStderrEvents(`${JSON.stringify({ level: "warn" })}\n`)).toEqual(["undefined"]);
  });
});

describe("reading the events out", () => {
  it("ignores blank lines and keeps the order", () => {
    const stderr = `${line("queue.redis_unavailable")}\n   \n${line("worker.no_media_port")}`;

    expect(stderrEvents(stderr)).toEqual(["queue.redis_unavailable", "worker.no_media_port"]);
  });
});
