import { createLogger, type LogLevel } from "@omnichannel/observability";
import { describe, expect, it } from "vitest";

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

  it("refuses to start twice or restart after stopping", async () => {
    const { runtime } = createTestRuntime();
    runtime.start();
    expect(() => runtime.start()).toThrow(/cannot start/);

    await runtime.stop("test");
    expect(() => runtime.start()).toThrow(/cannot start/);
  });
});
