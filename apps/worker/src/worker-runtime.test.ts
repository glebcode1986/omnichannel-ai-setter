import { createLogger, type LogLevel } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createWorkerRuntime } from "./worker-runtime";

function createTestRuntime() {
  const events: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (line: string, _level: LogLevel) => {
      events.push((JSON.parse(line) as { event: string }).event);
    },
  });
  return { runtime: createWorkerRuntime({ logger }), events };
}

describe("createWorkerRuntime", () => {
  it("moves idle -> running -> stopped and logs lifecycle events", async () => {
    const { runtime, events } = createTestRuntime();
    expect(runtime.state).toBe("idle");

    runtime.start();
    expect(runtime.state).toBe("running");

    await runtime.stop("test");
    expect(runtime.state).toBe("stopped");
    expect(events).toEqual(["worker.started", "worker.stopping", "worker.stopped"]);
  });

  it("shares a single shutdown across repeated stop calls", async () => {
    const { runtime, events } = createTestRuntime();
    runtime.start();

    const first = runtime.stop("SIGTERM");
    const second = runtime.stop("SIGINT");

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(events.filter((event) => event === "worker.stopped")).toHaveLength(1);
  });

  it("starts processors on start and waits for them to close before stopping", async () => {
    const order: string[] = [];
    const events: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (line: string) => {
        events.push((JSON.parse(line) as { event: string }).event);
      },
    });
    let releaseClose: () => void = () => undefined;
    const runtime = createWorkerRuntime({
      logger,
      startProcessors: () => {
        order.push("processors.started");
        return {
          queueNames: ["delivery"],
          loops: ["outbox"],
          close: () =>
            new Promise<void>((resolve) => {
              order.push("processors.closing");
              releaseClose = () => {
                order.push("processors.closed");
                resolve();
              };
            }),
        };
      },
    });

    runtime.start();
    const stopped = runtime.stop("SIGTERM");
    await vi.waitFor(() => expect(order).toContain("processors.closing"));
    expect(runtime.state).toBe("stopping");
    releaseClose();
    await stopped;

    expect(order).toEqual(["processors.started", "processors.closing", "processors.closed"]);
    expect(runtime.state).toBe("stopped");
    expect(events).toEqual(["worker.started", "worker.stopping", "worker.stopped"]);
  });

  it("refuses to start twice or restart after stopping", async () => {
    const { runtime } = createTestRuntime();
    runtime.start();
    expect(() => runtime.start()).toThrow(/cannot start/);

    await runtime.stop("test");
    expect(() => runtime.start()).toThrow(/cannot start/);
  });
});
