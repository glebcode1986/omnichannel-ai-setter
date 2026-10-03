/**
 * The Instagram token refresh policy (#9).
 *
 * These cases came from `apps/web`, where this policy used to live and where nothing ever called it. They
 * are kept intact because each one is a different wrong answer somebody could give: refreshing a token too
 * young for Meta to accept, taking a working account offline because Meta was briefly unreachable, waiting
 * for a refresh that can never succeed because the token already expired, and writing a new token over a
 * connection that was disconnected while Meta was answering.
 *
 * Meta's own HTTP layer is exercised rather than stubbed — `refreshLongLivedToken` with a fake transport —
 * because "500 with `is_transient`" and "400 with code 190" have to mean different things, and that mapping
 * is not this file's code.
 */
import { refreshLongLivedToken, type InstagramHttpResult } from "@omnichannel/channel-instagram";
import type { InstagramTokenRefreshTarget, StoredCredential } from "@omnichannel/db";
import type { LogFields, Logger } from "@omnichannel/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { refreshInstagramToken, type TokenRefreshDependencies } from "./instagram-token-refresh";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-03-01T12:00:00.000Z");
const TTL_SECONDS = 5_184_000;

const TARGET: InstagramTokenRefreshTarget = {
  workspaceId: "01HWORKSPACE00000000000000",
  businessProfileId: "01HPROFILE000000000000000",
  channelAccountId: "01HACCOUNT000000000000000",
  credentialId: "01HCREDENTIAL0000000000000",
  mintedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 60 * DAY),
};

