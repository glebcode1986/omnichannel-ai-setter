import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bundleWorker } from "../bundle";

const appDir = path.resolve(import.meta.dirname, "..");
// Inside apps/worker/node_modules so externalized dependencies resolve exactly as they do from dist/.
const outDir = path.join(appDir, "node_modules", ".cache", "worker-bundle-test");

describe.skipIf(process.platform === "win32")("production bundle", () => {
  it("builds and runs under plain node, shutting down gracefully on SIGTERM", async () => {
    const outfile = await bundleWorker({ outDir, logLevel: "silent" });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [outfile], {
        cwd: appDir,
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", LOG_LEVEL: "info" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let signalled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!signalled && stdout.includes('"event":"worker.started"')) {
          signalled = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"event":"worker.stopped"');
  }, 60_000);
});
