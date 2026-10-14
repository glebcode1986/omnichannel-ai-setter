import { createHash } from "node:crypto";

import { INSTAGRAM_CAPABILITIES, type InstagramOAuthConfig } from "@omnichannel/channel-instagram";
import { TenantRecordNotFoundError, type BusinessProfileContext, type InstagramOnboardingStore } from "@omnichannel/db";
import { createLogger } from "@omnichannel/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeInstagramConnect,
  CONNECT_STATE_TTL_MS,
  disconnectInstagramAccount,
  startInstagramConnect,
  STATE_COOKIE_NAME,
  type OnboardingDependencies,
} from "./instagram-onboarding";
import {
  createInstagramCallbackHandler,
  createInstagramConnectHandler,
  createInstagramDisconnectHandler,
  type InstagramRouteDependencies,
} from "./instagram-routes";
import { UnauthenticatedError } from "./workspace-context";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const CODE = "AQD-authorization-code";
const SHORT_LIVED = "IGQVJshort-lived-secret";
const LONG_LIVED = "IGQVJlong-lived-secret";
const APP_SECRET = "meta-app-secret";
const IG_USER_ID = "17841400000000001";
const context = (overrides: Partial<{ workspaceId: string; businessProfileId: string; userId: string }> = {}) =>
  ({
    workspaceId: overrides.workspaceId ?? "ws_1",
    businessProfileId: overrides.businessProfileId ?? "bp_1",
    userId: overrides.userId ?? "user_1",
    workspaceMemberId: "member_1",
    role: "OWNER",
  }) as unknown as BusinessProfileContext;

