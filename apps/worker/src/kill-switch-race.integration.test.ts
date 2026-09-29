/**
 * The kill switch against a delivery that is already being judged (Issue #56).
 *
 * `kill-switch.integration.test.ts` turns the switch on before the handler runs, which is the easy half.
 * The half that was broken is the interleaving an operator actually lives in: they pull it while a send is
 * mid-flight. The suspension used to be resolved once, before the coordinator ran, and frozen into the
 * command — so a switch committed while the coordinator was reading and judging was invisible to the
 * claim, whose guard had no predicate for it, and the reply went out behind the operator's back.
 *
 * Deterministic on purpose: the delivery is held at the claim by a promise this file resolves, so the
 * switch commits at a known point rather than a hoped-for one. No sleeps and no retries.
 */
import { noRetrieval } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createAiDraftStore,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createDeliveryStore,
  createSuspensionStore,
  createWorkspaceWithOwner,
  scheduleAutomatedDelivery,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDeliveryHandler } from "./delivery-handler";
import { createChannelStateResolver } from "./delivery-policy";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!endToEndTestsEnabled())("a switch pulled while a send is already being judged", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let ownerUserId: string;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Race Owner", email: "race-owner@example.test" } });
    ownerUserId = user.id;
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Race Workspace", ownerUserId });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Race Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: ownerUserId, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };
    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-race",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    await infra.db.automationPolicy.create({
      data: { ...scope, mode: "AUTOPILOT", mandatoryReviewReasons: [], deliveryDelayMinMs: 0, deliveryDelayMaxMs: 0 },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  afterEach(async () => {
    await infra.db.automationSuspension.deleteMany({});
  });

  const readyToSend = async () => {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-race-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(infra.db, context, { conversationId: conversation.id, kind: "TEXT", text: "Are you open?", occurredAt: NOW });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `race_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchor.id,
      anchorStateVersion: 1,
      text: "We open at 10.",
      structuredOutput: { reply: "We open at 10." },
      confidence: 0.9,
      modelSuggestsSend: true,
      needsReview: false,
      reasonCodes: [],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "fixture",
      model: "race",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId: aiDraftId, correlationId: `corr-race-${String(seq)}`, delayMs: 0, now: NOW });
    return { conversationId: conversation.id, operationId };
  };

  /**
   * The real store with two synchronisation points, which is what makes this a test of the window rather
   * than of the easy case.
   *
   * `hasRead` fires once the coordinator's own read has *returned*: only after that is a switch genuinely
   * committing "after the state was read". Without it the suspension could commit first, the read would
   * see it, and the delivery would be held by the ordinary path — the test would pass against code with
   * the defect still in it, which is precisely what happened before this was added.
   *
   * `release` then holds the delivery at the claim, so the switch commits inside the window and not by
   * luck.
   */
  const storeAroundTheWindow = (hasRead: () => void, release: Promise<void>) => {
    const store = createDeliveryStore(infra.db);
    let reads = 0;
    return {
      ...store,
      loadForSend: async (operationId: string, at: Date) => {
        const context = await store.loadForSend(operationId, at);
        reads += 1;
        // Only the first read opens the window; the re-read after a refused claim must not reopen it.
        if (reads === 1) {
          hasRead();
        }
        return context;
      },
      claim: async (claimContext: Parameters<typeof store.claim>[0], claimedAt: Date) => {
        await release;
        return store.claim(claimContext, claimedAt);
      },
    };
  };

  const deliver = (conversationId: string, operationId: string, hasRead: () => void, release: Promise<void>) => {
    const sends: string[] = [];
    const handler = createDeliveryHandler({
      engine: {
        store: storeAroundTheWindow(hasRead, release),
        sender: {
          send: () => {
            sends.push(operationId);
            return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: `mid-race-${operationId}` });
          },
        },
        channel: createChannelStateResolver(() => NOW),
        log: infra.logger,
        now: () => NOW,
      },
      logger: infra.logger,
    });
    return {
      run: () =>
        handler({
          schemaVersion: 1,
          ...scope,
          correlationId: "corr-race",
          conversationId,
          draftId: "unused",
          deliveryJobId: operationId,
          operationId,
          scheduledFor: NOW.toISOString(),
          selectedDelayMs: 0,
        }),
      sends,
    };
  };

  const heldStateOf = (operationId: string) =>
    infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, lastErrorMessage: true } });

  const scopes = [
    { name: "GLOBAL", input: () => ({ scope: "GLOBAL" as const }) },
    { name: "WORKSPACE", input: () => ({ scope: "WORKSPACE" as const, workspaceId: scope.workspaceId }) },
    {
      name: "BUSINESS_PROFILE",
      input: () => ({ scope: "BUSINESS_PROFILE" as const, workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId }),
    },
    { name: "CHANNEL_ACCOUNT", input: () => ({ scope: "CHANNEL_ACCOUNT" as const, workspaceId: scope.workspaceId, channelAccountId }) },
  ];

  for (const { name, input } of scopes) {
    it(`stops a send whose ${name} switch commits after the state was read`, async () => {
      const { conversationId, operationId } = await readyToSend();
      let go = (): void => undefined;
      let read = (): void => undefined;
      const release = new Promise<void>((resolve) => {
        go = resolve;
      });
      const hasRead = new Promise<void>((resolve) => {
        read = resolve;
      });
      const { run, sends } = deliver(conversationId, operationId, read, release);

      const running = run();
      // The read has returned with no switch in it, and the delivery is waiting at the claim: exactly the
      // window in which the old code had already decided there was nothing to honour.
      await hasRead;
      await createSuspensionStore(infra.db).suspend({ ...input(), reason: "OPERATOR", since: NOW, byUserId: ownerUserId });
      go();
      await running;

      // Nothing reached the adapter, and the work survived for when the switch is lifted.
      expect(sends).toEqual([]);
      const held = await heldStateOf(operationId);
      expect(held.status).toBe("HELD_REVIEW");
      // Held *for this reason*: any number of other gates would also have stopped it, and a test that did
      // not say which one would pass against a delivery broken in some entirely different way.
      expect(held.lastErrorMessage).toContain("AUTOMATION_SUSPENDED");
    }, 180_000);
  }

  /**
   * The same window, with the writer an operator actually uses.
   *
   * `RELIABILITY_INCIDENTS.md` says this is a table people write to by hand during an incident, and there
   * is no operator HTTP surface in this version — so a direct `INSERT` is not an exotic bypass, it is the
   * documented way the switch gets pulled. An ordering enforced in a store method would not bind it at
   * all, which is why the ordering lives in a trigger on the table. Nothing below goes through
   * `createSuspensionStore`, and all four scopes are covered because the trigger derives the key per row
   * rather than per caller.
   */
  for (const { name, columns, values } of [
    { name: "GLOBAL", columns: "", values: () => [] as string[] },
    { name: "WORKSPACE", columns: ', "workspace_id"', values: () => [scope.workspaceId] },
    { name: "BUSINESS_PROFILE", columns: ', "workspace_id", "business_profile_id"', values: () => [scope.workspaceId, scope.businessProfileId] },
    { name: "CHANNEL_ACCOUNT", columns: ', "workspace_id", "channel_account_id"', values: () => [scope.workspaceId, channelAccountId] },
  ]) {
    it(`stops a send when a ${name} switch arrives as a direct SQL insert`, async () => {
      const { conversationId, operationId } = await readyToSend();
      let go = (): void => undefined;
      let read = (): void => undefined;
      const release = new Promise<void>((resolve) => {
        go = resolve;
      });
      const hasRead = new Promise<void>((resolve) => {
        read = resolve;
      });
      const { run, sends } = deliver(conversationId, operationId, read, release);

      const running = run();
      await hasRead;
      const scopeColumnValues = values();
      const placeholders = scopeColumnValues.map((_, index) => `$${String(index + 4)}`).join(", ");
      await infra.db.$executeRawUnsafe(
        `INSERT INTO "automation_suspensions" ("id", "scope", "reason", "since", "by_user_id", "updated_at"${columns})
         VALUES (gen_random_uuid()::text, '${name}', 'OPERATOR', $1, $2, $3${scopeColumnValues.length === 0 ? "" : `, ${placeholders}`})`,
        NOW,
        ownerUserId,
        NOW,
        ...scopeColumnValues,
      );
      go();
      await running;

      expect(sends).toEqual([]);
      const held = await heldStateOf(operationId);
      expect(held.status).toBe("HELD_REVIEW");
      expect(held.lastErrorMessage).toContain("AUTOMATION_SUSPENDED");
    }, 180_000);
  }

  it("still sends when the thing that commits in that window is not a switch that covers it", async () => {
    // The same interleaving with a switch on another workspace. Without this the test above would pass
    // just as well against code that refused every delivery it had paused.
    const { conversationId, operationId } = await readyToSend();
    const otherWorkspace = await createWorkspaceWithOwner(infra.db, { name: "Someone Else", ownerUserId });
    let go = (): void => undefined;
    let read = (): void => undefined;
    const release = new Promise<void>((resolve) => {
      go = resolve;
    });
    const hasRead = new Promise<void>((resolve) => {
      read = resolve;
    });
    const { run, sends } = deliver(conversationId, operationId, read, release);

    const running = run();
    await hasRead;
    await createSuspensionStore(infra.db).suspend({
      scope: "WORKSPACE",
      workspaceId: otherWorkspace.workspaceId,
      reason: "OPERATOR",
      since: NOW,
      byUserId: ownerUserId,
    });
    go();
    await running;

    expect(sends).toEqual([operationId]);
    expect((await heldStateOf(operationId)).status).toBe("SENT");
  }, 180_000);
});

/**
 * The ordering itself, rather than its consequence.
 *
 * The suite above proves a switch committed *before* the claim is honoured — which a predicate inside the
 * claim's transaction is enough for on its own. It says nothing about the sub-window the predicate cannot
 * close: a switch committing after the claim's statement snapshot and before it commits. Only a lock both
 * sides take can close that, and a lock nothing tests is decoration.
 *
 * So these two assert the lock directly, from the other end: hold the key and watch the other side wait
 * for it. `pg_locks` is polled for an ungranted advisory lock rather than a timer being trusted, so the
 * test states a fact about the database instead of about how fast this machine is.
 */
describe.skipIf(!endToEndTestsEnabled())("the claim and the switch take the same key", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let ownerUserId: string;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Lock Owner", email: "lock-owner@example.test" } });
    ownerUserId = user.id;
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Lock Workspace", ownerUserId });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Lock Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: ownerUserId, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };
    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-lock",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    await infra.db.automationPolicy.create({
      data: { ...scope, mode: "AUTOPILOT", mandatoryReviewReasons: [], deliveryDelayMinMs: 0, deliveryDelayMaxMs: 0 },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  afterEach(async () => {
    await infra.db.automationSuspension.deleteMany({});
  });

  const scheduled = async () => {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-lock-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(infra.db, context, { conversationId: conversation.id, kind: "TEXT", text: "Open?", occurredAt: NOW });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `lock_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchor.id,
      anchorStateVersion: 1,
      text: "We open at 10.",
      structuredOutput: { reply: "We open at 10." },
      confidence: 0.9,
      modelSuggestsSend: true,
      needsReview: false,
      reasonCodes: [],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "fixture",
      model: "lock",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId: aiDraftId, correlationId: `corr-lock-${String(seq)}`, delayMs: 0, now: NOW });
    return operationId;
  };

  /** Holds one advisory key until the returned `release` is called. */
  const holdingKey = (key: string, mode: "exclusive" | "shared") => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = infra.db.$transaction(
      async (tx) => {
        if (mode === "exclusive") {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        } else {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
        }
        // Signals that the key is actually held before anyone is asked to wait for it.
        taken();
        await held;
      },
      { timeout: 60_000 },
    );
    let taken = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      taken = resolve;
    });
    return { ready, release, transaction };
  };

  /** Resolves once someone is waiting on an advisory lock, which is the fact under test. */
  const waitingOnAdvisoryLock = async (): Promise<void> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await infra.db.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (Number(rows[0]?.waiting ?? 0n) > 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("nobody ever waited on the advisory key");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("makes a claim wait while a switch is being turned on", async () => {
    const operationId = await scheduled();
    const store = createDeliveryStore(infra.db);
    const sendContext = await store.loadForSend(operationId, NOW);
    if (sendContext === undefined) {
      throw new Error("no delivery context");
    }
    const lock = holdingKey("GLOBAL", "exclusive");
    await lock.ready;

    // The claim must block here. If it did not take the key at all it would sail through, and the poll
    // below would time out rather than the claim waiting — which is exactly what makes this a test.
    const claiming = store.claim(sendContext, NOW);
    await waitingOnAdvisoryLock();

    lock.release();
    await lock.transaction;
    expect(await claiming).toEqual({ kind: "CLAIMED" });
  }, 180_000);

  /**
   * A row that already exists can start or stop covering a send, so the trigger fires on more than
   * `INSERT`. Editing one by hand during an incident is the same operator path as writing one.
   */
  it("makes editing a switch into coverage wait for the claims already in flight", async () => {
    // A switch that covers nothing here, so the edit below is what changes coverage.
    const inserted = await infra.db.$queryRaw<{ id: string }[]>`
      INSERT INTO "automation_suspensions" ("id", "scope", "workspace_id", "reason", "since", "by_user_id", "updated_at")
      VALUES (gen_random_uuid()::text, 'WORKSPACE', 'ws-somewhere-else', 'OPERATOR', ${NOW}, ${ownerUserId}, ${NOW})
      RETURNING "id"`;
    const id = inserted[0]?.id ?? "";
    const lock = holdingKey(`WORKSPACE:${scope.workspaceId}`, "shared");
    await lock.ready;

    const editing = (async () =>
      infra.db.$executeRaw`UPDATE "automation_suspensions" SET "workspace_id" = ${scope.workspaceId} WHERE "id" = ${id}`)();
    await waitingOnAdvisoryLock();

    lock.release();
    await lock.transaction;
    expect(await editing).toBe(1);
  }, 180_000);

  it("makes removing a switch wait too, so coverage cannot change underneath a claim", async () => {
    const inserted = await infra.db.$queryRaw<{ id: string }[]>`
      INSERT INTO "automation_suspensions" ("id", "scope", "workspace_id", "reason", "since", "by_user_id", "updated_at")
      VALUES (gen_random_uuid()::text, 'WORKSPACE', ${scope.workspaceId}, 'OPERATOR', ${NOW}, ${ownerUserId}, ${NOW})
      RETURNING "id"`;
    const id = inserted[0]?.id ?? "";
    const lock = holdingKey(`WORKSPACE:${scope.workspaceId}`, "shared");
    await lock.ready;

    // Deleting only ever makes a claim more permissive, so this ordering is not what keeps a send safe —
    // it is what keeps the set of covering switches stable for the length of a claim, which is the
    // property the re-read inside the claim is entitled to rely on.
    const deleting = (async () => infra.db.$executeRaw`DELETE FROM "automation_suspensions" WHERE "id" = ${id}`)();
    await waitingOnAdvisoryLock();

    lock.release();
    await lock.transaction;
    expect(await deleting).toBe(1);
  }, 180_000);

  it("makes turning a switch on wait for the claims already in flight, even by raw SQL", async () => {
    const lock = holdingKey("GLOBAL", "shared");
    await lock.ready;

    // The writer's side of the same key, and deliberately not through `createSuspensionStore`: the
    // ordering has to bind the direct insert an operator runs, or it binds nothing that matters. What
    // makes this wait is the trigger on the table, not any application code in the path.
    // Started rather than merely constructed: a Prisma raw call is a lazy promise, and one that is only
    // assigned has not reached the database at all — the poll below would then be waiting for nobody.
    const inserting = (async () =>
      infra.db.$executeRaw`
        INSERT INTO "automation_suspensions" ("id", "scope", "reason", "since", "by_user_id", "updated_at")
        VALUES (gen_random_uuid()::text, 'GLOBAL', 'OPERATOR', ${NOW}, ${ownerUserId}, ${NOW})`)();
    await waitingOnAdvisoryLock();

    lock.release();
    await lock.transaction;
    // It did commit once the key was free; a writer that gave up would be a different failure.
    expect(await inserting).toBe(1);
  }, 180_000);
});
