import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bundleWorker } from "../bundle";

const appDir = path.resolve(import.meta.dirname, "..");
// Inside apps/worker/node_modules so externalized dependencies resolve exactly as they do from dist/.
const outDir = path.join(appDir, "node_modules", ".cache", "worker-bundle-test");

/**
 * Boot-time warnings this run legitimately produces: no Redis, no Meta app credentials, and no
 * credential-encryption key — so no stored access token can be decrypted and no recording fetched.
 *
 * `queue.client_error` is each queue client reporting that failure in its own right — name and code,
 * never the URL, once per queue family. The monitor used to drop it instead, which is what ended the
 * process during an outage it was supposed to ride out, so it belongs on this list.
 */
const EXPECTED_STARTUP_WARNINGS = ["queue.redis_unavailable", "queue.client_error", "worker.no_channel_adapter", "worker.no_media_port"];
/** Whatever this environment provides, the log must never echo it back. */
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:1";

describe.skipIf(process.platform === "win32")("production bundle", () => {
  it("builds and runs under plain node, shutting down gracefully on SIGTERM", async () => {
    const outfile = await bundleWorker({ outDir, logLevel: "silent" });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [outfile], {
        cwd: appDir,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          REDIS_URL,
          DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://user:fake-password@127.0.0.1:1/omnichannel",
          ANTHROPIC_API_KEY: "sk-ant-fake-key-for-tests",
        },
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

    // Without a reachable Redis, without Meta app credentials and without a credential key, the only
    // stderr entries allowed are the URL-free outage warning and the worker saying what it cannot do —
    // which it should say at boot rather than discover on the first customer message.
    for (const line of result.stderr.split("\n").filter((entry) => entry.trim().length > 0)) {
      expect(EXPECTED_STARTUP_WARNINGS).toContain((JSON.parse(line) as { event: string }).event);
    }
    // The list above admits a connection error, so this is what keeps it from admitting a leak with it:
    // a connection error's own message carries the host and can carry a password.
    expect(result.stderr).not.toContain(REDIS_URL);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"event":"worker.stopped"');
  }, 60_000);
});
