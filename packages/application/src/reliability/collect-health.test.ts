import type { ComponentHealth } from "@omnichannel/domain";
import { describe, expect, it } from "vitest";

import { collectHealth, type HealthProbe } from "./collect-health";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const EARLIER = new Date("2026-09-20T11:00:00.000Z");

const probe = (overrides: Partial<HealthProbe> & { kind: HealthProbe["kind"]; id: string }): HealthProbe => ({
  check: () => Promise.resolve({ state: "OPERATIONAL", summary: "connected" }),
  ...overrides,
});

describe("what an operator is told when something is wrong", () => {
  it("reports a probe that threw as action required, without repeating what it said", async () => {
    const secret = "connect ECONNREFUSED postgres://omnichannel:hunter2@10.0.0.4:5432";
    const components = await collectHealth([probe({ kind: "DATABASE", id: "primary", check: () => Promise.reject(new Error(secret)) })], NOW);

    expect(components[0]).toMatchObject({ state: "ACTION_REQUIRED", summary: "unreachable" });
    // A health surface is one of the easiest places for a connection string to end up on a screen.
    expect(JSON.stringify(components)).not.toContain("hunter2");
  });

  it("does not let one failing probe hide the others", async () => {
    const components = await collectHealth(
      [
        probe({ kind: "DATABASE", id: "primary", check: () => Promise.reject(new Error("down")) }),
        probe({ kind: "QUEUE", id: "redis" }),
      ],
      NOW,
    );

    expect(components).toHaveLength(2);
    expect(components[1]).toMatchObject({ kind: "QUEUE", state: "OPERATIONAL" });
  });

  it("keeps the moment a state began, so 'for how long' is answerable", async () => {
    const previous: readonly ComponentHealth[] = [
      { kind: "CHANNEL_ACCOUNT", id: "acct_1", state: "ACTION_REQUIRED", summary: "reconnect needed", since: EARLIER },
    ];

    const components = await collectHealth(
      [probe({ kind: "CHANNEL_ACCOUNT", id: "acct_1", check: () => Promise.resolve({ state: "ACTION_REQUIRED", summary: "reconnect needed" }) })],
      NOW,
      previous,
    );

    // "Action required" and "action required for the last hour" are different situations, and only the
    // second one tells someone whether their fix worked.
    expect(components[0]?.since.toISOString()).toBe(EARLIER.toISOString());
  });

  it("starts the clock again when the state changes", async () => {
    const previous: readonly ComponentHealth[] = [
      { kind: "CHANNEL_ACCOUNT", id: "acct_1", state: "ACTION_REQUIRED", summary: "reconnect needed", since: EARLIER },
    ];

    const components = await collectHealth([probe({ kind: "CHANNEL_ACCOUNT", id: "acct_1" })], NOW, previous);

    expect(components[0]).toMatchObject({ state: "OPERATIONAL" });
    expect(components[0]?.since.toISOString()).toBe(NOW.toISOString());
  });

  it("does not confuse two instances of the same kind", async () => {
    const previous: readonly ComponentHealth[] = [
      { kind: "CHANNEL_ACCOUNT", id: "acct_1", state: "ACTION_REQUIRED", summary: "reconnect needed", since: EARLIER },
    ];

    const components = await collectHealth(
      [probe({ kind: "CHANNEL_ACCOUNT", id: "acct_2", check: () => Promise.resolve({ state: "ACTION_REQUIRED", summary: "reconnect needed" }) })],
      NOW,
      previous,
    );

    // Another account's history is not this account's history.
    expect(components[0]?.since.toISOString()).toBe(NOW.toISOString());
  });
});
