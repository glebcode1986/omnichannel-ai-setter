import { describe, expect, it } from "vitest";

import { decideBackpressure, DEFAULT_BACKLOG_THRESHOLDS, type BacklogReading } from "./backpressure";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const THRESHOLDS = { waiting: 100, oldestWaitingMs: 60_000, clearFraction: 0.5, suspendForMs: 300_000 };

const reading = (overrides: Partial<BacklogReading> = {}): BacklogReading => ({
  queue: "delivery",
  waiting: 0,
  oldestWaitingMs: 0,
  ...overrides,
});

describe("stopping work from piling onto a pile", () => {
  it("does nothing while the queues are moving", () => {
    expect(decideBackpressure([reading({ waiting: 99, oldestWaitingMs: 59_999 })], THRESHOLDS, { suspended: false }, NOW)).toEqual({ kind: "NONE" });
  });

  it("stops outbound on depth alone", () => {
    const decision = decideBackpressure([reading({ waiting: 100 })], THRESHOLDS, { suspended: false }, NOW);

    expect(decision.kind).toBe("SUSPEND");
  });

  it("stops outbound on age alone, because a small queue can be completely stuck", () => {
    // Twelve jobs whose oldest has waited a minute is not a burst; it is a queue that has stopped.
    const decision = decideBackpressure([reading({ waiting: 12, oldestWaitingMs: 60_000 })], THRESHOLDS, { suspended: false }, NOW);

    expect(decision.kind).toBe("SUSPEND");
  });

  it("bounds every automatic stop, so a guard that dies cannot leave automation off", () => {
    const decision = decideBackpressure([reading({ waiting: 500 })], THRESHOLDS, { suspended: false }, NOW);

    expect(decision.kind === "SUSPEND" && decision.until.toISOString()).toBe(new Date(NOW.getTime() + THRESHOLDS.suspendForMs).toISOString());
  });

  it("keeps renewing while the backlog persists", () => {
    // Already suspended and still bad: the answer is another SUSPEND, which pushes the deadline out.
    const decision = decideBackpressure([reading({ waiting: 500 })], THRESHOLDS, { suspended: true }, NOW);

    expect(decision.kind).toBe("SUSPEND");
  });

  it("does not resume the moment it dips below the tripping level", () => {
    // Between the clearing level and the tripping level. Resuming here is how a guard flaps.
    const decision = decideBackpressure([reading({ waiting: 60 })], THRESHOLDS, { suspended: true }, NOW);

    expect(decision).toEqual({ kind: "NONE" });
  });

  it("resumes once the backlog has genuinely drained", () => {
    const decision = decideBackpressure([reading({ waiting: 49, oldestWaitingMs: 29_999 })], THRESHOLDS, { suspended: true }, NOW);

    expect(decision.kind).toBe("LIFT");
  });

  it("never lifts a stop it did not place", () => {
    expect(decideBackpressure([reading()], THRESHOLDS, { suspended: false }, NOW)).toEqual({ kind: "NONE" });
  });

  it("names the worst queue, so the detail says what to look at", () => {
    const decision = decideBackpressure(
      [reading({ queue: "delivery", waiting: 120 }), reading({ queue: "ai-draft-generation", waiting: 900 })],
      THRESHOLDS,
      { suspended: false },
      NOW,
    );

    expect(decision.kind === "SUSPEND" && decision.detail).toContain("ai-draft-generation");
  });

  it("ships a clearing level that is actually below the tripping one", () => {
    // A default clearFraction of 1 would be a switch that flaps on every tick, which is worse than none.
    expect(DEFAULT_BACKLOG_THRESHOLDS.clearFraction).toBeLessThan(1);
    expect(DEFAULT_BACKLOG_THRESHOLDS.suspendForMs).toBeGreaterThan(0);
  });
});