interface Entry {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

interface Harness {
  deps: TokenRefreshDependencies;
  readonly logs: Entry[];
  readonly requests: string[];
  stored: StoredCredential | undefined;
  rotated: { readonly token: string; readonly expiresAt: Date; readonly mintedAt: Date } | undefined;
  marked: { readonly mintedAt: Date } | undefined;
  rotation: "ROTATED" | "SUPERSEDED";
  /** Runs while Meta is answering, for the interleavings that only exist in that gap. */
  duringRefresh?: () => void;
}

function harness(options: { readonly responses?: readonly InstagramHttpResult[]; readonly at?: Date; readonly credential?: Partial<StoredCredential> }): Harness {
  const logs: Entry[] = [];
  const requests: string[] = [];
  const responses = [...(options.responses ?? [])];
  const at = options.at ?? NOW;

  const state: Harness = {
    logs,
    requests,
    stored: {
      credentialId: TARGET.credentialId,
      token: "IGQVJoriginal",
      expiresAt: new Date(NOW.getTime() + 60 * DAY),
      mintedAt: NOW,
      ...options.credential,
    },
    rotated: undefined,
    marked: undefined,
    rotation: "ROTATED",
    deps: undefined as unknown as TokenRefreshDependencies,
  };

  state.deps = {
    readCredential: () => Promise.resolve(state.stored),
    refresh: (token) =>
      refreshLongLivedToken(
        {
          http: {
            send: (request) => {
              requests.push(request.url);
              state.duringRefresh?.();
              const next = responses.shift();
              return Promise.resolve(next ?? { kind: "NO_RESPONSE", reason: "TIMEOUT", message: "no response configured" });
            },
          },
        },
        token,
      ),
    rotate: (input) => {
      if (state.rotation === "ROTATED") {
        state.rotated = { token: input.token, expiresAt: input.expiresAt, mintedAt: input.refreshedAt };
      }
      return Promise.resolve(state.rotation);
    },
    markNeedsReauthorization: (input) => {
      state.marked = { mintedAt: input.mintedAt };
      return Promise.resolve(true);
    },
    logger: capturing(logs),
    now: () => at,
  };
  return state;
}

/** Captures what was logged rather than how it was rendered: these tests assert on events and fields. */
function capturing(logs: Entry[]): Logger {
  const record = (event: string, fields?: LogFields): void => {
    logs.push({ event, fields });
  };
  return { debug: record, info: record, warn: record, error: record } as unknown as Logger;
}

const response = (status: number, body: unknown): InstagramHttpResult => ({ kind: "RESPONSE", status, body: JSON.stringify(body) });
const refreshed = response(200, { access_token: "IGQVJrefreshed", token_type: "bearer", expires_in: TTL_SECONDS });

describe("refreshing one Instagram token", () => {
  let state: Harness;

  beforeEach(() => {
    state = harness({});
  });

  it("does not call Meta for a token younger than a day", async () => {
    // Meta refuses to refresh one, so asking is a request whose answer we already know.
    state = harness({ at: new Date(NOW.getTime() + 60_000) });

    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("NOT_DUE");
    expect(state.requests).toHaveLength(0);
    expect(state.marked).toBeUndefined();
  });

  it("refreshes an eligible token and extends its expiry", async () => {
    const at = new Date(NOW.getTime() + 2 * DAY);
    state = harness({ responses: [refreshed], at });

    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("REFRESHED");
    expect(state.rotated).toEqual({ token: "IGQVJrefreshed", expiresAt: new Date(at.getTime() + TTL_SECONDS * 1000), mintedAt: at });
    expect(state.logs.map((record) => record.event)).toContain("instagram.token_refreshed");
  });

  it("rotates against the mint time it read, so a refresh that lost a race cannot land", async () => {
    // The guard is the store's, but it can only work if this passes the mint time it actually read rather
    // than the one the sweep's batch carried, which may be minutes old.
    const at = new Date(NOW.getTime() + 2 * DAY);
    state = harness({ responses: [refreshed], at, credential: { mintedAt: new Date(NOW.getTime() + DAY) } });
    let seen: Date | undefined;
    state.deps = {
      ...state.deps,
      rotate: (input: Parameters<TokenRefreshDependencies["rotate"]>[0]) => {
        seen = input.mintedAt;
        return Promise.resolve("ROTATED");
      },
    };

    await refreshInstagramToken(state.deps, TARGET);

    expect(seen).toEqual(new Date(NOW.getTime() + DAY));
    expect(seen).not.toEqual(TARGET.mintedAt);
  });

  it("treats an expired token as re-authorization, not a retry", async () => {
    state = harness({ at: new Date(NOW.getTime() + 61 * DAY) });

    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("NEEDS_REAUTH");
    expect(state.marked).toEqual({ mintedAt: NOW });
    // Nothing was asked of Meta: an expired token is not a request, it is a fact.
    expect(state.requests).toHaveLength(0);
    expect(state.logs.map((record) => record.event)).toContain("instagram.token_expired");
  });

  it("keeps the account connected when Meta is merely unreachable", async () => {
    state = harness({ responses: [{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }], at: new Date(NOW.getTime() + 2 * DAY) });

    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("UNAVAILABLE");
    expect(state.marked).toBeUndefined();
  });

  it("keeps the account connected when Meta is throttling or broken", async () => {
    for (const failure of [response(500, { error: { code: 2, is_transient: true, message: "please retry" } }), response(429, { error: { code: 4, message: "rate limited" } })]) {
      // A failing provider has said nothing about our credential. Treating that as revocation would take a
      // working account offline until somebody re-authorized it by hand.
      state = harness({ responses: [failure], at: new Date(NOW.getTime() + 2 * DAY) });

      expect(await refreshInstagramToken(state.deps, TARGET)).toBe("UNAVAILABLE");
      expect(state.marked).toBeUndefined();
    }
  });

  it("needs re-authorization when Meta rejects the refresh", async () => {
    state = harness({ responses: [response(400, { error: { code: 190, error_subcode: 460, message: "password changed" } })], at: new Date(NOW.getTime() + 2 * DAY) });

    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("NEEDS_REAUTH");
    expect(state.marked).toEqual({ mintedAt: NOW });
    const rejection = state.logs.find((record) => record.event === "instagram.refresh_rejected");
    expect(rejection?.fields).toMatchObject({ reason: "provider_rejected" });
    // Codes only: Meta's prose can quote the request, and the request carries the token.
    expect(JSON.stringify(rejection)).not.toContain("IGQVJ");
  });

  it("drops a token that arrives from Meta after the account was disconnected", async () => {
    // Carried over from the version of this policy that lived in apps/web, where an independent review
    // asked for it. The disconnect lands *while* Meta is answering, so the refresh returns holding a
    // freshly minted token for a connection that no longer exists. Writing it would undo the disconnect
    // and leave a disconnected account with a working secret.
    state = harness({ responses: [refreshed], at: new Date(NOW.getTime() + 2 * DAY) });
    state.duringRefresh = () => {
      state.rotation = "SUPERSEDED";
    };

    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("SUPERSEDED");
    expect(state.rotated).toBeUndefined();
    expect(state.marked).toBeUndefined();
    expect(state.logs.map((record) => record.event)).toContain("instagram.refresh_discarded");
  });

  it("says nothing happened when the credential is gone or has no expiry", async () => {
    state = harness({});
    state.stored = undefined;
    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("NO_CREDENTIAL");

    state = harness({ credential: { expiresAt: null } });
    expect(await refreshInstagramToken(state.deps, TARGET)).toBe("NO_CREDENTIAL");
    expect(state.requests).toHaveLength(0);
  });

  it("never writes a token into a log", async () => {
    for (const at of [new Date(NOW.getTime() + 2 * DAY), new Date(NOW.getTime() + 61 * DAY)]) {
      state = harness({ responses: [refreshed], at });

      await refreshInstagramToken(state.deps, TARGET);

      expect(JSON.stringify(state.logs)).not.toContain("IGQVJ");
    }
  });
});
