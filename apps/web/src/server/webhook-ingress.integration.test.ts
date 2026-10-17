/**
 * The production webhook ingress, end to end (#16).
 *
 * This is the route a real Instagram delivery hits, composed the way the deployment composes it: the real
 * HTTP handlers, the real ingestion use case, the real adapter registry built from validated environment,
 * and a real migrated database. Nothing here is substituted except the outbound clock and the debounce
 * queue, whose own contract is tested elsewhere.
 *
 * It exists because the composition was the broken part. Every piece below — the adapter, the signature
 * check, the normalizer, the store, the outbox — passed its own tests while `adapterFor` returned
 * `undefined` in production, so no webhook ever reached any of them. A test that substituted a registry
 * would have agreed with the broken deployment, which is why this one builds the real one.
 */
import { createHmac } from "node:crypto";

import { ingestWebhook, type IngestionDependencies, type InboundDebouncePayload } from "@omnichannel/application";
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createCredentialCipher,
  createIngestionStore,
  createWorkspaceWithOwner,
  writeChannelCredential,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import type { InstagramHttpPort } from "@omnichannel/channel-instagram";
import { createLogger } from "@omnichannel/observability";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChannelAdapters } from "./channel-adapters";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createWebhookHandlers } from "./webhooks";

const APP_SECRET = "fake-instagram-app-secret";
const VERIFY_TOKEN = "fake-instagram-verify-token";
const CREDENTIAL_KEY_ID = "test-key";
const CIPHER = createCredentialCipher({ keyId: CREDENTIAL_KEY_ID, keys: { [CREDENTIAL_KEY_ID]: Buffer.alloc(32, 9) } });
const EXTERNAL_ACCOUNT_ID = "17841400000000001";
const OTHER_EXTERNAL_ACCOUNT_ID = "17841400000000002";
const CUSTOMER_ID = "18000000000000002";
const AT_MS = 1_789_000_000_000;
/**
 * Anchored to the real clock, not to this file's frozen instant.
 *
 * `channel_credentials` stamps `created_at` itself and `channel_credentials_lifetime_check` requires the
 * expiry to come after it. An expiry computed from a fixed date therefore holds only until the real clock
 * passes it, and then every case here fails because of the date rather than because of a change — which is
 * exactly how PR #90 sat red for five days. The frozen instant stays frozen for everything the database
 * does not constrain; this value cannot be one of them.
 */
const CREDENTIAL_EXPIRES = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

interface Env {
  readonly INSTAGRAM_APP_SECRET: string;
  readonly INSTAGRAM_VERIFY_TOKEN?: string;
  readonly INSTAGRAM_HUMAN_AGENT_APPROVAL: "APPROVED" | "NOT_APPROVED" | "UNKNOWN";
  // WhatsApp is deliberately unconfigured in this suite: it asserts the Instagram path, and an
  // unconfigured channel must bind no adapter rather than half of one (#23).
  readonly WHATSAPP_APP_SECRET?: string;
  readonly WHATSAPP_VERIFY_TOKEN?: string;
  readonly WHATSAPP_GRAPH_VERSION: string;
}

const configured: Env = {
  INSTAGRAM_APP_SECRET: APP_SECRET,
  INSTAGRAM_VERIFY_TOKEN: VERIFY_TOKEN,
  INSTAGRAM_HUMAN_AGENT_APPROVAL: "UNKNOWN",
  WHATSAPP_GRAPH_VERSION: "v26.0",
};