/** In-memory stand-in for the persistence port, so the flow is tested without a database. */
interface FakeState {
  workspaceId: string;
  businessProfileId: string;
  userId: string;
  channel: string;
  nonceHash: Uint8Array;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface FakeAccount {
  id: string;
  workspaceId: string;
  businessProfileId: string;
  externalAccountId: string;
  credentialId: string | undefined;
  status: string;
  capabilities: unknown;
  displayName?: string;
}

interface FakeCredential {
  token: string;
  purpose: string;
  expiresAt: Date | null;
  mintedAt: Date;
  revokedAt: Date | null;
}

function fakeStore() {
  const states = new Map<string, FakeState>();
  const accounts: FakeAccount[] = [];
  const credentials = new Map<string, FakeCredential>();
  let credentialSeq = 0;

  const store: InstagramOnboardingStore = {
    createConnectState: (context, input) => {
      states.set(input.stateId, {
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
        userId: context.userId,
        channel: input.channel,
        nonceHash: input.nonceHash,
        expiresAt: input.expiresAt,
        consumedAt: null,
      });
      return Promise.resolve();
    },
    consumeConnectState: ({ stateId, now }) => {
      const row = states.get(stateId);
      if (row === undefined || row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve(undefined);
      }
      row.consumedAt = now;
      return Promise.resolve({
        id: stateId,
        workspaceId: row.workspaceId,
        businessProfileId: row.businessProfileId,
        userId: row.userId,
        channel: row.channel as "INSTAGRAM",
        nonceHash: row.nonceHash,
        requestedScopes: [],
      });
    },
    findAccountByExternalId: (context, input) => {
      const account = accounts.find(
        (candidate) =>
          candidate.workspaceId === context.workspaceId &&
          candidate.businessProfileId === context.businessProfileId &&
          candidate.externalAccountId === input.externalAccountId,
      );
      return Promise.resolve(account === undefined ? undefined : { channelAccountId: account.id, credentialId: account.credentialId });
    },
    findAccountById: (context, channelAccountId) => {
      const account = accounts.find((candidate) => candidate.id === channelAccountId && candidate.workspaceId === context.workspaceId);
      return Promise.resolve(account === undefined ? undefined : { channelAccountId: account.id, credentialId: account.credentialId });
    },
    connectAccount: (context, input) => {
      const existing = accounts.find(
        (candidate) =>
          candidate.workspaceId === context.workspaceId &&
          candidate.businessProfileId === context.businessProfileId &&
          candidate.externalAccountId === input.externalAccountId,
      );
      if (existing?.credentialId !== undefined) {
        const credential = credentials.get(existing.credentialId);
        if (credential !== undefined) {
          credential.token = input.token;
          credential.expiresAt = input.expiresAt;
          credential.mintedAt = input.now;
          credential.revokedAt = null;
        }
        existing.status = "CONNECTED";
        existing.capabilities = input.capabilities;
        return Promise.resolve({ channelAccountId: existing.id });
      }
      const credentialId = `cred_${String(++credentialSeq)}`;
      credentials.set(credentialId, { token: input.token, purpose: input.purpose, expiresAt: input.expiresAt, mintedAt: input.now, revokedAt: null });
      const account: FakeAccount = {
        id: `ca_${String(accounts.length + 1)}`,
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
        externalAccountId: input.externalAccountId,
        credentialId,
        status: "CONNECTED",
        capabilities: input.capabilities,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      };
      accounts.push(account);
      return Promise.resolve({ channelAccountId: account.id });
    },
    setAccountStatus: (context, channelAccountId, status) => {
      const account = accounts.find((candidate) => candidate.id === channelAccountId && candidate.workspaceId === context.workspaceId);
      if (account !== undefined) {
        account.status = status;
      }
      return Promise.resolve();
    },
    // The real one is a single transaction; this fake applies both halves together for the same reason.
    disconnectAccount: (context, channelAccountId, now) => {
      const account = accounts.find((candidate) => candidate.id === channelAccountId && candidate.workspaceId === context.workspaceId);
      if (account === undefined) {
        // The real store's status write raises this, and the route turns it into a 404.
        return Promise.reject(new TenantRecordNotFoundError("ChannelAccount"));
      }
      account.status = "DISCONNECTED";
      const credential = account.credentialId === undefined ? undefined : credentials.get(account.credentialId);
      if (credential !== undefined) {
        credential.token = "";
        credential.expiresAt = null;
        credential.revokedAt = now;
      }
      return Promise.resolve();
    },
    readCredential: (_context, input) => {
      const credential = credentials.get(input.credentialId);
      if (credential === undefined || credential.revokedAt !== null || credential.purpose !== input.purpose) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ credentialId: input.credentialId, token: credential.token, expiresAt: credential.expiresAt, mintedAt: credential.mintedAt });
    },
    rotateCredential: (_context, input) => {
      const credential = credentials.get(input.credentialId);
      // Mirrors the conditional UPDATE: the row must still be the one the rotation was computed from —
      // not revoked, and not re-minted since — and the caller is told when it is not.
      if (credential === undefined || credential.revokedAt !== null) {
        return Promise.resolve("SUPERSEDED" as const);
      }
      if (input.mintedAt !== undefined && credential.mintedAt.getTime() !== input.mintedAt.getTime()) {
        return Promise.resolve("SUPERSEDED" as const);
      }
      credential.token = input.token;
      credential.expiresAt = input.expiresAt;
      credential.mintedAt = input.refreshedAt;
      return Promise.resolve("ROTATED" as const);
    },
    revokeCredential: (_context, input) => {
      const credential = credentials.get(input.credentialId);
      if (credential !== undefined) {
        credential.token = "";
        credential.expiresAt = null;
        credential.revokedAt = input.now;
      }
      return Promise.resolve();
    },
  };

  return { store, states, accounts, credentials };
}

function scriptedOAuth(responses: readonly ScriptedResponse[]) {
  const requests: { url: string; body?: string }[] = [];
  let index = 0;
  const config: InstagramOAuthConfig = {
    appId: "app_1",
    appSecret: APP_SECRET,
    redirectUri: "https://app.example.test/api/channels/instagram/callback",
    http: {
      send: (request) => {
        requests.push({ url: request.url, ...(request.body === undefined ? {} : { body: request.body }) });
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return Promise.resolve(
          response === undefined
            ? { kind: "NO_RESPONSE", reason: "NETWORK", message: "no scripted response" }
            : { kind: "RESPONSE", status: response.status, body: JSON.stringify(response.body) },
        );
      },
    },
  };
  return { config, requests };
}

interface ScriptedResponse {
  readonly status: number;
  readonly body: unknown;
}

const happyPath = (): ScriptedResponse[] => [
  { status: 200, body: { data: [{ access_token: SHORT_LIVED, user_id: IG_USER_ID, permissions: "instagram_business_basic,instagram_business_manage_messages" }] } },
  { status: 200, body: { access_token: LONG_LIVED, token_type: "bearer", expires_in: 5_184_000 } },
  { status: 200, body: { id: "9999", user_id: IG_USER_ID, username: "studio", account_type: "BUSINESS" } },
];

