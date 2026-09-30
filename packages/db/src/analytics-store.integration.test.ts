/**
 * Operational metrics (Issue #34).
 *
 * Fixtures are written with explicit timestamps rather than "now", because every assertion here is about a
 * boundary: which day a message falls on, which side of a range it sits, and whether a wait that has not
 * ended yet counts as a fast reply. A fixture that used the clock would pass or fail depending on when the
 * suite ran, which is the opposite of what these tests are for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deliveryOutcomes,
  draftOutcomes,
  firstResponseTimes,
  inboundVolume,
  leadMovement,
  missingFactFrequency,
  modelUsage,
  readOperationalSnapshot,
  reviewReasons,
  takeoverRate,
  type MetricWindow,
} from "./analytics-store";
import { addWorkspaceMember } from "./repositories/workspaces";
import { authorizeWorkspaceAccess } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

/** Madrid is UTC+2 in October, so 22:30 UTC is already the next local day. That is the whole point. */
const MADRID = "Europe/Madrid";
const DAY_ONE = new Date("2026-10-01T00:00:00.000Z");
const WINDOW: MetricWindow = { from: DAY_ONE, to: new Date("2026-10-08T00:00:00.000Z"), timeZone: MADRID };
const utc = (iso: string) => new Date(iso);

describe.skipIf(!databaseTestsEnabled())("operational metrics", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let second: SeededProfile;
  let neighbour: SeededWorkspace;
  let ownerContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let narrowContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let neighbourContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "metrics", ["main", "second"]);
    [profile, second] = workspace.profiles as [SeededProfile, SeededProfile];
    neighbour = await seedWorkspace(database.db, "metrics-neighbour");
    ownerContext = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: workspace.workspaceId });
    neighbourContext = await authorizeWorkspaceAccess(database.db, { userId: neighbour.ownerUserId, workspaceId: neighbour.workspaceId });

    const narrow = await database.db.user.create({ data: { name: "Metrics Narrow", email: "metrics-narrow@example.test" } });
    await addWorkspaceMember(database.db, ownerContext, {
      userId: narrow.id,
      role: "ADMIN",
      businessProfileScope: { selected: [profile.businessProfileId] },
    });
    narrowContext = await authorizeWorkspaceAccess(database.db, { userId: narrow.id, workspaceId: workspace.workspaceId });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  const inbound = async (at: Date, target: SeededProfile = profile) => {
    seq += 1;
    return db().message.create({
      data: {
        workspaceId: target.context.workspaceId,
        businessProfileId: target.businessProfileId,
        channelAccountId: target.channelAccount.id,
        conversationId: target.conversationId,
        direction: "IN",
        source: "PARTICIPANT",
        kind: "TEXT",
        text: `in ${String(seq)}`,
        occurredAt: at,
      },
      select: { id: true },
    });
  };

  const outbound = async (
    at: Date,
    options: { deliveryStatus?: "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED"; target?: SeededProfile } = {},
  ) => {
    const target = options.target ?? profile;
    seq += 1;
    return db().message.create({
      data: {
        workspaceId: target.context.workspaceId,
        businessProfileId: target.businessProfileId,
        channelAccountId: target.channelAccount.id,
        conversationId: target.conversationId,
        direction: "OUT",
        source: "AI",
        kind: "TEXT",
        text: `out ${String(seq)}`,
        transportPath: "STANDARD",
        occurredAt: at,
        ...(options.deliveryStatus === undefined ? {} : { deliveryStatus: options.deliveryStatus }),
      },
      select: { id: true },
    });
  };

  describe("inbound volume, by local day", () => {
    beforeAll(async () => {
      // 22:30 UTC on the 1st is 00:30 on the 2nd in Madrid. A metric that bucketed in UTC would put this
      // on the wrong day and nothing on screen would explain why the totals disagreed with the inbox.
      await inbound(utc("2026-10-01T09:00:00.000Z"));
      await inbound(utc("2026-10-01T10:00:00.000Z"));
      await inbound(utc("2026-10-01T22:30:00.000Z"));
    });

    it("puts a late-evening message on the local day it arrived, not the UTC one", async () => {
      const madrid = await inboundVolume(db(), ownerContext, WINDOW);
      const utcView = await inboundVolume(db(), ownerContext, { ...WINDOW, timeZone: "UTC" });

      expect(madrid.find((point) => point.day === "2026-10-01")?.inboundMessages).toBe(2);
      expect(madrid.find((point) => point.day === "2026-10-02")?.inboundMessages).toBe(1);
      // The same rows, bucketed by a different zone, give a different answer — which is exactly why the
      // zone is a required parameter rather than a default somebody would never notice.
      expect(utcView.find((point) => point.day === "2026-10-01")?.inboundMessages).toBe(3);
    }, 180_000);

    it("counts messages and the conversations they came in separately", async () => {
      const points = await inboundVolume(db(), ownerContext, WINDOW);

      // Ten messages from one person and one message from ten people are the same number and not the
      // same day.
      expect(points.find((point) => point.day === "2026-10-01")?.inboundConversations).toBe(1);
      expect(points.find((point) => point.day === "2026-10-01")?.inboundMessages).toBe(2);
    }, 180_000);

    it("excludes a message on the exclusive end of the window and includes one on the inclusive start", async () => {
      await inbound(utc("2026-10-08T00:00:00.000Z"));
      await inbound(DAY_ONE);

      const days = (await inboundVolume(db(), ownerContext, WINDOW)).map((point) => point.day);

      expect(days).not.toContain("2026-10-08");
      // `from` inclusive, `to` exclusive: the only pair that lets adjacent ranges tile without counting
      // the boundary twice.
      expect(days).toContain("2026-10-01");
    }, 180_000);

    it("refuses a window with no timezone, rather than guessing UTC", async () => {
      await expect(inboundVolume(db(), ownerContext, { ...WINDOW, timeZone: "  " })).rejects.toThrow(/time zone/u);
    }, 180_000);

    it("refuses a window that ends before it starts", async () => {
      await expect(inboundVolume(db(), ownerContext, { ...WINDOW, to: WINDOW.from })).rejects.toThrow(/ends after it starts/u);
    }, 180_000);
  });

  describe("first-response time", () => {
    let responder: SeededProfile;

    beforeAll(async () => {
      // Its own profile, because response time is the one metric where another test's stray message
      // changes the answer.
      const fresh = await seedWorkspace(db(), "metrics-response");
      [responder] = fresh.profiles as [SeededProfile];
      // The seed leaves an unanswered inbound message in the conversation, dated before this window.
      // Answering it first is what makes the burst below a *new* wait rather than the continuation of
      // that one — which is the distinction the next test is about.
      await outbound(utc("2026-10-02T00:00:00.000Z"), { target: responder });
      // A burst of three, answered once after 60s from the first.
      await inbound(utc("2026-10-03T08:00:00.000Z"), responder);
      await inbound(utc("2026-10-03T08:00:10.000Z"), responder);
      await inbound(utc("2026-10-03T08:00:20.000Z"), responder);
      await outbound(utc("2026-10-03T08:01:00.000Z"), { target: responder });
      // A second cycle, answered after 20s.
      await inbound(utc("2026-10-03T09:00:00.000Z"), responder);
      await outbound(utc("2026-10-03T09:00:20.000Z"), { target: responder });
    });

    const responderContext = () => authorizeWorkspaceAccess(db(), { userId: responder.context.userId, workspaceId: responder.context.workspaceId });

    it("counts a burst of messages as one wait, from the first of them", async () => {
      const times = await firstResponseTimes(db(), await responderContext(), WINDOW);

      // Two cycles, not four. A customer who sends three messages in a row is waiting once, and counting
      // each would flatter the median every time somebody types the way people actually type.
      expect(times.samples).toBe(2);
      expect(times.medianSeconds).toBe(40);
    }, 180_000);

    it("ignores a question still waiting, rather than calling it fast", async () => {
      await inbound(utc("2026-10-04T08:00:00.000Z"), responder);

      const times = await firstResponseTimes(db(), await responderContext(), WINDOW);

      // Its wait is not over. Treating "not yet answered" as a zero-second reply is the one direction
      // this metric must never be wrong in.
      expect(times.samples).toBe(2);
      expect(times.medianSeconds).toBe(40);
    }, 180_000);

    it("says nothing rather than zero when there is nothing to measure", async () => {
      const quiet = await firstResponseTimes(db(), await responderContext(), {
        from: utc("2026-11-01T00:00:00.000Z"),
        to: utc("2026-11-02T00:00:00.000Z"),
        timeZone: MADRID,
      });

      // "0s median" for a week nobody wrote in would be the best-looking number on the page and a
      // complete fiction.
      expect(quiet).toEqual({ samples: 0, medianSeconds: null, p90Seconds: null });
    }, 180_000);

    it("does not count a wait that began before the window", async () => {
      const later: MetricWindow = { from: utc("2026-10-03T08:30:00.000Z"), to: utc("2026-10-03T23:00:00.000Z"), timeZone: MADRID };

      const times = await firstResponseTimes(db(), await responderContext(), later);

      // The 08:00 burst was answered at 08:01, inside no window that starts at 08:30. Its wait belongs to
      // the period it started in, and counting it here would let one slow reply be reported twice —
      // once in each adjacent range — or vanish from both depending on which end we measured.
      expect(times.samples).toBe(1);
      expect(times.medianSeconds).toBe(20);
    }, 180_000);

    it("reports a p90 above the median when the waits differ", async () => {
      const times = await firstResponseTimes(db(), await responderContext(), WINDOW);

      expect(times.p90Seconds).toBeGreaterThanOrEqual(times.medianSeconds ?? 0);
    }, 180_000);
  });

  describe("application state and provider state", () => {
    let accepted: string;

    beforeAll(async () => {
      const draft = await db().aiDraft.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: 1,
          generationKey: "metrics-accepted",
          trigger: "AUTOMATIC",
          text: "A reply we accepted",
          structuredOutput: { reply: "x" },
          confidence: 0.9,
          modelSuggestsSend: true,
          needsReview: false,
          status: "SENT",
          modelProvider: "anthropic",
          modelName: "claude-opus-5",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
          inputTokens: 900,
          outputTokens: 120,
          latencyMs: 800,
          createdAt: utc("2026-10-02T10:00:00.000Z"),
        },
        select: { id: true },
      });
      accepted = draft.id;
      await db().deliveryJobRecord.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          draftId: accepted,
          operationId: "metrics-op-accepted",
          correlationId: "metrics-corr-accepted",
          status: "SENT",
          scheduledFor: utc("2026-10-02T10:00:30.000Z"),
          selectedDelayMs: 30_000,
          authority: "AUTOMATED",
          sentAt: utc("2026-10-02T10:00:35.000Z"),
          // `delivery_jobs_sent_check` insists a SENT job names the message the provider gave back.
          platformMessageId: "metrics-platform-accepted",
          createdAt: utc("2026-10-02T10:00:00.000Z"),
        },
      });
      // The message we handed over, about which the provider has said nothing at all.
      await outbound(utc("2026-10-02T10:00:35.000Z"));
    });

    it("never infers delivered from the fact that we sent it", async () => {
      const outcomes = await deliveryOutcomes(db(), ownerContext, WINDOW);

      // We gave it to the provider. The provider has not said it arrived.
      expect(outcomes.application.handedToProvider).toBeGreaterThan(0);
      expect(outcomes.provider.reportedDelivered).toBe(0);
      expect(outcomes.provider.reportedRead).toBe(0);
      // And the honest name for that state is on the result, so the UI has something true to render.
      expect(outcomes.provider.awaitingReport).toBeGreaterThan(0);
    }, 180_000);

    it("keeps the provider's own report separate once it arrives", async () => {
      await outbound(utc("2026-10-02T11:00:00.000Z"), { deliveryStatus: "DELIVERED" });
      await outbound(utc("2026-10-02T11:05:00.000Z"), { deliveryStatus: "READ" });
      await outbound(utc("2026-10-02T11:10:00.000Z"), { deliveryStatus: "FAILED" });

      const outcomes = await deliveryOutcomes(db(), ownerContext, WINDOW);

      expect(outcomes.provider.reportedDelivered).toBe(1);
      expect(outcomes.provider.reportedRead).toBe(1);
      expect(outcomes.provider.reportedFailed).toBe(1);
      // The two groups are never added together. `handedToProvider` counts delivery jobs; the provider
      // numbers count messages. A dashboard that summed them would let somebody tell a customer "it was
      // delivered" on our word alone.
      expect(Object.keys(outcomes)).toEqual(["application", "provider", "ambiguous"]);
    }, 180_000);

    it("counts an ambiguous send as ambiguous, not as sent or failed", async () => {
      const draft = await db().aiDraft.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: 1,
          generationKey: "metrics-ambiguous",
          trigger: "AUTOMATIC",
          text: "A reply whose fate we do not know",
          structuredOutput: { reply: "x" },
          confidence: 0.8,
          modelSuggestsSend: true,
          needsReview: false,
          status: "HELD_AMBIGUOUS",
          modelProvider: "anthropic",
          modelName: "claude-opus-5",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
          createdAt: utc("2026-10-02T12:00:00.000Z"),
        },
        select: { id: true },
      });
      const job = await db().deliveryJobRecord.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          draftId: draft.id,
          operationId: "metrics-op-ambiguous",
          correlationId: "metrics-corr-ambiguous",
          status: "HELD_AMBIGUOUS",
          scheduledFor: utc("2026-10-02T12:00:30.000Z"),
          selectedDelayMs: 30_000,
          createdAt: utc("2026-10-02T12:00:00.000Z"),
        },
        select: { id: true },
      });
      await db().deliveryReconciliation.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          operationId: "metrics-op-ambiguous",
          deliveryJobId: job.id,
          conversationId: profile.conversationId,
          reason: "DELIVERY_STALLED",
          state: "PENDING",
          attemptCount: 1,
          detectedAt: utc("2026-10-02T12:01:00.000Z"),
          createdAt: utc("2026-10-02T12:01:00.000Z"),
        },
      });

      const outcomes = await deliveryOutcomes(db(), ownerContext, WINDOW);

      // "We do not know" is its own answer. Folding it into either certainty would be a claim nobody can
      // support (ADR-012).
      expect(outcomes.ambiguous.open).toBe(1);
      expect(outcomes.application.heldAmbiguous).toBe(1);
    }, 180_000);

    it("keeps review work visible even when the send later failed", async () => {
      const outcomes = await draftOutcomes(db(), ownerContext, WINDOW);

      // Counted by the draft's status and its delivery's authority, not by the message that resulted.
      expect(outcomes.generated).toBeGreaterThan(0);
      expect(outcomes.autoSent).toBe(1);
      expect(outcomes.heldAmbiguous).toBe(1);
    }, 180_000);
  });

  describe("review reasons and the knowledge gap", () => {
    beforeAll(async () => {
      const draft = (key: string, reasons: string[], at: Date) =>
        db().aiDraft.create({
          data: {
            workspaceId: profile.context.workspaceId,
            businessProfileId: profile.businessProfileId,
            conversationId: profile.conversationId,
            anchorMessageId: profile.messageId,
            anchorStateVersion: 1,
            generationKey: key,
            trigger: "AUTOMATIC",
            text: "Needs a person",
            structuredOutput: { reply: "x" },
            confidence: 0.4,
            modelSuggestsSend: false,
            needsReview: true,
            reasonCodes: reasons,
            status: "PENDING",
            modelProvider: "anthropic",
            modelName: "claude-opus-5",
            promptVersion: "reply.v1",
            schemaVersion: "ai-draft.v1",
            createdAt: at,
          },
        });
      await draft("metrics-r1", ["LOW_CONFIDENCE", "MISSING_FACT"], utc("2026-10-05T08:00:00.000Z"));
      await draft("metrics-r2", ["MISSING_FACT"], utc("2026-10-05T09:00:00.000Z"));
      await draft("metrics-r3", ["WINDOW_CLOSED"], utc("2026-10-05T10:00:00.000Z"));
    });

    it("counts a draft under every reason it carries", async () => {
      const reasons = await reviewReasons(db(), ownerContext, WINDOW);

      // The question is "what is holding replies up". Attributing a draft with three reasons to one of
      // them would understate the other two.
      expect(reasons.find((row) => row.reason === "MISSING_FACT")?.drafts).toBe(2);
      expect(reasons.find((row) => row.reason === "LOW_CONFIDENCE")?.drafts).toBe(1);
      expect(reasons.find((row) => row.reason === "WINDOW_CLOSED")?.drafts).toBe(1);
      // So the totals do not sum to the draft count, which the definitions state rather than paper over.
      const total = reasons.reduce((sum, row) => sum + row.drafts, 0);
      expect(total).toBeGreaterThan((await draftOutcomes(db(), ownerContext, WINDOW)).awaitingReview);
    }, 180_000);

    it("reports the missing-fact share against the drafts generated", async () => {
      const missing = await missingFactFrequency(db(), ownerContext, WINDOW);
      const drafts = await draftOutcomes(db(), ownerContext, WINDOW);

      expect(missing.drafts).toBe(2);
      expect(missing.share).toBeCloseTo(2 / drafts.generated, 3);
    }, 180_000);

    it("says nothing rather than zero percent when nothing was generated", async () => {
      const quiet = await missingFactFrequency(db(), ownerContext, {
        from: utc("2026-12-01T00:00:00.000Z"),
        to: utc("2026-12-02T00:00:00.000Z"),
        timeZone: MADRID,
      });

      // A 0% on screen reads as "knowledge is complete", which is a different claim from "we did not ask".
      expect(quiet).toEqual({ drafts: 0, share: null });
    }, 180_000);

    it("agrees with itself: the snapshot's share matches its own reason table", async () => {
      const snapshot = await readOperationalSnapshot(db(), ownerContext, WINDOW);

      const fromTable = snapshot.reviewReasons.find((row) => row.reason === "MISSING_FACT")?.drafts ?? 0;
      // Computed from results already in hand rather than by asking again, so the page cannot show a
      // share that disagrees with the table beside it.
      expect(snapshot.missingFacts.drafts).toBe(fromTable);
    }, 180_000);
  });

  describe("takeover and leads", () => {
    beforeAll(async () => {
      await db().conversation.update({
        where: { workspaceId_businessProfileId_id: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId, id: profile.conversationId } },
        // The full quartet `conversations_takeover_state_check` requires for HUMAN_ACTIVE: a reason and a
        // time, and no review mode. A partial update is refused, which is the constraint doing its job.
        data: {
          takeoverState: "HUMAN_ACTIVE",
          takeoverReason: "HUMAN_CLAIMED",
          humanTakeoverAt: utc("2026-10-06T08:00:00.000Z"),
          takeoverActorKind: "USER",
          takeoverActorUserId: workspace.ownerUserId,
        },
      });
      const transition = (from: string | null, to: string, at: Date) =>
        db().leadStageTransition.create({
          data: {
            workspaceId: profile.context.workspaceId,
            businessProfileId: profile.businessProfileId,
            conversationId: profile.conversationId,
            ...(from === null ? {} : { fromStage: from as never }),
            toStage: to as never,
            source: "HUMAN_SET",
            actorUserId: workspace.ownerUserId,
            changedAt: at,
          },
        });
      await transition("NEW", "ENGAGED", utc("2026-10-06T09:00:00.000Z"));
      await transition("ENGAGED", "QUALIFIED", utc("2026-10-06T10:00:00.000Z"));
      await transition("QUALIFIED", "LOST", utc("2026-10-06T11:00:00.000Z"));
    });

    it("measures takeover against conversations that actually received a message", async () => {
      const rate = await takeoverRate(db(), ownerContext, WINDOW);

      // A rate measured against threads nobody wrote in would fall every quiet week and look like an
      // improvement.
      expect(rate.conversationsWithInbound).toBeGreaterThan(0);
      expect(rate.takenOver).toBe(1);
      expect(rate.rate).toBeCloseTo(rate.takenOver / rate.conversationsWithInbound, 3);
    }, 180_000);

    it("says nothing rather than zero when no conversation was active", async () => {
      const quiet = await takeoverRate(db(), ownerContext, {
        from: utc("2026-12-01T00:00:00.000Z"),
        to: utc("2026-12-02T00:00:00.000Z"),
        timeZone: MADRID,
      });

      expect(quiet).toEqual({ conversationsWithInbound: 0, takenOver: 0, rate: null });
    }, 180_000);

    it("remembers a lead that qualified and then was lost", async () => {
      const leads = await leadMovement(db(), ownerContext, WINDOW);

      // Read from the transitions, not the current stage. A lead that reached QUALIFIED and then went to
      // LOST was still qualified in the window, and reading only the current stage would erase that and
      // make a bad month look like an empty one.
      expect(leads.movements.find((row) => row.toStage === "QUALIFIED")?.conversations).toBe(1);
      expect(leads.movements.find((row) => row.toStage === "LOST")?.conversations).toBe(1);
      expect(leads.qualified).toBe(1);
      expect(leads.qualificationRate).toBe(1);
    }, 180_000);
  });

  describe("AI usage", () => {
    it("reports tokens and latency per provider and model", async () => {
      const usage = await modelUsage(db(), ownerContext, WINDOW);

      const opus = usage.find((row) => row.model === "claude-opus-5");
      expect(opus?.provider).toBe("anthropic");
      expect(opus?.inputTokens).toBe(900);
      expect(opus?.outputTokens).toBe(120);
      expect(opus?.medianLatencyMs).toBe(800);
    }, 180_000);

    it("reports no money, because the prices are not in this database", async () => {
      const usage = await modelUsage(db(), ownerContext, WINDOW);

      // A currency figure would be a guess rendered to two decimal places, which is the most convincing
      // possible way to be wrong. The spec asks for usage/cost "when available"; usage is what is.
      for (const row of usage) {
        expect(Object.keys(row)).not.toContain("costUsd");
        expect(Object.keys(row).some((key) => /cost|price|usd|eur/iu.test(key))).toBe(false);
      }
    }, 180_000);
  });

  describe("scoping", () => {
    it("never counts another Workspace's traffic", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await inbound(utc("2026-10-07T08:00:00.000Z"), theirProfile);
      await inbound(utc("2026-10-07T09:00:00.000Z"), theirProfile);

      const ours = await inboundVolume(db(), ownerContext, WINDOW);
      const theirs = await inboundVolume(db(), neighbourContext, WINDOW);

      expect(ours.find((point) => point.day === "2026-10-07")).toBeUndefined();
      expect(theirs.find((point) => point.day === "2026-10-07")?.inboundMessages).toBe(2);
    }, 180_000);

    it("limits a member to the Business Profiles they may see", async () => {
      await inbound(utc("2026-10-07T14:00:00.000Z"), second);

      const wide = await inboundVolume(db(), ownerContext, WINDOW);
      const narrow = await inboundVolume(db(), narrowContext, WINDOW);

      expect(wide.find((point) => point.day === "2026-10-07")?.inboundMessages).toBe(1);
      // The second profile is outside this member's grant, so its traffic is not in their totals.
      expect(narrow.find((point) => point.day === "2026-10-07")).toBeUndefined();
    }, 180_000);

    it("intersects a requested profile with the grant rather than trusting it", async () => {
      const asked = await inboundVolume(db(), narrowContext, WINDOW, { businessProfileId: second.businessProfileId });

      // The id arrives from a query string. A member who edits it must get nothing, not somebody else's
      // numbers.
      expect(asked).toEqual([]);
    }, 180_000);

    it("filters by channel account, mode, lead stage and assignee together", async () => {
      // Set here rather than relied on from another block: a filter test that depended on an earlier
      // test's side effect would pass or fail depending on what else ran.
      await db().conversation.update({
        where: {
          workspaceId_businessProfileId_id: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId, id: profile.conversationId },
        },
        data: { leadStage: "LOST", modeOverride: "DRAFT", assignedUserId: workspace.ownerUserId },
      });

      const matching = await inboundVolume(db(), ownerContext, WINDOW, {
        channelAccountId: profile.channelAccount.id,
        mode: "DRAFT",
        leadStage: "LOST",
        assignedUserId: workspace.ownerUserId,
      });

      expect(matching.length).toBeGreaterThan(0);
      // Each filter genuinely narrows, and they combine rather than one replacing another.
      for (const wrong of [
        { channelAccountId: second.channelAccount.id, mode: "DRAFT" as const, leadStage: "LOST", assignedUserId: workspace.ownerUserId },
        { channelAccountId: profile.channelAccount.id, mode: "AUTOPILOT" as const, leadStage: "LOST", assignedUserId: workspace.ownerUserId },
        { channelAccountId: profile.channelAccount.id, mode: "DRAFT" as const, leadStage: "BOOKED", assignedUserId: workspace.ownerUserId },
        { channelAccountId: profile.channelAccount.id, mode: "DRAFT" as const, leadStage: "LOST", assignedUserId: neighbour.ownerUserId },
      ]) {
        expect(await inboundVolume(db(), ownerContext, WINDOW, wrong)).toEqual([]);
      }
    }, 180_000);

    it("returns an empty snapshot for a member with nothing in scope, without querying", async () => {
      const outsider = await db().user.create({ data: { name: "Metrics Outsider", email: "metrics-outsider@example.test" } });
      await addWorkspaceMember(db(), ownerContext, { userId: outsider.id, role: "AGENT", businessProfileScope: { selected: [second.businessProfileId] } });
      const context = await authorizeWorkspaceAccess(db(), { userId: outsider.id, workspaceId: workspace.workspaceId });

      const snapshot = await readOperationalSnapshot(db(), context, WINDOW, { businessProfileId: profile.businessProfileId });

      expect(snapshot.volume).toEqual([]);
      expect(snapshot.drafts.generated).toBe(0);
      expect(snapshot.responseTimes.samples).toBe(0);
      expect(snapshot.leads.movements).toEqual([]);
      expect(snapshot.usage).toEqual([]);
    }, 180_000);
  });
});
