import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { startRecoveryLoop } from "./recovery-loop";

function logger() {
  const events: string[] = [];
  const record = (event: string) => {
    events.push(event);
  };
  return { events, logger: { info: record, warn: record, error: record, debug: vi.fn(), child: vi.fn() } as unknown as Logger };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a loop that has to survive the outage it is watching", () => {
  it("never runs two ticks at once", async () => {
    const { logger: log } = logger();
    let inFlight = 0;
    let overlapped = false;
    const loop = startRecoveryLoop({
      name: "test",
      intervalMs: 1,
      logger: log,
      tick: async () => {
        inFlight += 1;
        overlapped ||= inFlight > 1;
        await settle();
        inFlight -= 1;
        return undefined;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await loop.close();

    // Two passes claiming the same rows is the whole reason this is not a bare setInterval.
    expect(overlapped).toBe(false);
  });

  it("logs one warning per outage, not one per tick", async () => {
    const { events, logger: log } = logger();
    const loop = startRecoveryLoop({
      name: "test",
      intervalMs: 1,
      logger: log,
      tick: () => Promise.reject(new Error("database is down")),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await loop.close();

    // Otherwise a five-minute outage becomes thousands of identical lines — the same alert fatigue the
    // incident aggregation exists to prevent, arriving through the log instead.
    expect(events.filter((event) => event === "worker.test_failed")).toHaveLength(1);
  });

  it("says when it recovers, so silence is not the only signal", async () => {
    const { events, logger: log } = logger();
    let failing = true;
    const loop = startRecoveryLoop({
      name: "test",
      intervalMs: 1,
      logger: log,
      tick: () => {
        if (failing) {
          failing = false;
          return Promise.reject(new Error("down"));
        }
        return Promise.resolve(undefined);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await loop.close();

    expect(events).toContain("worker.test_recovered");
  });

  it("keeps quiet on a tick that found nothing to do", async () => {
    const { events, logger: log } = logger();
    const loop = startRecoveryLoop({ name: "test", intervalMs: 1, logger: log, tick: () => Promise.resolve(undefined) });

    await new Promise((resolve) => setTimeout(resolve, 30));
    await loop.close();

    expect(events).toHaveLength(0);
  });

  it("waits for a running tick before closing", async () => {
    const { logger: log } = logger();
    let finished = false;
    const loop = startRecoveryLoop({
      name: "test",
      intervalMs: 1,
      logger: log,
      tick: async () => {
        await settle();
        finished = true;
        return undefined;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await loop.close();

    // Closing under a running sweep is how shutdown produces errors that look like an outage.
    expect(finished).toBe(true);
  });

  it("does not schedule another tick after closing", async () => {
    const { logger: log } = logger();
    const tick = vi.fn(() => Promise.resolve(undefined));
    const loop = startRecoveryLoop({ name: "test", intervalMs: 1, logger: log, tick });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await loop.close();
    const calls = tick.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tick.mock.calls.length).toBe(calls);
  });
});
