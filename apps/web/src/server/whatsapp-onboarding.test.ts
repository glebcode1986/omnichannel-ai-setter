/**
 * WhatsApp Embedded Signup, as the flow runs (Issue #19).
 *
 * The acceptance criteria name eleven situations, and almost all of them are about *not* connecting: a
 * forged state, a replayed one, a permission the customer deselected, a number that is not on the account
 * it claims, the same number in two workspaces, a subscription that failed. The one that keeps coming back
 * in review is the half-connected account, so it has a test of its own: when a provider step fails after
 * the assets were chosen, nothing at all is persisted, and the operator can simply try again — both of
 * Meta's calls are idempotent.
 *
 * No network, no database, no browser. The HTTP port is scripted and the store is in memory, so every
 * provider response is a fixture and no production credential appears anywhere.
 */
import { createHash } from "node:crypto";

import type { WhatsAppHttpResult } from "@omnichannel/channel-whatsapp";
import { ChannelConnectError, type BusinessProfileContext, type WhatsAppOnboardingStore } from "@omnichannel/db";
import { createLogger } from "@omnichannel/observability";
import { describe, expect, it } from "vitest";

import {
  BUSINESS_TOKEN,
  cancelNotice,
  debugToken,
  errorNotice,
  EXCHANGE_CODE,
  exchanged,
  finishNotice,
  graphError,
  PHONE_NUMBER_ID,
  phoneNumbers,
  signupConfig,
  success,
  templates,
  WABA_ID,
} from "./testing/whatsapp-signup";

import {
  completeWhatsAppConnect,
  CONNECT_STATE_TTL_MS,
  disconnectWhatsAppAccount,
  FLAGGED_QUALITY_REASON,
  startWhatsAppConnect,
  TEMPLATES_UNSYNCED_REASON,
  type WhatsAppOnboardingDependencies,
} from "./whatsapp-onboarding";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const PIN = "581063";

const context = (overrides: Partial<{ workspaceId: string; businessProfileId: string; userId: string }> = {}) =>
  ({
    workspaceId: overrides.workspaceId ?? "ws_1",
    businessProfileId: overrides.businessProfileId ?? "bp_1",
    userId: overrides.userId ?? "user_1",
    workspaceMemberId: "member_1",
    role: "OWNER",
  }) as unknown as BusinessProfileContext;

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
  channelAccountId: string;
  workspaceId: string;
  externalAccountId: string;
  status: string;
  credentialId: string;
}

interface FakeConnection {
  channelAccountId: string;
  wabaId: string;
  onboardingMode: string;
  webhookSubscribedAt: Date | undefined;
  phoneRegisteredAt: Date | undefined;
  templatesSyncedAt: Date | undefined;
  templateCount: number;
  connectedAt: Date | undefined;
  healthReason: string | undefined;
  status: string;
}