describe("instagram onboarding", () => {
  let fake: ReturnType<typeof fakeStore>;
  let logs: string[];
  let ids: string[];

  const dependencies = (
    responses = happyPath(),
    now = NOW,
    identifiers: readonly string[] = ["state-value-1", "cookie-nonce-1"],
  ): OnboardingDependencies & { oauthRequests: { url: string; body?: string }[] } => {
    const oauth = scriptedOAuth(responses);
    ids = [...identifiers];
    let issued = 0;
    return {
      store: fake.store,
      oauth: oauth.config,
      logger: createLogger({ level: "debug", sink: (line) => logs.push(line) }),
      now: () => now,
      newId: () => ids[issued++] ?? `id_${String(issued)}`,
      humanAgentApproval: "UNKNOWN",
      oauthRequests: oauth.requests,
    };
  };

  beforeEach(() => {
    fake = fakeStore();
    logs = [];
  });

  const startAndCallback = async (
    deps: ReturnType<typeof dependencies>,
    overrides: Partial<{ state: string; code: string; cookieNonce: string; error: string; dropCookie: boolean }> = {},
  ) => {
    const started = await startInstagramConnect(deps, context());
    return completeInstagramConnect(
      deps,
      {
        state: overrides.state ?? new URL(started.authorizeUrl).searchParams.get("state") ?? undefined,
        code: overrides.code ?? CODE,
        error: overrides.error,
        cookieNonce: overrides.dropCookie === true ? undefined : (overrides.cookieNonce ?? started.cookieNonce),
      },
      () => Promise.resolve(context()),
    );
  };

  it("connects an account, storing the messaging ID and an encrypted token", async () => {
    const deps = dependencies();

    const result = await startAndCallback(deps);

    expect(result).toEqual({ ok: true, workspaceId: "ws_1", businessProfileId: "bp_1", channelAccountId: "ca_1" });
    expect(fake.accounts[0]).toMatchObject({ externalAccountId: IG_USER_ID, status: "CONNECTED", capabilities: { ...INSTAGRAM_CAPABILITIES } });
    const credential = [...fake.credentials.values()][0];
    expect(credential).toMatchObject({ purpose: "INSTAGRAM_ACCESS_TOKEN", token: LONG_LIVED });
    // The 60-day lifetime Meta reported is what expiry is based on.
    expect(credential?.expiresAt).toEqual(new Date(NOW.getTime() + 5_184_000 * 1000));
  });

  it("never lets a token, code, state or nonce reach the logs", async () => {
    const deps = dependencies();

    await startAndCallback(deps);

    const written = logs.join("\n");
    for (const secret of [CODE, SHORT_LIVED, LONG_LIVED, APP_SECRET, "state-value-1", "cookie-nonce-1"]) {
      expect(written).not.toContain(secret);
    }
    expect(written).toContain("instagram.connected");
  });

  it("refuses a state that is unknown, expired, replayed or paired with the wrong cookie", async () => {
    const unknownState = await startAndCallback(dependencies(), { state: "not-a-state" });
    const wrongCookie = await startAndCallback(dependencies(), { cookieNonce: "someone-elses-nonce" });
    const noCookie = await startAndCallback(dependencies(), { dropCookie: true });

    expect([unknownState, wrongCookie, noCookie].map((result) => result.ok ? "ok" : result.reason)).toEqual([
      "invalid_state",
      "invalid_state",
      "invalid_state",
    ]);
    expect(fake.accounts).toHaveLength(0);

    // Replay: the same callback a second time consumes nothing and creates nothing.
    const deps = dependencies([...happyPath(), ...happyPath()]);
    const started = await startInstagramConnect(deps, context());
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    const first = await completeInstagramConnect(deps, { state, code: CODE, error: undefined, cookieNonce: started.cookieNonce }, () => Promise.resolve(context()));
    const replay = await completeInstagramConnect(deps, { state, code: CODE, error: undefined, cookieNonce: started.cookieNonce }, () => Promise.resolve(context()));

    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: false, reason: "invalid_state" });
    expect(fake.accounts).toHaveLength(1);
    // The second attempt never reached Meta.
    expect(deps.oauthRequests).toHaveLength(3);
  });

  it("expires a state that was not used in time", async () => {
    const deps = dependencies(happyPath(), NOW);
    const started = await startInstagramConnect(deps, context());
    const late = { ...deps, now: () => new Date(NOW.getTime() + CONNECT_STATE_TTL_MS + 1_000) };

    const result = await completeInstagramConnect(
      late,
      { state: new URL(started.authorizeUrl).searchParams.get("state") ?? "", code: CODE, error: undefined, cookieNonce: started.cookieNonce },
      () => Promise.resolve(context()),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses a callback completed by a different member than the one who started it", async () => {
    const deps = dependencies();
    const started = await startInstagramConnect(deps, context({ userId: "user_1" }));

    const result = await completeInstagramConnect(
      deps,
      { state: new URL(started.authorizeUrl).searchParams.get("state") ?? "", code: CODE, error: undefined, cookieNonce: started.cookieNonce },
      () => Promise.resolve(context({ userId: "user_2" })),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
    expect(fake.accounts).toHaveLength(0);
  });

  it("stops when authorization was denied, without calling Meta", async () => {
    const deps = dependencies();

    const result = await startAndCallback(deps, { error: "access_denied" });

    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(deps.oauthRequests).toHaveLength(0);
    // Meta's error_description is untrusted text and never travels with the outcome.
    expect(JSON.stringify(result)).not.toContain("denied your request");
  });

  it("refuses to connect when a required scope was not granted", async () => {
    const deps = dependencies([
      { status: 200, body: { data: [{ access_token: SHORT_LIVED, user_id: IG_USER_ID, permissions: "instagram_business_basic" }] } },
    ]);

    const result = await startAndCallback(deps);

    expect(result).toEqual({ ok: false, reason: "missing_scope" });
    expect(fake.accounts).toHaveLength(0);
    expect(fake.credentials.size).toBe(0);
    // Stopped before spending the code on a long-lived token.
    expect(deps.oauthRequests).toHaveLength(1);
  });

  it("separates a provider rejection from a provider outage", async () => {
    const rejected = await startAndCallback(dependencies([{ status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Matching code was not found" } }]));
    const deps = dependencies();
    const unavailable = await completeInstagramConnect(
      { ...deps, oauth: { ...deps.oauth, http: { send: () => Promise.resolve({ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }) } } },
      { state: new URL((await startInstagramConnect(deps, context())).authorizeUrl).searchParams.get("state") ?? "", code: CODE, error: undefined, cookieNonce: "cookie-nonce-1" },
      () => Promise.resolve(context()),
    );

    expect(rejected).toEqual({ ok: false, reason: "provider_rejected" });
    expect(unavailable).toEqual({ ok: false, reason: "provider_unavailable" });
    expect(JSON.stringify(rejected)).not.toContain("Matching code");
  });

  it("refuses a token that does not belong to the account the exchange named", async () => {
    const deps = dependencies([
      happyPath()[0] as ScriptedResponse,
      happyPath()[1] as ScriptedResponse,
      { status: 200, body: { id: "9999", user_id: "17841400000000999", username: "someone-else" } },
    ]);

    expect(await startAndCallback(deps)).toEqual({ ok: false, reason: "provider_rejected" });
    expect(fake.accounts).toHaveLength(0);
  });

  it("reconnecting the same account keeps its row and rotates the credential in place", async () => {
    const first = dependencies();
    await startAndCallback(first);
    const accountId = fake.accounts[0]?.id;
    const credentialId = [...fake.credentials.keys()][0];

    const second = dependencies(happyPath(), new Date(NOW.getTime() + 60_000), ["state-value-2", "cookie-nonce-2"]);
    const again = await startAndCallback(second);

    expect(again).toMatchObject({ ok: true, channelAccountId: accountId });
    expect(fake.accounts).toHaveLength(1);
    expect([...fake.credentials.keys()]).toEqual([credentialId]);
    expect([...fake.credentials.values()][0]?.mintedAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it("disconnects by marking the account and destroying the stored secret", async () => {
    const deps = dependencies();
    await startAndCallback(deps);
    const accountId = fake.accounts[0]?.id ?? "";

    await disconnectInstagramAccount(deps, context(), accountId);

    expect(fake.accounts[0]).toMatchObject({ status: "DISCONNECTED" });
    const credential = [...fake.credentials.values()][0];
    expect(credential?.revokedAt).toEqual(NOW);
    expect(credential?.expiresAt).toBeNull();
    // The row survives for audit, but it no longer holds a usable token.
    expect(fake.accounts).toHaveLength(1);
  });

});

describe("instagram routes", () => {
  const routeDependencies = (overrides: Partial<InstagramRouteDependencies> = {}): InstagramRouteDependencies => ({
    onboarding: () => ({}) as OnboardingDependencies,
    authorize: () => Promise.resolve(context()),
    logger: () => createLogger({ level: "error", sink: () => undefined }),
    connectedRedirectUrl: ({ status }) => `/channels?instagram=${status}`,
    ...overrides,
  });

  it("starts a connect with a host-locked, http-only state cookie and no secret in the response", async () => {
    const started = { authorizeUrl: "https://www.instagram.com/oauth/authorize?state=s", cookieNonce: "nonce-1", cookieMaxAgeSeconds: 600 };
    const handler = createInstagramConnectHandler(
      routeDependencies({ onboarding: () => ({ ...({} as OnboardingDependencies) }) }),
    );
    vi.spyOn(await import("./instagram-onboarding"), "startInstagramConnect").mockResolvedValue(started);

    const response = await handler(new Request("https://app.example.test/x", { method: "POST" }), { params: Promise.resolve({ workspaceId: "ws_1", businessProfileId: "bp_1" }) });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(started.authorizeUrl);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${STATE_COOKIE_NAME}=nonce-1`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    vi.restoreAllMocks();
  });

  it("answers an unauthenticated or unauthorized connect without disclosing anything", async () => {
    const unauthenticated = createInstagramConnectHandler(routeDependencies({ authorize: () => Promise.reject(new UnauthenticatedError()) }));

    const response = await unauthenticated(new Request("https://app.example.test/x", { method: "POST" }), {
      params: Promise.resolve({ workspaceId: "ws_1", businessProfileId: "bp_1" }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("redirects the callback to a same-origin page, clears the cookie and never reflects provider text", async () => {
    const handler = createInstagramCallbackHandler(routeDependencies());
    vi.spyOn(await import("./instagram-onboarding"), "completeInstagramConnect").mockResolvedValue({ ok: false, reason: "denied" });

    const response = await handler(
      new Request("https://app.example.test/api/channels/instagram/callback?error=access_denied&error_description=The+user+denied+your+request&state=s"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/channels?instagram=denied");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("location")).not.toContain("denied+your+request");
    vi.restoreAllMocks();
  });

  it("answers a disconnect for an unknown account with not found, not a server error", async () => {
    const handler = createInstagramDisconnectHandler(
      routeDependencies({
        onboarding: () =>
          ({
            store: {
              findAccountById: () => Promise.resolve(undefined),
              disconnectAccount: () => Promise.reject(new TenantRecordNotFoundError("ChannelAccount")),
            },
            logger: createLogger({ level: "error", sink: () => undefined }),
            now: () => NOW,
          }) as unknown as OnboardingDependencies,
      }),
    );

    const response = await handler(new Request("https://app.example.test/x", { method: "POST" }), {
      params: Promise.resolve({ workspaceId: "ws_1", businessProfileId: "bp_1", channelAccountId: "ca_missing" }),
    });

    expect(response.status).toBe(404);
  });

  it("reads the state nonce only from the named cookie", async () => {
    const seen: (string | undefined)[] = [];
    const handler = createInstagramCallbackHandler(routeDependencies());
    vi.spyOn(await import("./instagram-onboarding"), "completeInstagramConnect").mockImplementation((_deps, input) => {
      seen.push(input.cookieNonce);
      return Promise.resolve({ ok: false, reason: "invalid_state" });
    });

    await handler(
      new Request("https://app.example.test/api/channels/instagram/callback?code=c&state=s", {
        headers: { cookie: `other=zzz; ${STATE_COOKIE_NAME}=the-nonce; another=yyy` },
      }),
    );
    await handler(new Request("https://app.example.test/api/channels/instagram/callback?code=c&state=s", { headers: { cookie: "other=zzz" } }));

    expect(seen).toEqual(["the-nonce", undefined]);
    vi.restoreAllMocks();
  });
});

describe("state nonce", () => {
  it("is stored only as the hash of the cookie value, never the value itself", async () => {
    const fake = fakeStore();
    const started = await startInstagramConnect(
      {
        store: fake.store,
        oauth: { appId: "a", appSecret: "s", redirectUri: "https://app.example.test/cb", http: { send: () => Promise.resolve({ kind: "NO_RESPONSE", reason: "NETWORK", message: "unused" }) } },
        logger: createLogger({ level: "error", sink: () => undefined }),
        now: () => NOW,
        newId: (() => {
          const values = ["state-value-9", "cookie-nonce-9"];
          let index = 0;
          return () => values[index++] ?? "x";
        })(),
        humanAgentApproval: "UNKNOWN",
      },
      context(),
    );
    const stored = fake.states.get("state-value-9");

    expect(Buffer.from(stored?.nonceHash ?? new Uint8Array()).equals(createHash("sha256").update(started.cookieNonce, "utf8").digest())).toBe(true);
    // The nonce itself must not be recoverable from the row.
    expect(JSON.stringify(stored)).not.toContain(started.cookieNonce);
  });
});
