/**
 * Which transport a send leaves on, decided by the authority it carries (ADR-014).
 *
 * Meta permits a reply outside the standard window only as human support, and only a deliberate human
 * action may initiate one. So the question this file answers is narrow and worth asking directly: does a
 * tagged send happen exactly when a person approved *that* send, and never otherwise? The sender is run
 * against a real database, with the account, its credential and the conversation all read the way
 * production reads them, and a scripted HTTP port records what went on the wire.
 *
 * The second half of the file asks the same question *through the coordinator*, because the sender's own
 * answer is not the system's. A gate before it decides whether the delivery is claimed at all, and while
 * that gate said the exception was unavailable, the transport below it could never be chosen — the sender
 * was correct and unreachable at the same time. A test that calls the sender directly cannot see that.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createCredentialCipher,
  createAiDraftStore,
  appendInboundMessage,
  rotateChannelCredential,
  writeChannelCredential,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { NO_CAPABILITIES, toUserId } from "@omnichannel/domain";
import { coordinateDelivery, noRetrieval, type DeliverySendCommand } from "@omnichannel/application";
import type { InstagramHttpPort } from "@omnichannel/channel-instagram";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDeliveryEngine } from "./delivery-engine";
import { createPaidWorkspace } from "./testing/paid-workspace";
import { createInstagramDeliverySender } from "./instagram-sender";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-20T12:00:00.000Z");
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
/** Inside the human-support window (7 days) but outside the standard one (24 hours). */
const LAST_INBOUND = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
/** The same key the worker would be configured with, so the engine below decrypts what this file wrote. */
const CIPHER_KEY_ID = "test-key";
const CIPHER_KEY = Buffer.alloc(32, 7);
const CIPHER = createCredentialCipher({ keyId: CIPHER_KEY_ID, keys: { [CIPHER_KEY_ID]: CIPHER_KEY } });

/**
 * Records every request, so the assertion is about the wire and not about an intention.
 *
 * The returned message id is unique across the whole file, not per port: an accepted send writes a
 * `messages` row keyed by it, and two tests both reporting `mid-1` would collide on that key — a failure
 * about the fixture wearing the costume of a failure about delivery.
 */
let wireSeq = 0;
function scriptedHttp(): { readonly port: InstagramHttpPort; readonly requests: Parameters<InstagramHttpPort["send"]>[0][] } {
  const requests: Parameters<InstagramHttpPort["send"]>[0][] = [];
  return {
    requests,
    port: {
      send(request) {
        requests.push(request);
        wireSeq += 1;
        return Promise.resolve({
          kind: "RESPONSE" as const,
          status: 200,
          body: JSON.stringify({ recipient_id: "ig-customer", message_id: `mid-out-${String(wireSeq)}` }),
        });
      },
    },
  };
}

