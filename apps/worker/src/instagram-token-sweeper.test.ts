/**
 * The loop that walks the connections (#9).
 *
 * The policy has its own tests; this file is about the loop's two duties. It must ask the database for the
 * right window — tokens expiring within the horizon, not tokens that already expired — and it must finish
 * the batch. A sweep that stops at the first account whose provider is unreachable leaves every account
 * after it in the list unrefreshed, and with a 60-day term that is how a connection dies quietly.
 */
import type { InstagramTokenRefreshTarget } from "@omnichannel/db";
import type { LogFields, Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import type { TokenRefreshDependencies } from "./instagram-token-refresh";
import { startInstagramTokenRefresh, startInstagramTokenSweeper } from "./instagram-token-sweeper";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

interface Entry {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

function capturing(logs: Entry[]): Logger {
  const record = (event: string, fields?: LogFields): void => {
    logs.push({ event, fields });
  };
  return { debug: record, info: record, warn: record, error: record } as unknown as Logger;
}

const target = (index: number): InstagramTokenRefreshTarget => ({
  workspaceId: `01HWORKSPACE0000000000000${index}`,
  businessProfileId: `01HPROFILE00000000000000${index}`,
  channelAccountId: `01HACCOUNT00000000000000${index}`,
  credentialId: `01HCREDENTIAL00000000000${index}`,
  mintedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3 * DAY),
});

/** A refresh that reports whatever each account was scripted to do. */
function scripted(outcomes: ReadonlyMap<string, "REFRESHED" | "NOT_DUE" | "NEEDS_REAUTH" | "throw">): TokenRefreshDependencies {
  return {
    readCredential: (asked) => {
      const outcome = outcomes.get(asked.channelAccountId);
      if (outcome === "throw") {
        return Promise.reject(new TypeError("credential could not be decrypted"));
      }
      if (outcome === "NOT_DUE") {
        // Minted a moment ago: the policy declines without asking Meta.
        return Promise.resolve({ credentialId: asked.credentialId, token: "IGQVJ", expiresAt: new Date(NOW.getTime() + 3 * DAY), mintedAt: NOW });
      }
      if (outcome === "NEEDS_REAUTH") {
        return Promise.resolve({ credentialId: asked.credentialId, token: "IGQVJ", expiresAt: new Date(NOW.getTime() - DAY), mintedAt: new Date(NOW.getTime() - 61 * DAY) });
      }
      return Promise.resolve({ credentialId: asked.credentialId, token: "IGQVJ", expiresAt: new Date(NOW.getTime() + 3 * DAY), mintedAt: new Date(NOW.getTime() - 2 * DAY) });
    },
    refresh: () => Promise.resolve({ ok: true, value: { accessToken: "IGQVJnew", expiresInSeconds: 5_184_000 } }),
    rotate: () => Promise.resolve("ROTATED"),
    markNeedsReauthorization: () => Promise.resolve(true),
    logger: capturing([]),
    now: () => NOW,
  };
}

describe("sweeping Instagram connections", () => {
  it("asks for tokens expiring within the horizon, not ones that already expired", async () => {
    const asked: { dueBefore: Date; limit: number }[] = [];
    const loop = startInstagramTokenSweeper({
      intervalMs: 1,
      horizonMs: 14 * DAY,
      limit: 25,
      findDue: (options) => {
        asked.push(options);
        return Promise.resolve([]);
      },
      refresh: scripted(new Map()),
      logger: capturing([]),
      now: () => NOW,
    });

    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await loop.close();

    // Fourteen days *ahead*: a token is refreshed while it still works, because once it has expired Meta
    // will not refresh it and only a person can fix it.
    expect(asked[0]).toEqual({ dueBefore: new Date(NOW.getTime() + 14 * DAY), limit: 25 });
  });

  it("says nothing when there is nothing to do", async () => {
    const logs: Entry[] = [];
    let ticks = 0;
    const loop = startInstagramTokenSweeper({
      intervalMs: 1,
      horizonMs: DAY,
      limit: 10,
      findDue: () => {
        ticks += 1;
        return Promise.resolve([]);
      },
      refresh: scripted(new Map()),
      logger: capturing(logs),
      now: () => NOW,
    });

    await vi.waitFor(() => expect(ticks).toBeGreaterThan(1));
    await loop.close();

    // An idle loop that logged every interval would bury the sweeps that did something.
    expect(logs).toEqual([]);
  });

  it("finishes the batch when one account fails, and counts what happened", async () => {
    const logs: Entry[] = [];
    const due = [target(1), target(2), target(3), target(4)];
    let served = false;
    const loop = startInstagramTokenSweeper({
      intervalMs: 1,
      horizonMs: 14 * DAY,
      limit: 10,
      // Once: a second sweep of the same rows would double the counts this test is reading.
      findDue: () => {
        const batch = served ? [] : due;
        served = true;
        return Promise.resolve(batch);
      },
      refresh: scripted(
        new Map([
          [due[0]!.channelAccountId, "REFRESHED" as const],
          [due[1]!.channelAccountId, "throw" as const],
          [due[2]!.channelAccountId, "NEEDS_REAUTH" as const],
          [due[3]!.channelAccountId, "NOT_DUE" as const],
        ]),
      ),
      logger: capturing(logs),
      now: () => NOW,
    });

    const swept = await vi.waitFor(() => {
      const entry = logs.find((record) => record.event === "worker.instagram_tokens_swept");
      expect(entry).toBeDefined();
      return entry!;
    });
    await loop.close();

    // The account that threw is counted and named, and the two after it were still attempted.
    expect(swept.fields).toMatchObject({ found: 4, refreshed: 1, failed: 1, needs_reauth: 1, not_due: 1 });
    const failure = logs.find((record) => record.event === "worker.instagram_token_refresh_failed");
    expect(failure?.fields).toMatchObject({ channelAccountId: due[1]!.channelAccountId, errorName: "TypeError" });
  });

  it("reports that it is not running when the credential key is not configured", async () => {
    const logs: Entry[] = [];

    // No `CHANNEL_CREDENTIAL_KEY`: the stored tokens cannot be decrypted, so there is no refresh to run.
    // `running: false` is what has to be true here — the worker's boot log lists the loops that are
    // actually running, and a silent no-op that claimed otherwise would be the original defect in a hat.
    const loop = startInstagramTokenRefresh({ CHANNEL_CREDENTIAL_KEY_ID: undefined, CHANNEL_CREDENTIAL_KEY: undefined }, {} as never, capturing(logs));
    await loop.close();

    expect(loop.running).toBe(false);
    expect(logs).toEqual([{ event: "worker.no_token_refresh", fields: { reason: "credential-encryption configuration is missing" } }]);
  });

  it("reports that it is running once the key is there", async () => {
    const logs: Entry[] = [];

    const loop = startInstagramTokenRefresh(
      { CHANNEL_CREDENTIAL_KEY_ID: "k1", CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 3).toString("base64") },
      {} as never,
      capturing(logs),
      // Far enough out that the loop never ticks during the test: this is about what it reports at boot.
      { intervalMs: 3_600_000 },
    );
    await loop.close();

    expect(loop.running).toBe(true);
    expect(logs).toEqual([]);
  });
});
