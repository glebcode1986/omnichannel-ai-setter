/**
 * The loop that gives an abandoned checkout's charge path back (#46).
 *
 * What this guards is the loop's manners rather than the release itself, which is the store's and is
 * tested against a real database. A workspace may hold exactly one live charge path, so a sweeper that
 * fell silent after one database blip would leave an abandoned attempt blocking every later purchase —
 * and the symptom is a customer who cannot buy, with nothing in the logs that says why.
 */
import { describe, expect, it, vi } from "vitest";

import { startBillingSweeper } from "./billing-sweeper";

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

describe("the checkout expiry sweeper", () => {
  it("reports how many charge paths it released", async () => {
    const { events, logger: log } = logger();
    const expire = vi.fn(() => Promise.resolve(2));

    const loop = startBillingSweeper({ intervalMs: 5, expireStaleCheckouts: expire, logger: log, now: () => NOW });
    await vi.waitFor(() => expect(expire).toHaveBeenCalled());
    await loop.close();

    expect(expire).toHaveBeenCalledWith(NOW);
    expect(events.some((entry) => entry.event === "worker.checkouts_expired" && entry.fields?.["released"] === 2)).toBe(true);
  });

  it("says nothing on a tick that found nothing", async () => {
    const { events, logger: log } = logger();
    const expire = vi.fn(() => Promise.resolve(0));

    const loop = startBillingSweeper({ intervalMs: 5, expireStaleCheckouts: expire, logger: log, now: () => NOW });
    await vi.waitFor(() => expect(expire).toHaveBeenCalled());
    await loop.close();

    expect(events.some((entry) => entry.event === "worker.checkouts_expired")).toBe(false);
  });

  it("keeps sweeping after a failure, and says when it recovered", async () => {
    const { events, logger: log } = logger();
    let attempts = 0;
    const expire = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("database is down")) : Promise.resolve(1);
    });

    const loop = startBillingSweeper({ intervalMs: 5, expireStaleCheckouts: expire, logger: log, now: () => NOW });
    await vi.waitFor(() => expect(events.some((entry) => entry.event === "worker.checkouts_expired_recovered")).toBe(true), { timeout: 2_000 });
    await loop.close();

    expect(attempts).toBeGreaterThan(1);
  });
});
