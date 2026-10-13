/**
 * Fetching a customer's recording from WhatsApp, as the worker actually does it (Issue #21).
 *
 * Everything the provider calls need is read per fetch — the phone number, the messaging account, the
 * access token, the connection's state — because a transcription job may have been queued minutes ago and
 * none of those are facts about the past. A test that bound the adapter once could not see that, so this
 * one changes the database between calls and asserts the wire changed with it.
 *
 * The other half is the translation: each provider failure carries a judgement about whether asking again
 * could produce a different answer, and getting that backwards either spends the queue's attempts on an
 * answer that cannot change or gives up on a recording because the network blinked.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createCredentialCipher,
  createWorkspaceWithOwner,
  writeChannelCredential,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import type { WhatsAppHttpPort, WhatsAppHttpResult } from "@omnichannel/channel-whatsapp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createWhatsAppMediaPort } from "./whatsapp-media";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const MEDIA_ID = "1037543291543636";
const MEDIA_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1037543291543636";
const PHONE_NUMBER_ID = "wa-phone-media";
const WABA_ID = "wa-messaging-account-media";
/** Fake, and distinctive, so a log line or a URL that carried it would be unmistakable. */
const TOKEN = "EAAwa-media-token-canary-9f31c7";
const CIPHER_KEY_ID = "test-key";
const CIPHER = createCredentialCipher({ keyId: CIPHER_KEY_ID, keys: { [CIPHER_KEY_ID]: Buffer.alloc(32, 9) } });

const ok = (body: Readonly<Record<string, unknown>>): WhatsAppHttpResult => ({ kind: "RESPONSE", status: 200, body: JSON.stringify(body) });
const located = (overrides: Readonly<Record<string, unknown>> = {}): WhatsAppHttpResult =>
  ok({ messaging_product: "whatsapp", url: MEDIA_URL, mime_type: "audio/ogg", sha256: "abc123", file_size: 8, id: MEDIA_ID, ...overrides });
/** Eight bytes, matching the `file_size` above, because the adapter re-checks the actual length. */
const payload = (): WhatsAppHttpResult => ({ kind: "RESPONSE", status: 200, body: "\u0000".repeat(8) });

