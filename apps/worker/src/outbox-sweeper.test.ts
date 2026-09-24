import type { OutboxDispatchResult } from "@omnichannel/application";
import { createLogger } from "@omnichannel/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startOutboxSweeper } from "./outbox-sweeper";

describe("startOutboxSweeper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function logger(events: string[]) {
    return createLogger({ level: "debug", sink: (line) => events.push((JSON.parse(line) as { event: string }).event) });
  }

  it("sweeps on an interval without overlapping and logs failures once per outage", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    let call = 0;
    const sweep = vi.fn(async (): Promise<OutboxDispatchResult> => {
      call += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 250));
      active -= 1;
      if (call === 2 || call === 3) {
        throw new Error("database unavailable");
      }
      return { dispatched: call === 4 ? 2 : 0, failed: 0 };
    });

    const sweeper = startOutboxSweeper({ intervalMs: 100, sweep, logger: logger(events) });
    await vi.advanceTimersByTimeAsync(1_500);
    const closing = sweeper.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;

    expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(maxActive).toBe(1);
    expect(events.filter((event) => event === "worker.outbox_sweep_failed")).toHaveLength(1);
    expect(events).toContain("worker.outbox_sweep_recovered");
    expect(events).toContain("worker.outbox_swept");
  });

  it("waits for a running sweep on close and schedules no further sweeps", async () => {
    vi.useFakeTimers();
    let finished = false;
    const sweep = vi.fn(async (): Promise<OutboxDispatchResult> => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      finished = true;
      return { dispatched: 0, failed: 0 };
    });
    const sweeper = startOutboxSweeper({ intervalMs: 50, sweep, logger: logger([]) });
    await vi.advanceTimersByTimeAsync(60);

    const closing = sweeper.close();
    await vi.advanceTimersByTimeAsync(200);
    await closing;
    expect(finished).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
