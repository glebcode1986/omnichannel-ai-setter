/**
 * Which transport a send leaves on, decided by the authority it carries (ADR-014).
 *
 * Meta permits a reply outside the standard window only as human support, and only a deliberate human
 * action may initiate one. So the question this file answers is narrow and worth asking directly: does a
 * tagged send happen exactly when a person approved *that* send, and never otherwise? The sender is run
 * against a real database, with the account, its credential and the conversation all read the way
 * production reads them, and a scripted HTTP port records what went on the wire.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createCredentialCipher,
  createWorkspaceWithOwner,
  writeChannelCredential,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { NO_CAPABILITIES, toUserId } from "@omnichannel/domain";
import type { DeliverySendCommand } from "@omnichannel/application";
import type { InstagramHttpPort } from "@omnichannel/channel-instagram";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInstagramDeliverySender } from "./instagram-sender";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-20T12:00:00.000Z");
/** Inside the human-support window (7 days) but outside the standard one (24 hours). */
const LAST_INBOUND = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
const CIPHER = createCredentialCipher({ keyId: "test-key", keys: { "test-key": Buffer.alloc(32, 7) } });

/** Records every request, so the assertion is about the wire and not about an intention. */
function scriptedHttp(): { readonly port: InstagramHttpPort; readonly requests: Parameters<InstagramHttpPort["send"]>[0][] } {
  const requests: Parameters<InstagramHttpPort["send"]>[0][] = [];
  return {
    requests,
    port: {
      send(request) {
        requests.push(request);
        return Promise.resolve({
          kind: "RESPONSE" as const,
          status: 200,
          body: JSON.stringify({ recipient_id: "ig-customer", message_id: `mid-${String(requests.length)}` }),
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
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Transport Workspace", ownerUserId: owner.id });
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
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
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
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

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
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
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
});
