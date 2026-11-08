import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { unexpectedStderrEvents } from "./testing/permitted-stderr";

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
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://user:fake-password@127.0.0.1:1/omnichannel";
/** The worker now needs a model key to start; no request is made unless a draft job runs. */
const ANTHROPIC_API_KEY = "sk-ant-fake-key-for-tests";

/**
 * Everything the worker requires to boot, in one place.
 *
 * A branch that makes a new variable required extends this rather than each call site: these tests spawn
 * the real entrypoint, so a missing variable fails them all with `worker.env_invalid` and says nothing
 * about what they were actually checking.
 */
const VALID_ENV: Readonly<Record<string, string>> = { NODE_ENV: "test", LOG_LEVEL: "info", REDIS_URL, DATABASE_URL, ANTHROPIC_API_KEY };

/**
 * Nothing on stderr but the five events `testing/permitted-stderr.ts` allows, and never the URL.
 *
 * The list lives there rather than here because `bundle.test.ts` asserts the same thing about the same
 * process, and kept its own copy of it — four of the five — so a documented, expected outcome failed the
 * build on a loaded machine.
 */
function expectNoUnexpectedStderr(stderr: string): void {
  expect(unexpectedStderrEvents(stderr)).toEqual([]);
  expect(stderr).not.toContain("127.0.0.1:1");
}

/**
 * Everything the worker says on stdout from a clean boot to a clean stop.
 *
 * The retrieval, presence and transcription modes are stated before `worker.started`, so an operator
 * reading the log from the top can see what this process can do without waiting for a customer question.
 */
const GRACEFUL_LIFECYCLE = [
  "worker.retrieval_mode",
  "worker.transcription_mode",
  "worker.presence_mode",
  "worker.started",
  "worker.stopping",
  "worker.stopped",
] as const;

/** A graceful stop: exit code 0, nothing unexpected on stderr, and exactly `expected` on stdout. */
function expectGracefulShutdown(result: ProcessResult, expected: readonly string[] = GRACEFUL_LIFECYCLE): void {
  expectNoUnexpectedStderr(result.stderr);
  expect(result.code).toBe(0);
  expect(events(result.stdout)).toEqual(expected);
}