/** In-memory stand-in for the persistence port, so the flow is tested without a database. */
function fakeStore(options: { readonly liveElsewhere?: string } = {}) {
  const states = new Map<string, FakeState>();
  const accounts: FakeAccount[] = [];
  const connections: FakeConnection[] = [];
  const credentials = new Map<string, { token: string; revokedAt: Date | null }>();
  let seq = 0;

  const store: WhatsAppOnboardingStore = {
    createConnectState: (ctx, input) => {
      states.set(input.stateId, {
        workspaceId: ctx.workspaceId,
        businessProfileId: ctx.businessProfileId,
        userId: ctx.userId,
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
        channel: row.channel as "WHATSAPP",
        nonceHash: row.nonceHash,
        requestedScopes: [] as readonly string[],
      });
    },
    findAccountByExternalId: (ctx, input) => {
      const found = accounts.find((account) => account.workspaceId === ctx.workspaceId && account.externalAccountId === input.externalAccountId);
      return Promise.resolve(found === undefined ? undefined : { channelAccountId: found.channelAccountId, credentialId: found.credentialId });
    },
    findAccountById: (ctx, channelAccountId) => {
      const found = accounts.find((account) => account.workspaceId === ctx.workspaceId && account.channelAccountId === channelAccountId);
      return Promise.resolve(found === undefined ? undefined : { channelAccountId: found.channelAccountId, credentialId: found.credentialId });
    },
    connectWhatsAppAccount: (ctx, input) => {
      if (options.liveElsewhere === input.phoneNumberId) {
        // The global live-account index: one provider number may be live in exactly one Workspace.
        return Promise.reject(new ChannelConnectError("already_connected"));
      }
      seq += 1;
      const existing = accounts.find((account) => account.workspaceId === ctx.workspaceId && account.externalAccountId === input.phoneNumberId);
      const channelAccountId = existing?.channelAccountId ?? `ca_${String(seq)}`;
      const credentialId = existing?.credentialId ?? `cr_${String(seq)}`;
      credentials.set(credentialId, { token: input.token, revokedAt: null });
      if (existing === undefined) {
        accounts.push({ channelAccountId, workspaceId: ctx.workspaceId, externalAccountId: input.phoneNumberId, status: input.health.status, credentialId });
      } else {
        existing.status = input.health.status;
      }
      const connection: FakeConnection = {
        channelAccountId,
        wabaId: input.wabaId,
        onboardingMode: input.onboardingMode,
        webhookSubscribedAt: input.webhookSubscribedAt,
        phoneRegisteredAt: input.phoneRegisteredAt,
        templatesSyncedAt: input.templates?.syncedAt,
        templateCount: input.templates?.records.length ?? 0,
        connectedAt: input.now,
        healthReason: input.health.reason,
        status: input.health.status,
      };
      const at = connections.findIndex((row) => row.channelAccountId === channelAccountId);
      if (at === -1) {
        connections.push(connection);
      } else {
        connections[at] = connection;
      }
      return Promise.resolve({ channelAccountId, connectionId: `wc_${String(seq)}` });
    },
    readConnection: (_ctx, channelAccountId) => {
      const row = connections.find((connection) => connection.channelAccountId === channelAccountId);
      const account = accounts.find((item) => item.channelAccountId === channelAccountId);
      return Promise.resolve(
        row === undefined || account === undefined
          ? undefined
          : {
              connectionId: `wc_${channelAccountId}`,
              channelAccountId,
              credentialId: account.credentialId,
              wabaId: row.wabaId,
              businessPortfolioId: undefined,
              displayPhoneNumber: undefined,
              verifiedName: undefined,
              qualityRating: undefined,
              onboardingMode: row.onboardingMode as "UNKNOWN",
              webhookSubscribedAt: row.webhookSubscribedAt,
              phoneRegisteredAt: row.phoneRegisteredAt,
              templatesSyncedAt: row.templatesSyncedAt,
              templatesComplete: undefined,
              connectedAt: row.connectedAt,
              healthReason: row.healthReason,
              status: account.status as "CONNECTED",
            },
      );
    },
    recordHealth: (_ctx, channelAccountId, input) => {
      const account = accounts.find((item) => item.channelAccountId === channelAccountId);
      const row = connections.find((connection) => connection.channelAccountId === channelAccountId);
      if (account !== undefined) {
        account.status = input.status;
      }
      if (row !== undefined) {
        row.healthReason = input.reason;
      }
      return Promise.resolve();
    },
    syncTemplates: () => Promise.resolve({ written: 0 }),
    listTemplates: () => Promise.resolve([]),
    setAccountStatus: (_ctx, channelAccountId, status) => {
      const account = accounts.find((item) => item.channelAccountId === channelAccountId);
      if (account !== undefined) {
        account.status = status;
      }
      return Promise.resolve();
    },
    readCredential: (_ctx, input) => {
      const stored = credentials.get(input.credentialId);
      return Promise.resolve(
        stored === undefined || stored.revokedAt !== null ? undefined : { credentialId: input.credentialId, token: stored.token, expiresAt: null, mintedAt: NOW },
      );
    },
    rotateCredential: () => Promise.resolve("ROTATED" as const),
    revokeCredential: (_ctx, input) => {
      const stored = credentials.get(input.credentialId);
      if (stored !== undefined) {
        stored.revokedAt = input.now;
      }
      return Promise.resolve();
    },
    disconnectWhatsAppAccount: (_ctx, channelAccountId, now) => {
      const account = accounts.find((item) => item.channelAccountId === channelAccountId);
      const row = connections.find((connection) => connection.channelAccountId === channelAccountId);
      if (account !== undefined) {
        account.status = "DISCONNECTED";
        const stored = credentials.get(account.credentialId);
        if (stored !== undefined) {
          stored.revokedAt = now;
        }
      }
      if (row !== undefined) {
        row.connectedAt = undefined;
        row.webhookSubscribedAt = undefined;
        row.healthReason = "DISCONNECTED";
      }
      return Promise.resolve();
    },
  };
  return { store, states, accounts, connections, credentials };
}

