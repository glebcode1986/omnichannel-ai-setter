import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDir = path.resolve(import.meta.dirname, "..");

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real worker entrypoint in a child process (TypeScript via the tsx loader).
 * `onStdout` may send signals once the expected output has appeared.
 */
function runWorker(
  env: Record<string, string>,
  onStdout?: (stdout: string, child: ReturnType<typeof spawn>) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // `--import tsx` resolves from `cwd`, i.e. this app's own devDependency.
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      onStdout?.(stdout, child);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Real Redis when available; otherwise an unreachable address, which the worker must survive quietly. */
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:1";

/** With Redis unreachable the only permitted stderr entry is the (URL-free) outage warning. */
function expectOnlyRedisOutageOnStderr(stderr: string): void {
  expect(events(stderr).filter((event) => event !== "queue.redis_unavailable")).toEqual([]);
  expect(stderr).not.toContain("127.0.0.1:1");
}

function events(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

describe.skipIf(process.platform === "win32")("worker entrypoint", () => {
  it("starts, then shuts down gracefully with exit code 0 on SIGTERM", async () => {
    let signalled = false;
    const result = await runWorker({ NODE_ENV: "test", LOG_LEVEL: "info", REDIS_URL }, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });

    expectOnlyRedisOutageOnStderr(result.stderr);
    expect(result.code).toBe(0);
    expect(events(result.stdout)).toEqual(["worker.started", "worker.stopping", "worker.stopped"]);
  }, 30_000);

  it("treats a burst of repeated signals (one Ctrl+C relayed by pnpm/watchers) as one graceful shutdown", async () => {
    let signalled = false;
    const result = await runWorker({ NODE_ENV: "test", LOG_LEVEL: "info", REDIS_URL }, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGINT");
        child.kill("SIGINT");
        child.kill("SIGTERM");
      }
    });

    expectOnlyRedisOutageOnStderr(result.stderr);
    expect(result.code).toBe(0);
    expect(events(result.stdout)).toEqual(["worker.started", "worker.stopping", "worker.stopped"]);
  }, 30_000);

  it("keeps running and still shuts down gracefully when its stdout pipe is closed", async () => {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: appDir,
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LOG_LEVEL: "debug", REDIS_URL },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.destroy();
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout: "", stderr }));
      setTimeout(() => child.kill("SIGTERM"), 2_000);
    });

    expect(result.stderr).not.toContain("worker.fatal");
    expect(result.code).toBe(0);
  }, 30_000);

  it("rides out its own Redis being unreachable, and says it survived", async () => {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: appDir,
        // Deliberately unreachable, whatever the environment provides: this test is about the outage.
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LOG_LEVEL: "debug", REDIS_URL: "redis://127.0.0.1:1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      setTimeout(() => child.kill("SIGTERM"), 3_000);
    });

    // The outage is logged and survived; the worker shuts down cleanly when asked to.
    expect(result.stderr).toContain("queue.redis_unavailable");
    expect(result.stderr).not.toContain("worker.fatal");
    expect(result.code).toBe(0);
  }, 30_000);

  it("still dies on an escaped rejection that is not its own Redis reconnecting", async () => {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: appDir,
        env: {
          PATH: process.env.PATH ?? "",
          // A preload that rejects once, with a TypeError carrying no error code. `tsx` comes first so
          // the preload itself can be TypeScript and stay inside this package's project.
          NODE_OPTIONS: "--import tsx --import ./src/testing/escaped-rejection.ts",
          NODE_ENV: "test",
          LOG_LEVEL: "debug",
          REDIS_URL: "redis://127.0.0.1:1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      setTimeout(() => child.kill("SIGTERM"), 5_000);
    });

    // Same unreachable Redis as the test above, so the only difference is where the rejection came from.
    // An unknown cause means unknown state, and the worker stops rather than carrying on.
    expect(result.stderr).toContain("worker.fatal");
    expect(result.stderr).toContain("TypeError");
    expect(result.code).toBe(1);
  }, 30_000);

  it("fails fast with exit code 1 and no value echo when the environment is invalid", async () => {
    const result = await runWorker({ NODE_ENV: "test", LOG_LEVEL: "not-a-level-secret-ish", REDIS_URL });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(events(result.stderr)).toEqual(["worker.env_invalid"]);
    expect(result.stderr).toContain("LOG_LEVEL");
    expect(result.stderr).not.toContain("not-a-level-secret-ish");
  }, 30_000);

  it("requires a Redis URL without echoing an invalid one", async () => {
    const result = await runWorker({ NODE_ENV: "test", LOG_LEVEL: "info", REDIS_URL: "http://user:secret-pass@example.test" });

    expect(result.code).toBe(1);
    expect(events(result.stderr)).toEqual(["worker.env_invalid"]);
    expect(result.stderr).toContain("REDIS_URL");
    expect(result.stderr).not.toContain("secret-pass");
  }, 30_000);
});