/** A Meta-shaped inbound text message for one account, as bytes plus the signature Meta would send. */
function signedRequest(url: string, body: unknown, options: { readonly secret?: string } = {}): Request {
  const raw = Buffer.from(JSON.stringify(body));
  const digest = createHmac("sha256", options.secret ?? APP_SECRET).update(raw).digest("hex");
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${digest}` },
    body: raw,
  });
}

function inboundEnvelope(externalAccountId: string, messageId: string): unknown {
  return {
    object: "instagram",
    entry: [
      {
        id: externalAccountId,
        time: AT_MS,
        messaging: [
          {
            sender: { id: CUSTOMER_ID },
            recipient: { id: externalAccountId },
            timestamp: AT_MS,
            message: { mid: messageId, text: "Are you open on Saturday?" },
          },
        ],
      },
    ],
  };
}

describe.skipIf(!databaseTestsEnabled())("the production Instagram webhook ingress", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;
  let scope: { workspaceId: string; businessProfileId: string };
  let channelAccountId: string;
  let enqueued: InboundDebouncePayload[];
  let logs: { level: string; event: string; [field: string]: unknown }[];

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const owner = await database.db.user.create({ data: { name: "Ingress Owner", email: "ingress-owner@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(database.db, { name: "Ingress Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: owner.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(database.db, workspace, { name: "Ingress Profile" });
    context = await authorizeBusinessProfileAccess(database.db, { userId: owner.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(database.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: EXTERNAL_ACCOUNT_ID,
      capabilities: { ...NO_CAPABILITIES, text: true },
      // A business that actually uses the product: with AI off the message is still stored, but no reply
      // cycle starts, and the enqueue this test is about would never happen for a reason unrelated to it.
      defaultAiMode: "DRAFT",
    });
    channelAccountId = account.id;
    const { credentialId } = await writeChannelCredential(database.db, CIPHER, {
      workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      token: "token-for-the-account-under-test",
      expiresAt: CREDENTIAL_EXPIRES,
    });
    await database.db.channelAccount.update({ where: { id: channelAccountId }, data: { credentialId } });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** The route as it is mounted in production, over the real ingestion composition. */
  const route = (env: Env, http?: InstagramHttpPort) => {
    enqueued = [];
    logs = [];
    const logger = createLogger({ level: "debug", sink: (line) => logs.push(JSON.parse(line) as (typeof logs)[number]) });
    const dependencies: IngestionDependencies = {
      store: createIngestionStore(database.db),
      adapters: createChannelAdapters({ env, db: database.db, cipher: CIPHER, logger, ...(http === undefined ? {} : { http }) }),
      transcription: { scheduleMediaTranscription: () => Promise.resolve({ jobId: "job_transcribe", queueName: "media-transcription", deduplicated: false }) },
      scheduler: {
        scheduleInboundDebounce: (job) => {
          enqueued.push(job);
          return Promise.resolve(undefined);
        },
      },
      log: logger,
      // The real clock, because the outbox becomes claimable relative to the database's own `now`: a
      // frozen clock in the past would leave every entry "not yet available" and the enqueue this test
      // asserts would fail for a reason that has nothing to do with the route.
      now: () => new Date(),
      random: () => 0.5,
    };
    const handlers = createWebhookHandlers({
      ingest: (request) => ingestWebhook(dependencies, request),
      newCorrelationId: () => "correlation-ingress",
      logger: () => logger,
    });
    const params = Promise.resolve({ channel: "instagram", channelAccountId });
    return {
      post: (body: unknown, options?: { readonly secret?: string }) =>
        handlers.POST(signedRequest(`https://app.example.test/api/webhooks/instagram/${channelAccountId}`, body, options ?? {}), { params }),
      get: (query: Readonly<Record<string, string>>) => {
        const url = new URL(`https://app.example.test/api/webhooks/instagram/${channelAccountId}`);
        for (const [key, value] of Object.entries(query)) {
          url.searchParams.set(key, value);
        }
        return handlers.GET(new Request(url, { method: "GET" }), { params });
      },
    };
  };

  const storedMessages = () => database.db.message.findMany({ where: { ...scope, channelAccountId }, select: { channelMessageId: true, direction: true } });

  it("accepts a correctly signed webhook and persists it through the real ingestion path", async () => {
    const before = await storedMessages();

    const response = await route(configured).post(inboundEnvelope(EXTERNAL_ACCOUNT_ID, "mid.ingress-accepted"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted" });
    // The whole point: the message reached storage, in this account's own Business Profile, and the
    // debounce job that starts the reply cycle was enqueued from the committed outbox.
    const after = await storedMessages();
    expect(after.length).toBe(before.length + 1);
    expect(after.map((message) => message.channelMessageId)).toContain("mid.ingress-accepted");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId, channelAccountId });
  }, 180_000);

  it("rejects an invalid signature before anything is persisted or enqueued", async () => {
    const before = await storedMessages();

    const response = await route(configured).post(inboundEnvelope(EXTERNAL_ACCOUNT_ID, "mid.ingress-forged"), { secret: "not-the-app-secret" });

    expect(response.status).toBe(401);
    // Not merely "no reply": an unverified payload must not become a customer's message at all.
    expect(await storedMessages()).toEqual(before);
    expect(enqueued).toEqual([]);
  }, 180_000);

  it("fails closed when the webhook verify token is not configured", async () => {
    const before = await storedMessages();
    const { INSTAGRAM_VERIFY_TOKEN: _omitted, ...unconfigured } = configured;

    // Correctly signed, and still refused: without a verify token this deployment cannot complete Meta's
    // handshake, so it binds no Instagram adapter rather than half-serving the channel.
    const response = await route(unconfigured).post(inboundEnvelope(EXTERNAL_ACCOUNT_ID, "mid.ingress-unconfigured"));

    expect(response.status).toBe(404);
    expect(await storedMessages()).toEqual(before);
    expect(enqueued).toEqual([]);
    const reported = logs.find((line) => line.event === "webhook.adapter_unconfigured");
    expect(reported).toBeDefined();
    // The reason names the setting, never a value: this log line is read by whoever is holding the secret.
    expect(JSON.stringify(logs)).not.toContain(APP_SECRET);
    expect(JSON.stringify(logs)).not.toContain(VERIFY_TOKEN);
  }, 180_000);

  it("answers Meta's subscription handshake only with the configured token", async () => {
    const accepted = await route(configured).get({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge-1" });
    const refused = await route(configured).get({ "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "challenge-1" });

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("challenge-1");
    expect(refused.status).toBe(401);
  }, 180_000);

  it("resolves the access token of the account the route named, not another in the workspace", async () => {
    // A second Instagram account in the same workspace, in its own Business Profile because one live
    // account per profile is enforced. Credentials are scoped by workspace, so a lookup that did not name
    // the account would be free to pick either token — a reply signed as the wrong business.
    const workspace = await authorizeWorkspaceAccess(database.db, { userId: context.userId, workspaceId: scope.workspaceId });
    const otherProfile = await createBusinessProfile(database.db, workspace, { name: "Ingress Profile Two" });
    const otherContext = await authorizeBusinessProfileAccess(database.db, {
      userId: context.userId,
      workspaceId: scope.workspaceId,
      businessProfileId: otherProfile.businessProfileId,
    });
    const other = await createChannelAccount(database.db, otherContext, {
      channel: "INSTAGRAM",
      externalAccountId: OTHER_EXTERNAL_ACCOUNT_ID,
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    const { credentialId } = await writeChannelCredential(database.db, CIPHER, {
      workspaceId: scope.workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      token: "token-for-the-other-account",
      expiresAt: CREDENTIAL_EXPIRES,
    });
    await database.db.channelAccount.update({ where: { id: other.id }, data: { credentialId } });

    const requests: Parameters<InstagramHttpPort["send"]>[0][] = [];
    const http: InstagramHttpPort = {
      send: (request) => {
        requests.push(request);
        return Promise.resolve({ kind: "RESPONSE" as const, status: 200, body: JSON.stringify({ recipient_id: CUSTOMER_ID, message_id: "mid.out" }) });
      },
    };
    const adapters = createChannelAdapters({ env: configured, db: database.db, cipher: CIPHER, logger: createLogger({ level: "error" }), http });
    const adapter = adapters.adapterFor({
      workspaceId: scope.workspaceId,
      businessProfileId: scope.businessProfileId,
      channelAccountId,
      channel: "INSTAGRAM",
      status: "CONNECTED",
      externalAccountId: EXTERNAL_ACCOUNT_ID,
    });

    await adapter?.send({
      ...scope,
      channelAccountId,
      conversationId: "conversation-unused",
      recipientExternalId: CUSTOMER_ID,
      content: { type: "TEXT", text: "We open at 10 on Saturday." },
      operationId: "op-ingress-scope",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.authorization).toBe("Bearer token-for-the-account-under-test");
    // And the adapter is bound to the account's own external ID, which is what addresses the send.
    expect(requests[0]?.url).toContain(EXTERNAL_ACCOUNT_ID);
    expect(requests[0]?.url).not.toContain(OTHER_EXTERNAL_ACCOUNT_ID);
  }, 180_000);
});