interface Harness {
  readonly dependencies: WhatsAppOnboardingDependencies;
  readonly store: ReturnType<typeof fakeStore>;
  /** Raw log lines, which is how the redaction assertions can look at everything that was written. */
  readonly logs: string[];
  readonly requests: { url: string; body: unknown; headers: Readonly<Record<string, string>> }[];
}

function harness(results: readonly WhatsAppHttpResult[], options: { readonly liveElsewhere?: string } = {}): Harness {
  const store = fakeStore(options);
  const { config, requests } = signupConfig(results);
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => logs.push(line) });
  let ids = 0;
  return {
    store,
    logs,
    requests,
    dependencies: {
      store: store.store,
      signup: config,
      logger,
      now: () => NOW,
      newId: () => {
        ids += 1;
        return `id_${String(ids)}`;
      },
    },
  };
}

/** The happy provider script, in the order the flow calls Meta. */
const happyScript = (overrides: { readonly quality?: string; readonly platformType?: string } = {}): readonly WhatsAppHttpResult[] => [
  exchanged(),
  debugToken(),
  phoneNumbers(overrides),
  success(),
  success(),
  templates(2),
];

async function started(test: Harness) {
  const start = await startWhatsAppConnect(test.dependencies, context());
  return { state: start.stateId, cookieNonce: start.cookieNonce, launch: start.launch };
}

/** One log line, parsed, so an assertion can read a field rather than a substring. */
function logged(lines: readonly string[], event: string): Record<string, unknown> | undefined {
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry["event"] === event) {
      return entry;
    }
  }
  return undefined;
}

const authorize = (ctx = context()) => (_workspaceId: string, _businessProfileId: string) => Promise.resolve(ctx);

describe("starting a signup", () => {
  it("hands the client what it needs to launch the flow, and nothing secret", async () => {
    const test = harness([]);

    const start = await startWhatsAppConnect(test.dependencies, context());

    expect(start.launch).toEqual({
      appId: "1234567890123456",
      configId: "9876543210987654",
      graphVersion: "v26.0",
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
    });
    // The app secret configures the server's own exchange; it must never be in what the page receives.
    expect(JSON.stringify(start)).not.toContain("test-app-secret");
    expect(start.cookieMaxAgeSeconds).toBe(CONNECT_STATE_TTL_MS / 1000);
  });

  it("stores only the hash of the cookie nonce", async () => {
    const test = harness([]);

    const start = await startWhatsAppConnect(test.dependencies, context());

    const row = test.store.states.get(start.stateId);
    expect(row?.nonceHash).toEqual(createHash("sha256").update(start.cookieNonce, "utf8").digest());
    // The value itself is never written: a database dump must not complete anybody's flow.
    expect(JSON.stringify([...test.store.states.values()])).not.toContain(start.cookieNonce);
  });
});

describe("a valid onboarding", () => {
  it("connects the number after the provider confirmed both steps", async () => {
    const test = harness(happyScript());
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toMatchObject({ ok: true, mode: "NEW_OR_MIGRATED_CLOUD_NUMBER", templatesUnsynced: false });
    const connection = test.store.connections[0];
    expect(connection?.wabaId).toBe(WABA_ID);
    expect(connection?.webhookSubscribedAt).toEqual(NOW);
    expect(connection?.phoneRegisteredAt).toEqual(NOW);
    expect(connection?.templateCount).toBe(2);
    expect(connection?.status).toBe("CONNECTED");
  });

  it("calls Meta in the order the onboarding sequence requires", async () => {
    const test = harness(happyScript());
    const start = await started(test);

    await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    // Exchange, inspect, validate the assets, subscribe, register, read the catalogue. The order is the
    // point: nothing is subscribed or registered before the token has been shown to belong to this app
    // and the number has been shown to belong to the account that was named.
    expect(test.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v26.0/oauth/access_token",
      "/v26.0/debug_token",
      `/v26.0/${WABA_ID}/phone_numbers`,
      `/v26.0/${WABA_ID}/subscribed_apps`,
      `/v26.0/${PHONE_NUMBER_ID}/register`,
      `/v26.0/${WABA_ID}/message_templates`,
    ]);
  });

  it("reconnects an account that was disconnected, keeping its identity", async () => {
    // Six provider calls to connect, one to unsubscribe on disconnect, six to connect again.
    const test = harness([...happyScript(), success(), ...happyScript()]);
    const first = await started(test);
    const connected = await completeWhatsAppConnect(
      test.dependencies,
      { state: first.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: first.cookieNonce },
      authorize(),
    );
    expect(connected.ok).toBe(true);
    await disconnectWhatsAppAccount(test.dependencies, context(), connected.ok ? connected.channelAccountId : "");

    const second = await started(test);
    const again = await completeWhatsAppConnect(
      test.dependencies,
      { state: second.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: second.cookieNonce },
      authorize(),
    );

    // The same account row, so the conversations and the audit history stay attached to it rather than a
    // second logical tenant appearing for the same number.
    expect(again.ok && again.channelAccountId).toBe(connected.ok ? connected.channelAccountId : "");
    expect(test.store.accounts).toHaveLength(1);
    expect(test.store.connections).toHaveLength(1);
  });
});

