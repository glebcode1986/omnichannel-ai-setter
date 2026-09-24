import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createShutdownSequence } from "./shutdown";
import type { WorkerRuntime } from "./worker-runtime";

const TIMEOUT_MS = 10_000;
const DUPLICATE_WINDOW_MS = 2_000;

function harness(options: { stop?: () => Promise<void> } = {}) {
  const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  /** The level is part of what is asserted: it decides the stream, and so what a human ever sees. */
  const record = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    events.push({ level, event, fields: { ...fields } });
  };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    child: vi.fn(),
  } as unknown as Logger;

  const exits: number[] = [];
  const exitCodes: number[] = [];
  let clock = 0;
  let state: WorkerRuntime["state"] = "running";
  let deadline: (() => void) | undefined;
  let settle!: (outcome: "ok" | "fail") => void;

  const stopping = new Promise<void>((resolve, reject) => {
    settle = (outcome) => {
      state = outcome === "ok" ? "stopped" : "running";
      if (outcome === "ok") {
        resolve();
      } else {
        reject(Object.assign(new Error("connect ECONNREFUSED redis://user:hunter2@10.0.0.4:6379"), { name: "AggregateError" }));
      }
    };
  });

  const onSignal = createShutdownSequence({
    runtime: {
      get state() {
        return state;
      },
      stop: options.stop ?? (() => stopping),
    },
    logger,
    exit: (code) => exits.push(code),
    setExitCode: (code) => exitCodes.push(code),
    now: () => clock,
    schedule: (_ms, run) => {
      deadline = run;
    },
    timeoutMs: TIMEOUT_MS,
    duplicateWindowMs: DUPLICATE_WINDOW_MS,
  });

  return {
    onSignal,
    events,
    exits,
    exitCodes,
    advance: (ms: number) => {
      clock += ms;
    },
    fireDeadline: () => deadline?.(),
    finishStop: async (outcome: "ok" | "fail" = "ok") => {
      settle(outcome);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("shutting down on a signal", () => {
  it("collapses the repeats one Ctrl+C produces into a single request", () => {
    const { onSignal, events, exits } = harness();

    onSignal("SIGINT");
    onSignal("SIGINT");
    onSignal("SIGINT");

    // The terminal's process group and every relay deliver their own copy within milliseconds.
    expect(events.filter((entry) => entry.event === "worker.duplicate_signal_ignored")).toHaveLength(2);
    expect(exits).toEqual([]);
  });

  it("lets the event loop drain rather than exiting the moment the close returns", async () => {
    const { onSignal, exits, exitCodes, finishStop } = harness();

    onSignal("SIGTERM");
    await finishStop("ok");

    // A hard exit here would cut off a final log line or a socket's last write.
    expect(exitCodes).toEqual([0]);
    expect(exits).toEqual([]);
  });

  it("stops and reports failure when the deadline finds the close unfinished", () => {
    const { onSignal, events, exits, fireDeadline } = harness();

    onSignal("SIGTERM");
    fireDeadline();

    expect(exits).toEqual([1]);
    expect(events[0]).toMatchObject({ level: "error", event: "worker.shutdown_timeout", fields: { state: "running" } });
  });

  it("does not call a finished shutdown a failure just because a handle outlived it", async () => {
    const { onSignal, events, exits, fireDeadline, finishStop } = harness();

    onSignal("SIGTERM");
    await finishStop("ok");
    // Everything closed, and the process is still here: some library kept a socket or a child process.
    fireDeadline();

    // The work is done. A supervisor that restarts on a non-zero code must not be told otherwise, and a
    // real timeout must not be hidden behind this noise.
    expect(exits).toEqual([0]);
    expect(events.map((entry) => entry.event)).toEqual(["worker.lingering_after_stop"]);
    // Reported, not silent: a process its own deadline had to kill is abnormal even when nothing was lost.
    expect(events[0]).toMatchObject({ level: "warn", fields: { trigger: "deadline" } });
  });

  it("treats a deliberate second signal the same way, by what actually happened", async () => {
    const lingering = harness();
    lingering.onSignal("SIGTERM");
    await lingering.finishStop("ok");
    lingering.advance(DUPLICATE_WINDOW_MS + 1);
    lingering.onSignal("SIGTERM");

    // Asked twice after a clean close: the operator wants it gone, not a failure recorded.
    expect(lingering.exits).toEqual([0]);
    expect(lingering.events.at(-1)).toMatchObject({
      level: "warn",
      event: "worker.lingering_after_stop",
      fields: { trigger: "signal" },
    });

    const stuck = harness();
    stuck.onSignal("SIGTERM");
    stuck.advance(DUPLICATE_WINDOW_MS + 1);
    stuck.onSignal("SIGTERM");

    // Asked twice while still closing: forced, and it says so.
    expect(stuck.exits).toEqual([1]);
    expect(stuck.events.at(-1)).toMatchObject({ event: "worker.forced_exit", fields: { state: "running" } });
  });

  it("never writes the failure's own error into the log", async () => {
    const { onSignal, events, exits, finishStop } = harness();

    onSignal("SIGTERM");
    await finishStop("fail");

    expect(exits).toEqual([1]);
    const written = JSON.stringify(events);
    // A close failure is almost always a connection error, and its message carries the host and password.
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("10.0.0.4");
    expect(events.at(-1)).toMatchObject({ event: "worker.shutdown_failed", fields: { errorName: "AggregateError" } });
  });
});
