/**
 * The WhatsApp onboarding endpoints (Issue #19).
 *
 * These are public HTTP endpoints, so the cases here are about what a request gets rather than what the
 * flow decides: a member without the role, a deployment with no WhatsApp app, a body nobody could read,
 * and the state cookie's own attributes — which are the difference between a CSRF-bound flow and a flow
 * that merely has a cookie.
 */
import { BusinessProfileAccessDeniedError, WorkspacePermissionError, type BusinessProfileContext } from "@omnichannel/db";
import { createLogger } from "@omnichannel/observability";
import { describe, expect, it } from "vitest";

import { UnauthenticatedError } from "./workspace-context";
import { createWhatsAppCompleteHandler, createWhatsAppConnectHandler, createWhatsAppDisconnectHandler, type WhatsAppRouteDependencies } from "./whatsapp-routes";
import { exchanged, debugToken, finishNotice, phoneNumbers, signupConfig, success, templates } from "./testing/whatsapp-signup";
import { startWhatsAppConnect, type DisconnectDependencies, type WhatsAppOnboardingDependencies } from "./whatsapp-onboarding";

const context = () =>
  ({ workspaceId: "ws_1", businessProfileId: "bp_1", userId: "user_1", workspaceMemberId: "member_1", role: "OWNER" }) as unknown as BusinessProfileContext;

const params = (overrides: Readonly<Record<string, string>> = {}) => ({
  params: Promise.resolve({ workspaceId: "ws_1", businessProfileId: "bp_1", ...overrides }),
});

function dependencies(
  options: {
    readonly onboarding?: () => WhatsAppOnboardingDependencies | undefined;
    readonly disconnect?: () => DisconnectDependencies;
    readonly authorize?: () => Promise<BusinessProfileContext>;
  } = {},
): WhatsAppRouteDependencies {
  return {
    onboarding: options.onboarding ?? (() => undefined),
    // The default finds no such account, which is the 404 every disconnect case here but one expects.
    disconnect: options.disconnect ?? (() => disconnecting().dependencies),
    authorize: options.authorize ?? (() => Promise.resolve(context())),
    logger: () => createLogger({ level: "error", sink: () => undefined }),
  };
}

/**
 * The disconnect dependency, with a store that records the detach instead of performing one.
 *
 * `connection` is what `readConnection` answers: `undefined` for an account that is not this profile's,
 * or a row with no credential, which keeps the provider unsubscribe out of a transport-free test.
 */
function disconnecting(connection?: { readonly wabaId: string }): {
  readonly dependencies: DisconnectDependencies;
  readonly detached: string[];
} {
  const detached: string[] = [];
  return {
    detached,
    dependencies: {
      store: {
        readConnection: () => Promise.resolve(connection === undefined ? undefined : { ...connection, credentialId: undefined }),
        disconnectWhatsAppAccount: (_ctx: unknown, channelAccountId: string) => {
          detached.push(channelAccountId);
          return Promise.resolve();
        },
      },
      graph: { http: { send: () => Promise.resolve({ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "not called" }) } },
      logger: createLogger({ level: "error", sink: () => undefined }),
      now: () => new Date(),
    } as unknown as DisconnectDependencies,
  };
}

/** A real flow over a scripted provider and a store that only records what it was asked to do. */
function onboarding(): { readonly dependencies: WhatsAppOnboardingDependencies; readonly started: () => Promise<{ state: string; nonce: string }> } {
  const states = new Map<string, { nonceHash: Uint8Array; consumed: boolean }>();
  const { config } = signupConfig([exchanged(), debugToken(), phoneNumbers(), success(), success(), templates(1)]);
  let ids = 0;
  const deps = {
    store: {
      createConnectState: (_ctx: unknown, input: { stateId: string; nonceHash: Uint8Array }) => {
        states.set(input.stateId, { nonceHash: input.nonceHash, consumed: false });
        return Promise.resolve();
      },
      consumeConnectState: ({ stateId }: { stateId: string }) => {
        const row = states.get(stateId);
        if (row === undefined || row.consumed) {
          return Promise.resolve(undefined);
        }
        row.consumed = true;
        return Promise.resolve({
          stateId,
          workspaceId: "ws_1",
          businessProfileId: "bp_1",
          userId: "user_1",
          channel: "WHATSAPP" as const,
          nonceHash: row.nonceHash,
          requestedScopes: [],
          expiresAt: new Date(Date.now() + 60_000),
        });
      },
      connectWhatsAppAccount: () => Promise.resolve({ channelAccountId: "ca_1", connectionId: "wc_1" }),
      readConnection: () => Promise.resolve(undefined),
    },
    signup: config,
    logger: createLogger({ level: "error", sink: () => undefined }),
    now: () => new Date(),
    newId: () => {
      ids += 1;
      return `id_${String(ids)}`;
    },
  } as unknown as WhatsAppOnboardingDependencies;
  return {
    dependencies: deps,
    started: async () => {
      const start = await startWhatsAppConnect(deps, context());
      return { state: start.stateId, nonce: start.cookieNonce };
    },
  };
}