describe("coexistence", () => {
  it("connects a Business App number without registering it", async () => {
    // Registration is required "where current Meta requires it", and the documented case where it is not
    // is a number that stays on the WhatsApp Business App.
    const test = harness([exchanged(), debugToken(), phoneNumbers({ platformType: "NOT_APPLICABLE" }), success(), templates(1)]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      {
        state: start.state,
        code: EXCHANGE_CODE,
        notice: finishNotice({ event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" }),
        pin: undefined,
        cookieNonce: start.cookieNonce,
      },
      authorize(),
    );

    expect(result).toMatchObject({ ok: true, mode: "COEXISTENCE_EXISTING_BUSINESS_APP" });
    expect(test.store.connections[0]?.phoneRegisteredAt).toBeUndefined();
    expect(test.requests.some((request) => request.url.includes("/register"))).toBe(false);
  });

  it("is never promised for a flow that did not report it", async () => {
    // The capability gate. A normal Cloud API finish must not become coexistence because the number
    // happens to look like one, and a missing PIN for it is a refusal rather than a skipped registration.
    const test = harness([exchanged(), debugToken(), phoneNumbers({ platformType: "NOT_APPLICABLE" }), success()]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: undefined, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(test.store.connections).toHaveLength(0);
  });
});

describe("state and CSRF binding", () => {
  it("refuses a state nobody started", async () => {
    const test = harness(happyScript());

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: "forged", code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: "whatever" },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
    // Nothing was exchanged: a forged state must not even cost a provider request.
    expect(test.requests).toHaveLength(0);
  });

  it("refuses the right state with the wrong cookie", async () => {
    const test = harness(happyScript());
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: "not-the-nonce" },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses a completion with no cookie at all", async () => {
    const test = harness(happyScript());
    const start = await started(test);

    expect(
      await completeWhatsAppConnect(
        test.dependencies,
        { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: undefined },
        authorize(),
      ),
    ).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses a replay of a completion that already succeeded", async () => {
    const test = harness([...happyScript(), ...happyScript()]);
    const start = await started(test);
    const input = { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce };

    expect((await completeWhatsAppConnect(test.dependencies, input, authorize())).ok).toBe(true);

    // Single-use, and consumed before any provider call, so a replay cannot even re-subscribe.
    expect(await completeWhatsAppConnect(test.dependencies, input, authorize())).toEqual({ ok: false, reason: "invalid_state" });
    expect(test.store.accounts).toHaveLength(1);
  });

  it("refuses a replay of a completion that failed", async () => {
    // The state is consumed first on purpose: a failed attempt must not leave a usable state behind for
    // somebody else's browser to finish.
    const test = harness([graphError(400, 100), ...happyScript()]);
    const start = await started(test);
    const input = { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce };

    expect(await completeWhatsAppConnect(test.dependencies, input, authorize())).toMatchObject({ ok: false, reason: "provider_rejected" });
    expect(await completeWhatsAppConnect(test.dependencies, input, authorize())).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses a completion finished by a different member", async () => {
    const test = harness(happyScript());
    const start = await started(test);

    // Their role would pass the store's check; the binding to the person who started the flow is what
    // makes this refusable at all.
    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(context({ userId: "user_2" })),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
    expect(test.requests).toHaveLength(0);
  });

  it("refuses an expired state", async () => {
    const test = harness(happyScript());
    const start = await startWhatsAppConnect(test.dependencies, context());
    const late = { ...test.dependencies, now: () => new Date(NOW.getTime() + CONNECT_STATE_TTL_MS + 1_000) };

    expect(
      await completeWhatsAppConnect(
        late,
        { state: start.stateId, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
        authorize(),
      ),
    ).toEqual({ ok: false, reason: "invalid_state" });
  });
});

describe("what the customer did in the flow", () => {
  it("reports an abandoned flow as cancelled, with the screen in the log only", async () => {
    const test = harness([]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: undefined, notice: cancelNotice("BUSINESS_VERIFICATION"), pin: undefined, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(logged(test.logs, "whatsapp.connect_cancelled")?.["step"]).toBe("BUSINESS_VERIFICATION");
  });

  it("logs a reported error by code and session, never by its message", async () => {
    const test = harness([]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: errorNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(logged(test.logs, "whatsapp.connect_provider_error")).toMatchObject({ providerErrorCode: "524126", providerSessionId: "f34b51dab5e0498" });
    expect(JSON.stringify(test.logs)).not.toContain("violates WhatsApp policy");
  });

  it("says so when the flow finished without a number", async () => {
    const test = harness([]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      {
        state: start.state,
        code: EXCHANGE_CODE,
        notice: finishNotice({ event: "FINISH_ONLY_WABA", phoneNumberId: null }),
        pin: PIN,
        cookieNonce: start.cookieNonce,
      },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "no_phone_number" });
  });
});

describe("permissions and assets", () => {
  it("refuses a connection when a required permission was deselected", async () => {
    const test = harness([exchanged(), debugToken({ scopes: ["whatsapp_business_management"] })]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "missing_scope" });
    expect(logged(test.logs, "whatsapp.connect_missing_scope")?.["missing"]).toEqual(["whatsapp_business_messaging"]);
    expect(test.store.accounts).toHaveLength(0);
  });

  it("refuses a number the browser claimed on an account it does not belong to", async () => {
    const test = harness([exchanged(), debugToken(), phoneNumbers({ id: "111111111111111" })]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "asset_mismatch" });
    // Nothing was subscribed: the validation happens before any write to the customer's account.
    expect(test.requests.some((request) => request.url.includes("subscribed_apps"))).toBe(false);
  });

  it("refuses a token minted for another application", async () => {
    const test = harness([exchanged(), debugToken({ appId: "999999999999999" })]);
    const start = await started(test);

    expect(
      await completeWhatsAppConnect(
        test.dependencies,
        { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
        authorize(),
      ),
    ).toEqual({ ok: false, reason: "wrong_app" });
  });

  it("refuses a number that is already live in another workspace", async () => {
    const test = harness(happyScript(), { liveElsewhere: PHONE_NUMBER_ID });
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    // One provider number may be live in exactly one Workspace, so two tenants cannot both claim it and
    // webhook routing keeps resolving to one authorized account.
    expect(result).toEqual({ ok: false, reason: "already_connected" });
  });
});

describe("a provider step that fails after the assets were chosen", () => {
  it("persists nothing when the subscription fails", async () => {
    const test = harness([exchanged(), debugToken(), phoneNumbers(), graphError(400, 200)]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "subscription_failed" });
    // No half-connected account to clean up, and subscribing is idempotent, so trying again costs nothing.
    expect(test.store.accounts).toHaveLength(0);
    expect(test.store.connections).toHaveLength(0);
    expect(test.store.credentials.size).toBe(0);
  });

  it("persists nothing when the phone registration fails", async () => {
    const test = harness([exchanged(), debugToken(), phoneNumbers(), success(), graphError(400, 133_010)]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "registration_failed" });
    expect(test.store.accounts).toHaveLength(0);
  });

  it("refuses a PIN that is not six digits before any provider call for it", async () => {
    const test = harness([exchanged(), debugToken(), phoneNumbers(), success()]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: "12345", cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(test.requests.some((request) => request.url.includes("/register"))).toBe(false);
  });

  it("connects anyway when only the catalogue could not be read, and says the catalogue is unknown", async () => {
    // Free-form customer care is unaffected, the transport refuses a template send naming a template it
    // cannot find, and delivery policy rechecks template status anyway — so this is a recorded gap rather
    // than a reason to hold a healthy number's automation.
    const test = harness([exchanged(), debugToken(), phoneNumbers(), success(), success(), graphError(500, 1)]);
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toMatchObject({ ok: true, templatesUnsynced: true });
    expect(test.store.connections[0]).toMatchObject({ status: "CONNECTED", healthReason: TEMPLATES_UNSYNCED_REASON, templatesSyncedAt: undefined });
  });
});

describe("provider-reported health", () => {
  it("connects a flagged number as degraded, so nothing automated goes out unattended", async () => {
    const test = harness(happyScript({ quality: "RED" }));
    const start = await started(test);

    const result = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(result).toMatchObject({ ok: true });
    // A red rating is Meta warning that the next unattended message is the risky one. The connection is
    // real — a person can still approve a reply — and the policy layer holds the automated ones.
    expect(test.store.connections[0]).toMatchObject({ status: "DEGRADED", healthReason: FLAGGED_QUALITY_REASON });
  });

  it("reads the rating case-insensitively, because it is the provider's vocabulary", async () => {
    const test = harness(happyScript({ quality: "red" }));
    const start = await started(test);

    await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    expect(test.store.connections[0]?.status).toBe("DEGRADED");
  });
});

describe("disconnecting", () => {
  it("unsubscribes at Meta, destroys the secret and withdraws the claim", async () => {
    const test = harness([...happyScript(), success()]);
    const start = await started(test);
    const connected = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );
    const channelAccountId = connected.ok ? connected.channelAccountId : "";

    const result = await disconnectWhatsAppAccount(test.dependencies, context(), channelAccountId);

    expect(result).toEqual({ ok: true, unsubscribed: true });
    expect(test.store.accounts[0]?.status).toBe("DISCONNECTED");
    expect(test.store.connections[0]).toMatchObject({ connectedAt: undefined, webhookSubscribedAt: undefined });
    expect([...test.store.credentials.values()][0]?.revokedAt).toEqual(NOW);
  });

  it("still disconnects locally when Meta refuses the unsubscribe", async () => {
    // The alternative is worse: a workspace told "could not disconnect" while its credential is live and
    // its worker still sending. An unsubscribe that did not land only means Meta keeps delivering events
    // for an account whose route now resolves to a disconnected row and drops them.
    const test = harness([...happyScript(), graphError(400, 200)]);
    const start = await started(test);
    const connected = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    const result = await disconnectWhatsAppAccount(test.dependencies, context(), connected.ok ? connected.channelAccountId : "");

    expect(result).toEqual({ ok: true, unsubscribed: false });
    expect(test.store.accounts[0]?.status).toBe("DISCONNECTED");
  });

  it("reports nothing to disconnect for an account that is not this profile's", async () => {
    const test = harness([]);

    expect(await disconnectWhatsAppAccount(test.dependencies, context(), "ca_someone_else")).toEqual({ ok: false, unsubscribed: false });
  });
});

