import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createIncidentReporter } from "./incident-reporter";

const NOW = new Date("2026-09-20T12:00:00.000Z");

function reporter(thresholds = { occurrences: 5, conversations: 3 }) {
  const events: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const record = (event: string, fields?: Readonly<Record<string, unknown>>) => {
    events.push({ event, ...(fields === undefined ? {} : { fields }) });
  };
  const logger = { info: record, warn: record, error: record, debug: vi.fn(), child: vi.fn() } as unknown as Logger;
  let now = NOW;
  return {
    events,
    at: (value: Date) => {
      now = value;
    },
    incidents: createIncidentReporter({ logger, windowMs: 60_000, limit: 100, thresholds, now: () => now }),
  };
}

const failure = (overrides: Partial<Parameters<ReturnType<typeof reporter>["incidents"]["record"]>[0]> = {}) => ({
  queueName: "ai-draft-generation",
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  errorName: "TimeoutError",
  willRetry: true,
  ...overrides,
});

describe("one outage produces one notification", () => {
  it("stays quiet for a blip", () => {
    const { incidents, events } = reporter();

    incidents.record(failure());
    incidents.report(NOW);

    expect(events).toHaveLength(0);
  });

  it("announces a sustained failure exactly once", () => {
    const { incidents, events } = reporter();

    for (let index = 0; index < 20; index += 1) {
      incidents.record(failure({ conversationId: `conv_${String(index)}` }));
    }
    incidents.report(NOW);
    incidents.report(NOW);
    incidents.report(NOW);

    // Four hundred identical alerts carry the same information as none, and cost more attention.
    expect(events.filter((entry) => entry.event === "worker.incident")).toHaveLength(1);
  });

  it("counts failures that will be retried", () => {
    const { incidents, events } = reporter();

    // A provider failing and recovering on the retry every time is still an outage. Counting only final
    // failures would hide the whole shape of it.
    for (let index = 0; index < 6; index += 1) {
      incidents.record(failure({ willRetry: true }));
    }
    incidents.report(NOW);

    expect(events.filter((entry) => entry.event === "worker.incident")).toHaveLength(1);
  });

  it("keeps failures of different kinds apart", () => {
    const { incidents, events } = reporter();

    for (let index = 0; index < 6; index += 1) {
      incidents.record(failure({ errorName: "TimeoutError" }));
      incidents.record(failure({ errorName: "UnauthorizedError" }));
    }
    incidents.report(NOW);

    // A timeout and an auth error need different actions, so they are two incidents, not one.
    expect(events.filter((entry) => entry.event === "worker.incident")).toHaveLength(2);
  });

  it("forgets an incident once it stops recurring, and says so", () => {
    const { incidents, events, at } = reporter();

    for (let index = 0; index < 6; index += 1) {
      incidents.record(failure());
    }
    incidents.report(NOW);
    const later = new Date(NOW.getTime() + 120_000);
    at(later);
    incidents.report(later);

    expect(events.filter((entry) => entry.event === "worker.incident_cleared")).toHaveLength(1);
    // And the same outage next week is announced again rather than suppressed by a stale memory.
    for (let index = 0; index < 6; index += 1) {
      incidents.record(failure());
    }
    incidents.report(later);
    expect(events.filter((entry) => entry.event === "worker.incident")).toHaveLength(2);
  });

  it("drops the oldest signals rather than growing without bound", () => {
    const { incidents } = reporter({ occurrences: 1_000, conversations: 1_000 });

    for (let index = 0; index < 500; index += 1) {
      incidents.record(failure({ conversationId: `conv_${String(index)}` }));
    }

    // During a storm the buffer must not become the second thing to fail.
    expect(incidents.current()[0]?.occurrences).toBe(100);
  });

  it("does not group by tenant, because one provider outage is one incident", () => {
    const { incidents } = reporter();

    for (let index = 0; index < 6; index += 1) {
      incidents.record(failure({ workspaceId: `ws_${String(index)}` }));
    }

    expect(incidents.current()).toHaveLength(1);
  });
});
