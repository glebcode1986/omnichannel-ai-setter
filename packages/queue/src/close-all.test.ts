/**
 * Closing several clients without killing the process (worker flake, Issue #5's guard).
 *
 * Both properties here were defects that reached production behaviour, and both were invisible in a test
 * suite that closed one client at a time against a reachable Redis.
 */
import { describe, expect, it, vi } from "vitest";

import { closeAll } from "./close-all";

const logger = () => {
  const warn = vi.fn();
  const debug = vi.fn();
  const self = { warn, debug, info: vi.fn(), error: vi.fn(), child: () => self };
  return self as unknown as Parameters<typeof closeAll>[3] & { warn: typeof warn; debug: typeof debug };
};

/** A client whose connection behaves the way BullMQ's does: listeners dropped on close. */
function fakeClient(options: { readonly failOnClose?: boolean; readonly lateError?: boolean } = {}) {
  const listeners = new Map<string, ((error: unknown) => void)[]>();
  const connection = {
    on(event: string, listener: (error: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    /** What BullMQ's `RedisConnection.close()` does in its `finally`. */
    removeAllListeners() {
      listeners.clear();
    },
    /** The late `initializing` rejection: emits, and throws when nothing is listening. */
    emitLate(error: unknown) {
      const handlers = listeners.get("error") ?? [];
      if (handlers.length === 0) {
        throw error;
      }
      for (const handler of handlers) {
        handler(error);
      }
    },
  };
  // BullMQ's own forwarding, installed at construction and removed at close.
  connection.on("error", () => undefined);
  return {
    connection,
    async close() {
      connection.removeAllListeners();
      if (options.failOnClose === true) {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
      }
    },
  };
}

describe("closing several clients", () => {
  it("observes every failure, not just the first", async () => {
    const log = logger();
    const clients = [fakeClient({ failOnClose: true }), fakeClient({ failOnClose: true }), fakeClient({ failOnClose: true })];

    // `Promise.all` was the defect: it settles on the first rejection and leaves the rest unobserved,
    // which Node reports as unhandled rejections and the process guard answers by exiting 1.
    await expect(closeAll("test", clients, async (client) => client.close(), log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it("logs a close failure by name only, never the message", async () => {
    const log = logger();

    await closeAll("test", [fakeClient({ failOnClose: true })], async (client) => client.close(), log);

    const [, fields] = log.warn.mock.calls[0] as [string, Record<string, unknown>];
    // The message carries the host and can carry a password, and a shutdown log is read by everyone.
    expect(fields).toEqual({ what: "test", errorName: "Error" });
    expect(JSON.stringify(fields)).not.toContain("127.0.0.1");
  });

  it("leaves a listener behind, so a failure arriving after close is still handled", async () => {
    const log = logger();
    const client = fakeClient();

    await closeAll("test", [client], async (item) => item.close(), log);

    // Without this, BullMQ's `removeAllListeners()` leaves the connection bare and its late
    // `initializing` rejection emits `error` with nothing listening — which throws inside a `.catch()`
    // and reaches the process guard as an unhandled rejection carrying the original ECONNREFUSED.
    expect(() => client.connection.emitLate(new Error("connect ECONNREFUSED"))).not.toThrow();
    expect(log.debug).toHaveBeenCalledWith("queue.client_error_after_close", { what: "test", errorName: "Error" });
  });

  it("would throw without that listener, which is what makes the case above a real one", () => {
    const bare = fakeClient();
    bare.connection.removeAllListeners();

    // The counter-test: the fake reproduces the library's behaviour rather than being shaped to pass.
    expect(() => bare.connection.emitLate(new Error("connect ECONNREFUSED"))).toThrow(/ECONNREFUSED/u);
  });

  it("still re-attaches when the close itself failed", async () => {
    const log = logger();
    const client = fakeClient({ failOnClose: true });

    await closeAll("test", [client], async (item) => item.close(), log);

    // A close that threw is exactly when a connection attempt is most likely still in flight, so the
    // listener goes back in a `finally` rather than after a successful close.
    expect(() => client.connection.emitLate(new Error("late"))).not.toThrow();
  });

  it("closes every client even when one fails", async () => {
    const log = logger();
    const closed: string[] = [];
    const clients = ["a", "b", "c"];

    await closeAll(
      "test",
      clients,
      async (name) => {
        closed.push(name);
        if (name === "a") {
          throw new Error("first one fails");
        }
      },
      log,
    );

    expect(closed).toEqual(["a", "b", "c"]);
  });
});