describe("secret redaction", () => {
  it("never logs the code, the token, the state, the nonce or the PIN", async () => {
    const test = harness([...happyScript(), success()]);
    const start = await started(test);
    const connected = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );
    await disconnectWhatsAppAccount(test.dependencies, context(), connected.ok ? connected.channelAccountId : "");

    const written = JSON.stringify(test.logs);
    expect(written).not.toContain(EXCHANGE_CODE);
    expect(written).not.toContain(BUSINESS_TOKEN);
    expect(written).not.toContain(start.state);
    expect(written).not.toContain(start.cookieNonce);
    expect(written).not.toContain(PIN);
    expect(written).not.toContain("test-app-secret");
    // And it did log something, so the assertions above are not passing on an empty array.
    expect(logged(test.logs, "whatsapp.connected")).toBeDefined();
  });

  it("never returns a secret to the caller, on success or on refusal", async () => {
    const test = harness([exchanged(), debugToken(), phoneNumbers(), graphError(400, 200)]);
    const start = await started(test);

    const refused = await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    const serialized = JSON.stringify(refused);
    expect(serialized).not.toContain(BUSINESS_TOKEN);
    expect(serialized).not.toContain(PIN);
    // Nor the provider's own prose, which quotes the request it refused.
    expect(serialized).not.toContain("Invalid parameter for phone");
  });

  it("keeps the PIN out of persistence entirely", async () => {
    const test = harness(happyScript());
    const start = await started(test);

    await completeWhatsAppConnect(
      test.dependencies,
      { state: start.state, code: EXCHANGE_CODE, notice: finishNotice(), pin: PIN, cookieNonce: start.cookieNonce },
      authorize(),
    );

    // The PIN is the number's two-step verification secret. It is used once for registration and is
    // deliberately not stored: keeping it would add a second secret at rest for a value the operator has.
    expect(JSON.stringify([...test.store.credentials.values()])).not.toContain(PIN);
    expect(JSON.stringify(test.store.connections)).not.toContain(PIN);
  });
});