/** The fields on the one `worker.started` line, so a test can assert on what the process reported. */
function startedFields(stdout: string): { readonly loops?: readonly string[] } {
  const line = stdout
    .split("\n")
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => JSON.parse(entry) as { event: string; loops?: readonly string[] })
    .find((entry) => entry.event === "worker.started");
  if (line === undefined) {
    throw new Error("the worker never reported that it started");
  }
  return line;
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
    const result = await runWorker({ ...VALID_ENV }, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });

    expectGracefulShutdown(result);
  }, 30_000);

  it("treats a burst of repeated signals (one Ctrl+C relayed by pnpm/watchers) as one graceful shutdown", async () => {
    let signalled = false;
    const result = await runWorker({ ...VALID_ENV }, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGINT");
        child.kill("SIGINT");
        child.kill("SIGTERM");
      }
    });

    expectGracefulShutdown(result);
  }, 30_000);

  it("says which background loops are running, so a loop wired to nothing is visible (#9)", async () => {
    // The defect this guards: the Instagram token refresh existed, was tested, and was called by nothing.
    // No unit test can catch that — the policy passes its own tests either way — so the entrypoint reports
    // what it actually started and this reads the real process's boot log.
    const configured = { ...VALID_ENV, CHANNEL_CREDENTIAL_KEY_ID: "test-key", CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64") };
    let signalled = false;
    const result = await runWorker(configured, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });

    expectGracefulShutdown(result);
    // `follow_ups` joined the list with the accepted P3-02 head, which starts the sweeper that gave
    // `dueFollowUps` and `claimFollowUp` their first caller — the same defect this case guards, in a
    // second loop. `retention` joins it with P3-04, which sweeps the short-lived rows nothing else
    // removes, and `usage_reservations` with P6-02, which releases holds nothing else would. Asserted
    // as the whole list rather than by `toContain`, because the point is that nothing is missing from
    // it, and the order is the order `main.ts` reports them in.
    expect(startedFields(result.stdout).loops).toEqual([
      "outbox",
      "reconciliation",
      // `delivery_recovery` joins it with Issue #125, and this assertion is why: the loop is the only
      // thing that repairs a reply approved before the web-to-queue bridge existed, and a recovery loop
      // wired to nothing would be indistinguishable from a database with nothing to repair.
      "delivery_recovery",
      "retention",
      "usage_reservations",
      "checkout_expiry",
      "instagram_tokens",
      "follow_ups",
      "backlog_guard",
      "health",
    ]);
  }, 30_000);

  it("leaves the token refresh out of that list when it cannot read the stored tokens", async () => {
    // Without the credential-encryption key there is nothing to decrypt, so the loop does not run — and
    // the boot log has to say so rather than listing work that is not happening.
    let signalled = false;
    const result = await runWorker({ ...VALID_ENV }, (stdout, child) => {
      if (!signalled && stdout.includes('"event":"worker.started"')) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });

    expectGracefulShutdown(result);
    expect(startedFields(result.stdout).loops).not.toContain("instagram_tokens");
    // And the unconditional loops are still reported, which is the whole difference between them and
    // `instagram_tokens`: these sweepers always start, so an absence here would be a defect rather than a
    // configuration. All three are asserted — `retention` joined them with P3-04 and
    // `usage_reservations` with P6-02 — because a loop that is only checked in the fully-configured case
    // above is a loop this case would not notice losing.
    expect(startedFields(result.stdout).loops).toContain("follow_ups");
    expect(startedFields(result.stdout).loops).toContain("retention");
    expect(startedFields(result.stdout).loops).toContain("usage_reservations");
    expect(startedFields(result.stdout).loops).toContain("checkout_expiry");
  }, 30_000);

  /*
   * Two cases, because the one they replaced raced its own subject.
   *
   * It destroyed stdout at spawn and then sent SIGTERM on a **fixed two-second timer**. Every other test
   * here waits for `"worker.started"` before signalling; this one could not, having thrown stdout away,
   * so it guessed. `main.ts` installs the shutdown handlers immediately before `runtime.start()` logs
   * that line — so a SIGTERM that arrives first meets no handler and Node's default action terminates
   * the process. The assertion then reads `code: null`, a process killed by a signal, and calls it a
   * failed graceful shutdown. Booting through `tsx` takes longer than two seconds on a loaded machine,
   * which is exactly when this suite runs, and it failed here twice.
   *
   * Neither case below contains a clock.
   */
  it("boots with a closed stdout pipe and does not die of it", async () => {
    // A write to a destroyed pipe is an `EPIPE` on the first log line. Getting as far as the delivery
    // engine's own boot warning — which goes to stderr — is the proof that it did not.
    const outcome = await new Promise<{ readonly booted: boolean; readonly stderr: string; readonly child: ReturnType<typeof spawn> }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
          cwd: appDir,
          env: { PATH: process.env.PATH ?? "", ...VALID_ENV, LOG_LEVEL: "debug" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stdout.destroy();
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.includes('"event":"worker.no_channel_adapter"')) {
            resolve({ booted: true, stderr, child });
          }
        });
        child.on("error", reject);
        // Whichever happens first. Dying before that line is the failure this case is about, and it
        // resolves rather than hangs so the assertion below is what reports it.
        child.on("close", () => {
          resolve({ booted: false, stderr, child });
        });
      },
    );

    expect(outcome.booted, "it got through boot with nothing to write to").toBe(true);
    expect(outcome.stderr).not.toContain("worker.fatal");
    // No graceful claim is made here, so nothing is signalled: SIGKILL only releases the process.
    outcome.child.kill("SIGKILL");
  }, 30_000);

  it("still shuts down gracefully when its stdout pipe is closed", async () => {
    // Keyed to `worker.started`, which is logged immediately *after* the shutdown handlers are installed,
    // so the signal below cannot arrive before something is listening for it. stdout is destroyed the
    // moment that line is read — which is what the shutdown sequence then fails to write to.
    const result = await runWorker({ ...VALID_ENV, LOG_LEVEL: "debug" }, (stdout, child) => {
      // `child.stdout` is typed nullable because a `spawn` can be configured without the pipe; this one
      // is not, and the callback only runs on data from it.
      const pipe = child.stdout;
      if (pipe !== null && !pipe.destroyed && stdout.includes('"event":"worker.started"')) {
        pipe.destroy();
        child.kill("SIGTERM");
      }
    });

    expect(result.stderr).not.toContain("worker.fatal");
    expect(result.code, "a signal-killed process reports a null code, which is what the fixed timer used to produce").toBe(0);
  }, 30_000);

  it("rides out its own Redis being unreachable, and says it survived", async () => {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: appDir,
        // Deliberately unreachable, whatever the environment provides: this test is about the outage.
        env: { PATH: process.env.PATH ?? "", ...VALID_ENV, LOG_LEVEL: "debug", REDIS_URL: "redis://127.0.0.1:1" },
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
    // And every queue client that failed said so. This is the assertion the earlier version of this
    // suite was missing: an unowned client error is invisible right up to the moment it ends the
    // process, so "the outage was survived" has to include "each client reported it".
    expect(result.stderr).toContain("queue.client_error");
    expect(result.stderr).not.toContain("127.0.0.1:1");
    expect(result.stderr).not.toContain("worker.fatal");
    expect(result.code).toBe(0);
  }, 30_000);

  it("reports — and survives — a handle that outlives its own shutdown", async () => {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: appDir,
        env: {
          PATH: process.env.PATH ?? "",
          // A preload that holds the event loop open forever, the way a library's un-closed socket or
          // child process does. `tsx` comes first so the preload can be TypeScript inside this project.
          NODE_OPTIONS: "--import tsx --import ./src/testing/lingering-handle.ts",
          ...VALID_ENV,
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
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });

    // Everything the worker owns closed, so this is not a failed shutdown: it exits successfully and
    // names what happened. Reporting failure here tells a supervisor a clean stop was a crash.
    expect(result.code).toBe(0);
    expect(events(result.stdout)).toEqual(GRACEFUL_LIFECYCLE);
    expect(result.stderr).toContain('"event":"worker.lingering_after_stop"');
    expect(result.stderr).toContain('"trigger":"deadline"');
    expect(result.stderr).not.toContain("worker.shutdown_timeout");
  }, 40_000);

  it("still dies on an escaped rejection carrying Redis's own error code from another source", async () => {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: appDir,
        env: {
          PATH: process.env.PATH ?? "",
          // A preload that rejects once, with `ECONNREFUSED` — the same code a reconnecting Redis client
          // produces, from a source that has nothing to do with Redis. `tsx` comes first so the preload
          // itself can be TypeScript and stay inside this package's project.
          NODE_OPTIONS: "--import tsx --import ./src/testing/escaped-rejection.ts",
          ...VALID_ENV,
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

    // Same unreachable Redis as the test above, and now the same error code as well, so the only
    // difference left is the source — which nothing at the process level can see. An unknown cause means
    // unknown state, and the worker stops rather than carrying on.
    expect(result.stderr).toContain("worker.fatal");
    expect(result.stderr).toContain("TypeError");
    expect(result.code).toBe(1);
  }, 30_000);

  it("fails fast with exit code 1 and no value echo when the environment is invalid", async () => {
    const result = await runWorker({ ...VALID_ENV, LOG_LEVEL: "not-a-level-secret-ish" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(events(result.stderr)).toEqual(["worker.env_invalid"]);
    expect(result.stderr).toContain("LOG_LEVEL");
    expect(result.stderr).not.toContain("not-a-level-secret-ish");
  }, 30_000);

  it("requires a Redis URL without echoing an invalid one", async () => {
    const result = await runWorker({ ...VALID_ENV, REDIS_URL: "http://user:secret-pass@example.test" });

    expect(result.code).toBe(1);
    expect(events(result.stderr)).toEqual(["worker.env_invalid"]);
    expect(result.stderr).toContain("REDIS_URL");
    expect(result.stderr).not.toContain("secret-pass");
  }, 30_000);
});
