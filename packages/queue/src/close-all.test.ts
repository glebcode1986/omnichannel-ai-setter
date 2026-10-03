/**
 * Closing several clients without killing the process (worker flake, Issue #5's guard).
 *
 * Both properties here were defects that reached production behaviour, and both were invisible in a test
 * suite that closed one client at a time against a reachable Redis.
 */
import { describe, expect, it, vi } from "vitest";

import { closeAll } from "./close-all";

/**
 * A logger and its spies, kept apart.
 *
 * The spies are returned separately rather than read back off the logger: reaching through a typed
 * logger for `warn` is an unbound method access, which the lint rule objects to for the same reason
 * `ProcessGuards` declares its handlers as arrow properties.
 */
const logger = () => {
  const warn = vi.fn();
  const debug = vi.fn();
  const self = { warn, debug, info: vi.fn(), error: vi.fn(), child: () => self };
  return { log: self as unknown as Parameters<typeof closeAll>[3], warn, debug };
};

/** A client whose connection behaves the way BullMQ's does: listeners dropped on close. */
function fakeClient(options: { readonly failOnClose?: boolean; readonly lateError?: boolean } = {}) {
  const listeners = new Map<string, ((error: unknown) => void)[]>();
  const connection = {
    on: (event: string, listener: (error: unknown) => void): void => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    /** What BullMQ's `RedisConnection.close()` does in its `finally`. */
    removeAllListeners: (): void => {
      listeners.clear();
    },
    /** The late `initializing` rejection: emits, and throws when nothing is listening. */
    emitLate: (error: unknown): void => {
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
    close: (): Promise<void> => {
      connection.removeAllListeners();
      return options.failOnClose === true
        ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))
        : Promise.resolve();
    },
  };
}

describe("closing several clients", () => {
  it("observes every failure, not just the first", async () => {
    const { log, warn } = logger();
    const clients = [fakeClient({ failOnClose: true }), fakeClient({ failOnClose: true }), fakeClient({ failOnClose: true })];

    // `Promise.all` was the defect: it settles on the first rejection and leaves the rest unobserved,
    // which Node reports as unhandled rejections and the process guard answers by exiting 1.
    await expect(closeAll("test", clients, (client) => client.close(), log)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("logs a close failure by name only, never the message", async () => {
    const { log, warn } = logger();

    await closeAll("test", [fakeClient({ failOnClose: true })], (client) => client.close(), log);

    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    // The message carries the host and can carry a password, and a shutdown log is read by everyone.
    expect(fields).toEqual({ what: "test", errorName: "Error" });
    expect(JSON.stringify(fields)).not.toContain("127.0.0.1");
  });

  it("leaves a listener behind, so a failure arriving after close is still handled", async () => {
    const { log, debug } = logger();
    const client = fakeClient();

    await closeAll("test", [client], (item) => item.close(), log);

    // Without this, BullMQ's `removeAllListeners()` leaves the connection bare and its late
    // `initializing` rejection emits `error` with nothing listening — which throws inside a `.catch()`
    // and reaches the process guard as an unhandled rejection carrying the original ECONNREFUSED.
    expect(() => client.connection.emitLate(new Error("connect ECONNREFUSED"))).not.toThrow();
    expect(debug).toHaveBeenCalledWith("queue.client_error_after_close", { what: "test", errorName: "Error" });
  });

  it("would throw without that listener, which is what makes the case above a real one", () => {
    const bare = fakeClient();
    bare.connection.removeAllListeners();

    // The counter-test: the fake reproduces the library's behaviour rather than being shaped to pass.
    expect(() => bare.connection.emitLate(new Error("connect ECONNREFUSED"))).toThrow(/ECONNREFUSED/u);
  });

  it("still re-attaches when the close itself failed", async () => {
    const { log } = logger();
    const client = fakeClient({ failOnClose: true });

    await closeAll("test", [client], (item) => item.close(), log);

    // A close that threw is exactly when a connection attempt is most likely still in flight, so the
    // listener goes back in a `finally` rather than after a successful close.
    expect(() => client.connection.emitLate(new Error("late"))).not.toThrow();
  });

  it("closes every client even when one fails", async () => {
    const { log } = logger();
    const closed: string[] = [];
    const clients = ["a", "b", "c"];

    await closeAll(
      "test",
      clients,
      (name) => {
        closed.push(name);
        return name === "a" ? Promise.reject(new Error("first one fails")) : Promise.resolve();
      },
      log,
    );

    expect(closed).toEqual(["a", "b", "c"]);
  });
});
