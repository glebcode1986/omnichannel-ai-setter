/**
 * The loop that gives held allowance back (#39).
 *
 * What this guards is not the release itself — that is the store's, tested against a real database — but
 * the loop's two manners: it must not shout on a quiet tick, and it must not fall silent for ever after
 * one failure. A sweeper that stopped after a database blip would leave every later reservation held, and
 * nothing in the logs would say so.
 */
import { describe, expect, it, vi } from "vitest";

import { startUsageSweeper } from "./usage-sweeper";

const logger = () => {
  const events: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  return {
    events,
    logger: {
      debug: () => undefined,
      info: (event: string, fields?: Readonly<Record<string, unknown>>) => events.push(fields === undefined ? { event } : { event, fields }),
      warn: (event: string, fields?: Readonly<Record<string, unknown>>) => events.push(fields === undefined ? { event } : { event, fields }),
      error: (event: string, fields?: Readonly<Record<string, unknown>>) => events.push(fields === undefined ? { event } : { event, fields }),
      child: () => logger().logger,
    } as never,
  };
};

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe("the usage reservation sweeper", () => {
  it("reports how many holds it gave back", async () => {
    const { events, logger: log } = logger();
    const release = vi.fn(() => Promise.resolve(3));

    const loop = startUsageSweeper({ intervalMs: 5, releaseStaleReservations: release, logger: log, now: () => NOW });
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    await loop.close();

    expect(release).toHaveBeenCalledWith(NOW);
    expect(events.some((entry) => entry.event === "worker.usage_reservations_released" && entry.fields?.["released"] === 3)).toBe(true);
  });

  it("says nothing on a tick that found nothing", async () => {
    // A line every five minutes saying "zero" trains an operator to ignore the one that says something.
    const { events, logger: log } = logger();
    const release = vi.fn(() => Promise.resolve(0));

    const loop = startUsageSweeper({ intervalMs: 5, releaseStaleReservations: release, logger: log, now: () => NOW });
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    await loop.close();

    expect(events.some((entry) => entry.event === "worker.usage_reservations_released")).toBe(false);
  });

  it("keeps sweeping after a failure, and says when it recovered", async () => {
    const { events, logger: log } = logger();
    let attempts = 0;
    const release = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("database is down")) : Promise.resolve(1);
    });

    const loop = startUsageSweeper({ intervalMs: 5, releaseStaleReservations: release, logger: log, now: () => NOW });
    await vi.waitFor(() => expect(events.some((entry) => entry.event === "worker.usage_reservations_released_recovered")).toBe(true), {
      timeout: 2_000,
    });
    await loop.close();

    // The hold is a customer's allowance; a loop that gave up after one blip would keep it until the
    // cycle turned over, with nothing in the log to explain where the minutes went.
    expect(attempts).toBeGreaterThan(1);
  });
});