const post = (body: unknown, cookie?: string) =>
  new Request("https://app.example/api/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });

describe("a deployment with no WhatsApp app configured", () => {
  it("refuses to start a signup it could never finish", async () => {
    const response = await createWhatsAppConnectHandler(dependencies())(new Request("https://app.example/x", { method: "POST" }), params());

    // Refused before a state row exists. Walking somebody through Meta's whole flow and failing at the
    // exchange would leave real assets on their account for a connection that can never be completed.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_configured" });
  });

  it("refuses the completion too", async () => {
    expect((await createWhatsAppCompleteHandler(dependencies())(post({}), params())).status).toBe(503);
  });

  it("still lets an operator disconnect an account connected while there was one", async () => {
    // The case that must not regress, and the reason `disconnect` is a dependency of its own. Refusing
    // here because the app configuration is gone would strand every account the deployment had already
    // connected: readable, un-sendable, still holding an encrypted token, and with no control left that
    // could remove it, because this route is the only control there is.
    const flow = disconnecting({ wabaId: "waba_1" });

    const response = await createWhatsAppDisconnectHandler(dependencies({ onboarding: () => undefined, disconnect: () => flow.dependencies }))(
      post({}),
      params({ channelAccountId: "ca_1" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disconnected", unsubscribed: false });
    // Asserted on the store, not only on the status: a success above a write that never happened is the
    // shape that passes while the token stays where it was.
    expect(flow.detached).toEqual(["ca_1"]);
  });
});

describe("starting a signup", () => {
  it("returns the launch configuration and sets the state cookie", async () => {
    const flow = onboarding();

    const response = await createWhatsAppConnectHandler(dependencies({ onboarding: () => flow.dependencies }))(
      new Request("https://app.example/x", { method: "POST" }),
      params(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; state: string; launch: { configId: string } };
    expect(body.status).toBe("started");
    expect(body.launch.configId).toBe("9876543210987654");

    const cookie = response.headers.get("set-cookie") ?? "";
    // `__Host-` forces Secure and a path of `/` with no Domain, which is what makes it unusable by a
    // sibling subdomain. `SameSite=Strict` is right here and wrong for Instagram: this flow never leaves
    // our origin, so no legitimate cross-site navigation needs the cookie sent.
    expect(cookie).toContain("__Host-wa_signup_state=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("never puts the app secret in the response", async () => {
    const flow = onboarding();

    const response = await createWhatsAppConnectHandler(dependencies({ onboarding: () => flow.dependencies }))(
      new Request("https://app.example/x", { method: "POST" }),
      params(),
    );

    expect(await response.text()).not.toContain("test-app-secret");
  });
});

describe("completing a signup", () => {
  it("connects and reports a fixed outcome", async () => {
    const flow = onboarding();
    const start = await flow.started();

    const response = await createWhatsAppCompleteHandler(dependencies({ onboarding: () => flow.dependencies }))(
      post({ state: start.state, code: "AQB-code", notice: finishNotice(), pin: "581063" }, `__Host-wa_signup_state=${start.nonce}`),
      params(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "connected", channelAccountId: "ca_1", mode: "NEW_OR_MIGRATED_CLOUD_NUMBER", templatesUnsynced: false });
    // One-shot: the cookie is cleared whatever happened.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("refuses a completion with no state and says nothing more", async () => {
    const flow = onboarding();

    const response = await createWhatsAppCompleteHandler(dependencies({ onboarding: () => flow.dependencies }))(post({ code: "AQB-code" }), params());

    expect(response.status).toBe(400);
    // A forged state, a token from another app and an unexplainable provider refusal all answer the same
    // way: telling an operator which one it was would tell an attacker too.
    expect(await response.json()).toEqual({ status: "error" });
  });

  it("refuses a body that is not readable JSON without failing the request", async () => {
    const flow = onboarding();
    const request = new Request("https://app.example/api/whatsapp", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });

    const response = await createWhatsAppCompleteHandler(dependencies({ onboarding: () => flow.dependencies }))(request, params());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error" });
  });

  it("clears the cookie even when authorization fails", async () => {
    const flow = onboarding();
    const response = await createWhatsAppCompleteHandler(
      dependencies({ onboarding: () => flow.dependencies, authorize: () => Promise.reject(new WorkspacePermissionError("connecting")) }),
    )(post({ state: "s" }), params());

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("authorization", () => {
  it("answers 401 with no session", async () => {
    const flow = onboarding();
    const response = await createWhatsAppConnectHandler(
      dependencies({ onboarding: () => flow.dependencies, authorize: () => Promise.reject(new UnauthenticatedError()) }),
    )(new Request("https://app.example/x", { method: "POST" }), params());

    expect(response.status).toBe(401);
  });

  it("answers 403 for a member who may not connect a channel", async () => {
    // Only an OWNER or an authorized ADMIN. The store enforces it; this is where the refusal becomes a
    // status code rather than a stack trace.
    const flow = onboarding();
    const response = await createWhatsAppConnectHandler(
      dependencies({ onboarding: () => flow.dependencies, authorize: () => Promise.reject(new WorkspacePermissionError("connecting")) }),
    )(new Request("https://app.example/x", { method: "POST" }), params());

    expect(response.status).toBe(403);
  });

  it("answers 404 rather than 403 for a profile this session cannot see", async () => {
    // Whether a Workspace or a profile exists is itself information.
    const flow = onboarding();
    const response = await createWhatsAppConnectHandler(
      dependencies({ onboarding: () => flow.dependencies, authorize: () => Promise.reject(new BusinessProfileAccessDeniedError()) }),
    )(new Request("https://app.example/x", { method: "POST" }), params());

    expect(response.status).toBe(404);
  });
});

describe("disconnecting", () => {
  it("answers 404 when the route names no account", async () => {
    const response = await createWhatsAppDisconnectHandler(dependencies())(post({}), params());

    expect(response.status).toBe(404);
  });

  it("answers 404 for an account that is not this profile's", async () => {
    const flow = disconnecting();

    const response = await createWhatsAppDisconnectHandler(dependencies({ disconnect: () => flow.dependencies }))(
      post({}),
      params({ channelAccountId: "ca_someone_else" }),
    );

    expect(response.status).toBe(404);
    expect(flow.detached).toEqual([]);
  });
});
