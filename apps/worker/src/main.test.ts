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

function events(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

describe.skipIf(process.platform === "win32")("worker entrypoint", () => {
  it("starts, then shuts down gracefully with exit code 0 on SIGTERM", async () => {
    let signalled = false;
    const result = await runWorker({ NODE_ENV: "test", LOG_LEVEL: "info" }, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(events(result.stdout)).toEqual(["worker.started", "worker.stopping", "worker.stopped"]);
  }, 30_000);

  it("fails fast with exit code 1 and no value echo when the environment is invalid", async () => {
    const result = await runWorker({ NODE_ENV: "test", LOG_LEVEL: "not-a-level-secret-ish" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(events(result.stderr)).toEqual(["worker.env_invalid"]);
    expect(result.stderr).toContain("LOG_LEVEL");
    expect(result.stderr).not.toContain("not-a-level-secret-ish");
  }, 30_000);
});