describe.skipIf(!endToEndTestsEnabled())("the worker's WhatsApp media port", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let channelAccountId: string;
  let foreign: { workspaceId: string; businessProfileId: string; channelAccountId: string };

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Media Owner", email: "media-owner@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Media Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Media Profile" });
    const context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "WHATSAPP",
      externalAccountId: PHONE_NUMBER_ID,
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    // A connected number is a registered and subscribed one, which the schema insists on: those CHECKs
    // exist so a deployment cannot claim a number is live before Meta confirmed each step.
    await infra.db.whatsAppConnection.create({
      data: { ...scope, channelAccountId, wabaId: WABA_ID, connectedAt: NOW, phoneRegisteredAt: NOW, webhookSubscribedAt: NOW, onboardingMode: "NEW_OR_MIGRATED_CLOUD_NUMBER" },
    });
    const { credentialId } = await writeChannelCredential(infra.db, CIPHER, {
      workspaceId,
      purpose: "WHATSAPP_BUSINESS_TOKEN",
      token: TOKEN,
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
    });
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { credentialId, status: "CONNECTED" } });

    // A second tenant, fully configured, so a forged fetch has somewhere real to point at.
    const otherUser = await infra.db.user.create({ data: { name: "Other Media", email: "media-other@example.test" } });
    const other = await createWorkspaceWithOwner(infra.db, { name: "Other Media Workspace", ownerUserId: otherUser.id });
    const otherWorkspace = await authorizeWorkspaceAccess(infra.db, { userId: otherUser.id, workspaceId: other.workspaceId });
    const otherProfile = await createBusinessProfile(infra.db, otherWorkspace, { name: "Other Media Profile" });
    const otherContext = await authorizeBusinessProfileAccess(infra.db, {
      userId: otherUser.id,
      workspaceId: other.workspaceId,
      businessProfileId: otherProfile.businessProfileId,
    });
    const otherAccount = await createChannelAccount(infra.db, otherContext, {
      channel: "WHATSAPP",
      externalAccountId: "wa-phone-other",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    foreign = { workspaceId: other.workspaceId, businessProfileId: otherProfile.businessProfileId, channelAccountId: otherAccount.id };
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  beforeEach(() => {
    infra.logs.length = 0;
  });

  function scriptedHttp(results: readonly WhatsAppHttpResult[]) {
    const requests: Parameters<WhatsAppHttpPort["send"]>[0][] = [];
    let index = 0;
    const port: WhatsAppHttpPort = {
      send(request) {
        requests.push(request);
        return Promise.resolve(results[Math.min(index++, results.length - 1)] ?? { kind: "NO_RESPONSE", reason: "NETWORK", message: "script exhausted" });
      },
    };
    return { port, requests };
  }

  const portWith = (results: readonly WhatsAppHttpResult[], options: { readonly maxBytes?: number } = {}) => {
    const http = scriptedHttp(results);
    return {
      requests: http.requests,
      media: createWhatsAppMediaPort({
        db: infra.db,
        cipher: CIPHER,
        graphVersion: "v26.0",
        http: http.port,
        logger: infra.logger,
        now: () => NOW,
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      }),
    };
  };

  const input = (overrides: Partial<{ workspaceId: string; businessProfileId: string; channelAccountId: string; providerMediaId: string }> = {}) => ({
    ...scope,
    channelAccountId,
    providerMediaId: MEDIA_ID,
    ...overrides,
  });

  describe("a recording the provider will hand over", () => {
    it("resolves the ID and then downloads it, naming the phone number on the provider's own check", async () => {
      const { media, requests } = portWith([located(), payload()]);

      const result = await media.fetch(input());

      expect(result).toMatchObject({ ok: true, mimeType: "audio/ogg", sizeBytes: 8 });
      // Two requests, which is the documented shape: the URL lives five minutes and is never persisted.
      expect(requests).toHaveLength(2);
      // `phone_number_id` is the provider's own tenancy check on a media ID from an untrusted webhook:
      // without it, one business could resolve another's media.
      expect(requests[0]?.url).toContain(`phone_number_id=${PHONE_NUMBER_ID}`);
      expect(requests[0]?.url).toContain(MEDIA_ID);
      expect(requests[1]?.url).toBe(MEDIA_URL);
    });

    it("reads the token at the moment of the call, so a revoked one fails this fetch", async () => {
      const first = portWith([located(), payload()]);
      expect(await first.media.fetch(input())).toMatchObject({ ok: true });

      // Real time, not the suite's frozen clock: `channel_credentials_lifetime_check` refuses a
      // revocation earlier than the row's own `created_at`, and the row was created just now.
      await infra.db.channelCredential.updateMany({
        where: { workspaceId: scope.workspaceId, purpose: "WHATSAPP_BUSINESS_TOKEN" },
        data: { revokedAt: new Date() },
      });
      const second = portWith([located(), payload()]);
      const afterRevoke = await second.media.fetch(input());
      await infra.db.channelCredential.updateMany({ where: { workspaceId: scope.workspaceId, purpose: "WHATSAPP_BUSINESS_TOKEN" }, data: { revokedAt: null } });

      // Not the attempt after a cache expires: the one right now.
      expect(afterRevoke).toMatchObject({ ok: false, reason: "NO_CREDENTIALS", retryable: false, permanent: false });
      expect(second.requests).toEqual([]);
    });

    it("refuses a disconnected number's media on the account's own state", async () => {
      await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "DISCONNECTED" } });
      const { media, requests } = portWith([located(), payload()]);

      const result = await media.fetch(input());
      await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "CONNECTED" } });

      // A token in the table outlives the authorization it was granted under, so the provider would often
      // allow this. The business removed the integration; the refusal is ours to make, and the adapter
      // makes it on the account's own state rather than on this module's say-so.
      expect(result).toEqual({ ok: false, reason: "ACCOUNT_NOT_CONNECTED", retryable: false, permanent: false });
      expect(requests).toEqual([]);
    });
  });

  describe("a recording that cannot be had", () => {
    it("asks again for an expired URL and never for an unsupported type", async () => {
      // 404 on the resolved URL is Meta's own answer for one that expired, and its documented remedy is
      // to resolve the media ID again — which is exactly what a retry of this job does.
      const expired = portWith([located(), { kind: "RESPONSE", status: 404, body: "" }]);
      const wrongType = portWith([located({ mime_type: "application/zip" })]);

      // Documented remedy for the first: resolve the media ID again for a fresh URL. There is none for
      // the second, however many times it is asked.
      expect(await expired.media.fetch(input())).toMatchObject({ reason: "EXPIRED", retryable: true, permanent: false });
      expect(await wrongType.media.fetch(input())).toMatchObject({ reason: "UNSUPPORTED_TYPE", retryable: false, permanent: true });
    });

    it("refuses an oversize recording before the bytes are transferred", async () => {
      const { media, requests } = portWith([located({ file_size: 32 * 1024 * 1024 }), payload()], { maxBytes: 25 * 1024 * 1024 });

      expect(await media.fetch(input())).toMatchObject({ reason: "TOO_LARGE", retryable: false, permanent: true });
      // The stated size is checked first: downloading 32 MB to then refuse it is the cost this avoids.
      expect(requests).toHaveLength(1);
    });

    it("treats an unreachable provider as worth another attempt", async () => {
      const { media } = portWith([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]);

      // Nothing was produced, so another attempt is safe — unlike an outbound send, a failed reading
      // leaves nothing behind.
      expect(await media.fetch(input())).toMatchObject({ retryable: true, permanent: false });
    });

    it("refuses an account with no WhatsApp connection without asking the provider", async () => {
      const { media, requests } = portWith([located(), payload()]);

      const result = await media.fetch(input({ ...foreign }));

      // No messaging account recorded means there is nothing to ask and nothing to retry against.
      expect(result).toEqual({ ok: false, reason: "NO_BINDING", retryable: false, permanent: true });
      expect(requests).toEqual([]);
    });
  });

  describe("another Workspace's recording", () => {
    it("cannot be fetched by naming this account with that Workspace's id", async () => {
      const { media, requests } = portWith([located(), payload()]);

      const result = await media.fetch(input({ workspaceId: foreign.workspaceId }));

      // The account lookup carries the workspace, so the binding simply does not exist — the provider is
      // never asked, and no token of either tenant is read.
      expect(result).toEqual({ ok: false, reason: "NO_BINDING", retryable: false, permanent: true });
      expect(requests).toEqual([]);
    });

    it("cannot be deleted that way either", async () => {
      const { media, requests } = portWith([ok({ success: true })]);

      expect(await media.delete(input({ workspaceId: foreign.workspaceId }))).toBe(false);
      expect(requests).toEqual([]);
    });
  });

  describe("the retention call", () => {
    it("asks the provider to delete its copy and reports whether it agreed", async () => {
      const agreed = portWith([ok({ success: true })]);
      expect(await agreed.media.delete(input())).toBe(true);
      expect(agreed.requests[0]?.url).toContain(MEDIA_ID);

      const refused = portWith([{ kind: "RESPONSE", status: 400, body: JSON.stringify({ error: { code: 100, message: "no" } }) }]);
      // Best effort by contract: the retention record is only written when the provider agreed, so a
      // failure here leaves the row saying the recording is still theirs — which is the truth.
      expect(await refused.media.delete(input())).toBe(false);
      expect(infra.logs.map((line) => line.event)).toContain("worker.whatsapp_media_delete_failed");
    });
  });

  describe("what reaches the log and the wire", () => {
    it("never puts the access token anywhere but the authorization header", async () => {
      const { media, requests } = portWith([located(), payload()]);

      await media.fetch(input());

      for (const request of requests) {
        expect(request.url).not.toContain(TOKEN);
        expect(request.body ?? "").not.toContain(TOKEN);
      }
      expect(requests.some((request) => Object.values(request.headers).some((value) => value.includes(TOKEN)))).toBe(true);
      expect(JSON.stringify(infra.logs)).not.toContain(TOKEN);
    });

    it("keeps the token out of the log even when the provider refuses", async () => {
      const { media } = portWith([{ kind: "RESPONSE", status: 401, body: JSON.stringify({ error: { code: 190, message: "token expired" } }) }]);

      await media.fetch(input());
      await media.delete(input());

      const serialized = JSON.stringify(infra.logs);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain("token expired");
    });

    it("never puts the recording's bytes in a log line", async () => {
      const { media } = portWith([located(), { kind: "RESPONSE", status: 200, body: "canary-recording-bytes" }]);

      await media.fetch(input());

      expect(JSON.stringify(infra.logs)).not.toContain("canary-recording-bytes");
    });
  });
});
