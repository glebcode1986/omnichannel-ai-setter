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

/** Waits for a condition the loop controls, so the assertions never depend on a sleep being long enough. */
async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition was never met");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

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
    // A gate the test opens, rather than a sleep: whether close waited has to be decided by the loop's
    // own behaviour, not by whether the tick happened to finish first.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let started = false;
    let finished = false;
    const loop = startRecoveryLoop({
      name: "test",
      intervalMs: 1,
      logger: log,
      tick: async () => {
        started = true;
        await gate;
        finished = true;
        return undefined;
      },
    });
    await until(() => started);

    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    await settle();

    // Closing under a running sweep is how shutdown produces errors that look like an outage.
    expect(closed).toBe(false);
    expect(finished).toBe(false);
    open();
    await closing;
    expect(finished).toBe(true);
  });

  it("does not schedule another tick after closing", async () => {
    const { logger: log } = logger();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    const loop = startRecoveryLoop({
      name: "test",
      intervalMs: 1,
      logger: log,
      tick: async () => {
        calls += 1;
        // The first tick is still running when close is called, so the loop reaches its rescheduling
        // decision *after* closing — which is the only moment at which the guard can be observed.
        if (calls === 1) {
          await gate;
        }
        return undefined;
      },
    });
    await until(() => calls === 1);

    const closing = loop.close();
    open();
    await closing;
    const afterClose = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(calls).toBe(afterClose);
  });
});