describe.skipIf(!endToEndTestsEnabled())("the transport a send leaves on (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let context: BusinessProfileContext;
  let scope: { workspaceId: string; businessProfileId: string };
  let channelAccountId: string;
  let conversationId: string;
  let approverId: string;
  let workspaceContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const owner = await infra.db.user.create({ data: { name: "Transport Owner", email: "transport-owner@example.test" } });
    approverId = owner.id;
    const { workspaceId } = await createPaidWorkspace(infra.db, { name: "Transport Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: owner.id, workspaceId });
    workspaceContext = workspace;
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Transport Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: owner.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-transport",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;

    // A live access token, stored the way onboarding stores one: the sender resolves it per send.
    const { credentialId } = await writeChannelCredential(infra.db, CIPHER, {
      workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      token: "ig-access-token",
      expiresAt: CREDENTIAL_EXPIRES,
    });
    // The account points at its credential, which is how onboarding links them and how the sender finds it.
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { credentialId } });

    const { channelIdentityId } = await createContactWithChannelIdentity(infra.db, context, {
      channelAccountId,
      externalUserId: "ig-customer",
      displayName: "Customer",
    });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId });
    conversationId = conversation.id;
    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      data: { lastInboundAt: LAST_INBOUND },
    });

    // AUTOPILOT, and the business opted into the human-support exception. Both matter: without a policy
    // row the mode is OFF and nothing reaches a transport, and without the exception there is no
    // after-window route for anyone to take — so a failure here would say nothing about the authority.
    await infra.db.automationPolicy.create({
      data: {
        ...scope,
        channelAccountId,
        mode: "AUTOPILOT",
        mandatoryReviewReasons: [],
        instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
      },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  /** A usable draft anchored on the customer's own message, as the engine would leave one. */
  const pendingDraft = async (): Promise<string> => {
    seq += 1;
    const anchor = await appendInboundMessage(infra.db, context, {
      conversationId,
      channelMessageId: `mid-transport-${String(seq)}`,
      kind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt: LAST_INBOUND,
    });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId },
      generationKey: `transport_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchor.id,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
      confidence: 0.9,
      modelSuggestsSend: true,
      needsReview: false,
      reasonCodes: [],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return aiDraftId;
  };

  const send = async (authority: DeliverySendCommand["authority"], approval: "APPROVED" | "NOT_APPROVED" = "APPROVED") => {
    const http = scriptedHttp();
    seq += 1;
    const sender = createInstagramDeliverySender({
      db: infra.db,
      cipher: CIPHER,
      appSecret: "app-secret",
      verifyToken: "verify-token",
      humanAgentApproval: approval,
      now: () => NOW,
      http: http.port,
      logger: infra.logger,
    });

    const result = await sender.send({
      channel: "INSTAGRAM",
      channelAccountId,
      conversationId,
      recipientExternalId: "ig-customer",
      text: "We open at 10 on Saturday.",
      operationId: `op-transport-${String(seq)}`,
      authority,
    });
    return { result, requests: http.requests };
  };

  it("uses the token belonging to the account it is sending from", async () => {
    // A second Instagram account in the same workspace — in another Business Profile, because one live
    // account per profile is enforced. Credentials are scoped by workspace, so a lookup that did not name
    // the account would be free to pick either token, and a reply would go out signed as the wrong
    // business.
    const otherProfile = await createBusinessProfile(infra.db, workspaceContext, { name: "Transport Profile Two" });
    const otherContext = await authorizeBusinessProfileAccess(infra.db, {
      userId: approverId,
      workspaceId: scope.workspaceId,
      businessProfileId: otherProfile.businessProfileId,
    });
    const other = await createChannelAccount(infra.db, otherContext, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-transport-other",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    const { credentialId } = await writeChannelCredential(infra.db, CIPHER, {
      workspaceId: scope.workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      token: "ig-token-for-the-other-account",
      expiresAt: CREDENTIAL_EXPIRES,
    });
    await infra.db.channelAccount.update({ where: { id: other.id }, data: { credentialId } });

    const { result, requests } = await send({ kind: "AUTOMATED" });

    expect(result.outcome).toBe("ACCEPTED");
    expect(requests[0]?.headers?.authorization).toBe("Bearer ig-access-token");
    expect(requests[0]?.headers?.authorization).not.toContain("other-account");
  }, 180_000);

  const approved = (reviewMode: "NORMAL" | "HUMAN_AGENT"): DeliverySendCommand["authority"] => ({
    kind: "HUMAN_APPROVED",
    approvedByUserId: toUserId(approverId),
    approvedAt: NOW,
    reviewMode,
  });

  it("sends automation on the standard transport, with no tag on the wire", async () => {
    const { result, requests } = await send({ kind: "AUTOMATED" });

    expect(result.outcome).toBe("ACCEPTED");
    expect(requests).toHaveLength(1);
    // The tag is what tells Meta this is human support. Automation claiming it is the one thing ADR-014
    // exists to prevent, and `adapter.send` has no parameter that could carry it.
    expect(requests[0]?.body).not.toContain("HUMAN_AGENT");
  }, 180_000);

  it("sends an ordinary approval on the standard transport too", async () => {
    const { result, requests } = await send(approved("NORMAL"));

    // Approving a reply is not agreeing to a tagged send. The person authorized a reply, not a path.
    expect(result.outcome).toBe("ACCEPTED");
    expect(requests[0]?.body).not.toContain("HUMAN_AGENT");
  }, 180_000);

  it("uses the human-support path for an approval that named it", async () => {
    const { result, requests } = await send(approved("HUMAN_AGENT"));

    // Outside the standard window and inside the human-support one: the only permitted route, reached
    // with the authority that permits it and with the approving person's own identity behind it.
    expect(result.outcome).toBe("ACCEPTED");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toContain("HUMAN_AGENT");
  }, 180_000);

  it("dispatches nothing when the app is not approved for human support", async () => {
    const { result, requests } = await send(approved("HUMAN_AGENT"), "NOT_APPROVED");

    // A person's approval makes the path available; it does not make it permitted. The adapter re-checks
    // immediately before dispatch, and a refusal is a refusal rather than an unknown outcome.
    expect(result).toMatchObject({ outcome: "REJECTED", code: "HUMAN_AGENT_NOT_APPROVED" });
    expect(requests).toEqual([]);
  }, 180_000);

  it("dispatches nothing once the human-support window has closed", async () => {
    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      data: { lastInboundAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) },
    });

    const { result, requests } = await send(approved("HUMAN_AGENT"));

    expect(result).toMatchObject({ outcome: "REJECTED", code: "HUMAN_AGENT_EXPIRED" });
    expect(requests).toEqual([]);

    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      data: { lastInboundAt: LAST_INBOUND },
    });
  }, 180_000);

  describe("what a refused token does to the connection (#9)", () => {
    /**
     * The gap this closes: Meta's code 190 is final, so the reply correctly fails and is not retried — and
     * every later reply used to fail the same way while the account still read `CONNECTED`. The Inbox, the
     * setup checklist and the health probe all read that column, so the product said the channel was fine
     * and nobody was ever told to reconnect.
     */
    const refusing = (status: number, body: unknown, duringCall?: () => Promise<void>): InstagramHttpPort => ({
      send: async () => {
        await duringCall?.();
        return { kind: "RESPONSE" as const, status, body: JSON.stringify(body) };
      },
    });

    const sendThrough = async (http: InstagramHttpPort) => {
      seq += 1;
      const sender = createInstagramDeliverySender({
        db: infra.db,
        cipher: CIPHER,
        appSecret: "app-secret",
        verifyToken: "verify-token",
        humanAgentApproval: "APPROVED",
        now: () => NOW,
        http,
        logger: infra.logger,
      });
      return sender.send({
        channel: "INSTAGRAM",
        channelAccountId,
        conversationId,
        recipientExternalId: "ig-customer",
        text: "We open at 10 on Saturday.",
        operationId: `op-credential-${String(seq)}`,
        authority: { kind: "AUTOMATED" },
      });
    };

    const statusOf = async (): Promise<string> =>
      (await infra.db.channelAccount.findUniqueOrThrow({ where: { id: channelAccountId }, select: { status: true } })).status;

    afterEach(async () => {
      // The fixture is shared with the rest of the file, and marking it is the point of these cases.
      await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "CONNECTED" } });
    });

    it("marks the connection as needing re-authorization, and still reports the send as Meta answered it", async () => {
      const result = await sendThrough(refusing(400, { error: { code: 190, error_subcode: 463, message: "session expired" } }));

      // The delivery verdict is unchanged: whether this reply may be retried is Meta's answer and the
      // coordinator's decision, and neither is ours to soften because we learned something about the token.
      expect(result).toMatchObject({ outcome: "REJECTED", retryable: false, code: "190/463" });
      expect(await statusOf()).toBe("NEEDS_REAUTH");
    }, 180_000);

    it("leaves the connection alone when the rejection was about the message", async () => {
      const result = await sendThrough(refusing(400, { error: { code: 100, message: "invalid parameter" } }));

      expect(result).toMatchObject({ outcome: "REJECTED", code: "100" });
      expect(await statusOf()).toBe("CONNECTED");
    }, 180_000);

    it("leaves the connection alone when somebody re-authorized it while Meta was answering", async () => {
      // The interleaving that matters: the operator reconnects *during* the call, so the refusal belongs to
      // a token nobody is using any more. Marking here would tell them to reconnect what they just
      // reconnected — and the account would refuse to send until they did it twice.
      const result = await sendThrough(
        refusing(400, { error: { code: 190, message: "invalid access token" } }, async () => {
          const credentialId = (await infra.db.channelAccount.findUniqueOrThrow({ where: { id: channelAccountId }, select: { credentialId: true } })).credentialId ?? "";
          await rotateChannelCredential(infra.db, CIPHER, {
            workspaceId: scope.workspaceId,
            credentialId,
            purpose: "INSTAGRAM_ACCESS_TOKEN",
            token: "ig-access-token-reconnected",
            expiresAt: CREDENTIAL_EXPIRES,
            refreshedAt: new Date(),
          });
        }),
      );

      expect(result).toMatchObject({ outcome: "REJECTED", code: "190" });
      expect(await statusOf()).toBe("CONNECTED");
    }, 180_000);
  });

  describe("the same question, asked through the coordinator", () => {
    /** The whole path a queued delivery takes: policy gate, atomic claim, then the transport. */
    const deliver = async (options: {
      approval?: "APPROVED" | "NOT_APPROVED" | "UNKNOWN";
      reviewMode?: "NORMAL" | "HUMAN_AGENT";
      automated?: boolean;
      /** Drops the Meta app credentials, as a deployment that was never configured for Instagram has. */
      unconfigured?: boolean;
      /** Applied after the draft's anchor message, which would otherwise move the clock forward itself. */
      lastInboundAt?: Date;
    }) => {
      const http = scriptedHttp();
      seq += 1;
      const operationId = `op-coordinated-${String(seq)}`;
      const draftId = await pendingDraft();
      if (options.lastInboundAt !== undefined) {
        await infra.db.conversation.update({
          where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
          data: { lastInboundAt: options.lastInboundAt },
        });
      }
      await infra.db.deliveryJobRecord.create({
        data: {
          ...scope,
          draftId,
          operationId,
          correlationId: operationId,
          status: "SCHEDULED",
          scheduledFor: NOW,
          selectedDelayMs: 0,
          ...(options.automated === true
            ? {}
            : {
                authority: "HUMAN_APPROVED" as const,
                approvedByUserId: approverId,
                approvedAt: NOW,
                approvedReviewMode: options.reviewMode ?? "HUMAN_AGENT",
                decisionKey: `decision-${operationId}`,
              }),
        },
      });
      if (options.automated !== true) {
        // Approving takes the conversation, which is the state the coordinator will see.
        await infra.db.conversation.update({
          where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
          data: {
            takeoverState: "HUMAN_ACTIVE",
            takeoverReason: "HUMAN_SENT_FROM_INBOX",
            humanTakeoverAt: NOW,
            takeoverActorKind: "USER",
            takeoverActorUserId: approverId,
            takeoverPausedUntil: null,
          },
        });
      }

      // The production composition, not a copy of it: the defect being pinned here was in the wiring, so
      // a test that hand-assembled the same parts would agree with a broken deployment.
      const outcome = await coordinateDelivery(
        createDeliveryEngine(
          {
            ...(options.unconfigured === true
              ? { INSTAGRAM_APP_SECRET: undefined, INSTAGRAM_VERIFY_TOKEN: undefined, CHANNEL_CREDENTIAL_KEY_ID: undefined, CHANNEL_CREDENTIAL_KEY: undefined }
              : {
                  INSTAGRAM_APP_SECRET: "app-secret",
                  INSTAGRAM_VERIFY_TOKEN: "verify-token",
                  CHANNEL_CREDENTIAL_KEY_ID: CIPHER_KEY_ID,
                  CHANNEL_CREDENTIAL_KEY: CIPHER_KEY.toString("base64"),
                }),
            INSTAGRAM_HUMAN_AGENT_APPROVAL: options.approval ?? "APPROVED",
          },
          infra.db,
          infra.logger,
          { http: http.port, now: () => NOW },
        ),
        { operationId, correlationId: operationId },
      );
      const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } });
      return { outcome, requests: http.requests, status: job.status };
    };

    it("dispatches a tagged send for an approval the gate agrees is still eligible", async () => {
      const { outcome, requests, status } = await deliver({});

      // The standard window closed a day ago, so this is the only permitted route — and the gate has to
      // agree the exception exists before the transport ever gets a say. It said UNAVAILABLE, always.
      expect(outcome).toMatchObject({ status: "SENT" });
      expect(status).toBe("SENT");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toContain("HUMAN_AGENT");
    }, 180_000);

    for (const approval of ["UNKNOWN", "NOT_APPROVED"] as const) {
      it(`fails closed with no outbound call when the app's approval is ${approval}`, async () => {
        const { outcome, requests, status } = await deliver({ approval });

        // Nothing about the person changed. The app is not approved for the exception, so there is no
        // permitted route out of a closed window at all.
        expect(outcome.status).not.toBe("SENT");
        expect(status).not.toBe("SENT");
        expect(requests).toEqual([]);
      }, 180_000);
    }

    it("fails closed when this deployment has no Meta app configuration at all", async () => {
      const { outcome, requests, status } = await deliver({ unconfigured: true });

      // No adapter can exist, so there is nothing to re-check: the delivery is refused with a named
      // reason rather than accepted as a send that never happened.
      expect(outcome.status).not.toBe("SENT");
      expect(status).not.toBe("SENT");
      expect(requests).toEqual([]);
    }, 180_000);

    it("fails closed once the exception has expired, however it was approved", async () => {
      // Eight days since the customer last wrote: past the human-support window as well as the standard
      // one. The approval is identical to the one that sends above, so the window is the only difference.
      const { outcome, requests, status } = await deliver({ lastInboundAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) });

      expect(outcome.status).not.toBe("SENT");
      expect(status).not.toBe("SENT");
      expect(requests).toEqual([]);

      await infra.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
        data: { lastInboundAt: LAST_INBOUND },
      });
    }, 180_000);

    it("does not let an ordinary approval out of a closed window at all", async () => {
      const { outcome, requests } = await deliver({ reviewMode: "NORMAL" });

      // The only permitted route is the tagged one, and nobody authorized that. It goes back to a person
      // rather than out on the standard transport.
      expect(outcome.status).not.toBe("SENT");
      expect(requests).toEqual([]);
    }, 180_000);

    it("never lets automation out of a closed window either", async () => {
      const { outcome, requests } = await deliver({ automated: true });

      expect(outcome.status).not.toBe("SENT");
      expect(requests).toEqual([]);
    }, 180_000);
  });
});
