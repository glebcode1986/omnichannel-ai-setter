/**
 * Reading onboarding from real data, and recording a real decision (Issue #27).
 *
 * The domain rules are tested without a database. What needs a database is whether the store asks it the
 * right questions: whether a tick on the checklist corresponds to configuration that actually exists, for
 * this Business Profile and no other.
 */
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChannelAccount } from "./repositories/channel-accounts";
import { activateBusinessProfile, readOnboarding, skipOnboardingStep, unskipOnboardingStep } from "./setup-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess } from "./tenancy";
import { addWorkspaceMember, createBusinessProfile } from "./repositories/workspaces";
import { createTestUser } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("onboarding, read from what exists", () => {
  let database: TestDatabase;
  let main: SeededProfile;
  let second: SeededProfile;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const seeded = await seedWorkspace(database.db, "setup", ["main", "second"]);
    [main, second] = seeded.profiles as [SeededProfile, SeededProfile];
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  it("reports the steps a freshly seeded profile has and has not done", async () => {
    const { facts, state } = await readOnboarding(db(), main.context);

    // The fixture connects a channel and has a conversation; it configures no policy, knowledge or style.
    expect(facts.channels).toHaveLength(1);
    expect(facts.knowledgeDocumentCount).toBe(0);
    expect(facts.styleConfigured).toBe(false);
    expect(facts.activated).toBe(false);
    expect(state.steps.find((step) => step.step === "CHANNELS")?.state).toBe("COMPLETE");
    expect(state.steps.find((step) => step.step === "KNOWLEDGE")?.state).toBe("INCOMPLETE");
    expect(state.canActivate).toBe(false);
    expect(state.activationBlockers).toContain("NO_KNOWLEDGE");
  }, 120_000);

  it("counts only this Business Profile's configuration", async () => {
    await db().knowledgeDocument.create({
      data: {
        workspaceId: second.context.workspaceId,
        businessProfileId: second.businessProfileId,
        title: "Hours",
        sourceType: "MANUAL",
        status: "ACTIVE",
        version: 1,
        createdByUserId: second.context.userId,
      },
    });

    // The neighbouring profile in the same workspace now has knowledge. This one still does not, and a
    // checklist that counted across the workspace would quietly let it launch on someone else's facts.
    expect((await readOnboarding(db(), main.context)).facts.knowledgeDocumentCount).toBe(0);
    expect((await readOnboarding(db(), second.context)).facts.knowledgeDocumentCount).toBe(1);
  }, 120_000);

  it("separates an account that needs re-authorization from one that can send", async () => {
    const before = await readOnboarding(db(), main.context);
    expect(before.facts.channels[0]?.status).toBe("CONNECTED");

    await db().channelAccount.updateMany({
      where: { workspaceId: main.context.workspaceId, businessProfileId: main.businessProfileId },
      data: { status: "NEEDS_REAUTH" },
    });
    const after = await readOnboarding(db(), main.context);

    // The step stays done — they did connect it once — while activation refuses, which is the actionable
    // distinction: "re-authorize this" rather than "set up a channel".
    expect(after.state.steps.find((step) => step.step === "CHANNELS")?.state).toBe("COMPLETE");
    expect(after.state.activationBlockers).toContain("NO_CONNECTED_CHANNEL");

    await db().channelAccount.updateMany({
      where: { workspaceId: main.context.workspaceId, businessProfileId: main.businessProfileId },
      data: { status: "CONNECTED" },
    });
  }, 120_000);

  it("stops calling a channel sendable while a kill switch covers it", async () => {
    await db().automationPolicy.create({
      data: {
        workspaceId: main.context.workspaceId,
        businessProfileId: main.businessProfileId,
        mode: "AUTOPILOT",
        mandatoryReviewReasons: [],
      },
    });
    expect((await readOnboarding(db(), main.context)).facts.channels[0]?.outboundSuspended).toBe(false);

    const suspension = await db().automationSuspension.create({
      data: {
        scope: "BUSINESS_PROFILE",
        workspaceId: main.context.workspaceId,
        businessProfileId: main.businessProfileId,
        reason: "OPERATOR",
        since: new Date(),
        byUserId: main.context.userId,
      },
    });

    // The card must be able to say "could send, but not right now" — the difference between eligible and
    // currently sendable that ONBOARDING_UX.md asks the UI to keep distinct.
    expect((await readOnboarding(db(), main.context)).facts.channels[0]?.outboundSuspended).toBe(true);

    await db().automationSuspension.delete({ where: { id: suspension.id } });
  }, 120_000);

  it("treats an unresolved review item as a reason not to launch", async () => {
    await db().conversation.updateMany({
      where: { workspaceId: main.context.workspaceId, businessProfileId: main.businessProfileId },
      data: { takeoverState: "REVIEW_REQUIRED", takeoverReason: "MANDATORY_REVIEW", takeoverReviewMode: "NORMAL", humanTakeoverAt: new Date() },
    });

    const { state } = await readOnboarding(db(), main.context);

    expect(state.activationBlockers).toContain("UNRESOLVED_REVIEW_ITEMS");
  }, 120_000);

  it("keeps a skip, and gives it back when a person changes their mind", async () => {
    await skipOnboardingStep(db(), main.context, "STYLE");
    expect((await readOnboarding(db(), main.context)).skipped).toContain("STYLE");
    expect((await readOnboarding(db(), main.context)).state.steps.find((s) => s.step === "STYLE")?.state).toBe("SKIPPED");

    // Skipping twice is the same decision, not two rows.
    await skipOnboardingStep(db(), main.context, "STYLE");
    expect(await db().onboardingSkip.count({ where: { workspaceId: main.context.workspaceId, businessProfileId: main.businessProfileId } })).toBe(1);

    await unskipOnboardingStep(db(), main.context, "STYLE");
    expect((await readOnboarding(db(), main.context)).skipped).not.toContain("STYLE");
  }, 120_000);

  it("refuses to record a skip for a step that must not be skipped", async () => {
    await expect(skipOnboardingStep(db(), main.context, "KNOWLEDGE")).rejects.toThrow(/may be skipped/);
    await expect(skipOnboardingStep(db(), main.context, "ACTIVATION")).rejects.toThrow(/may be skipped/);
    await expect(skipOnboardingStep(db(), main.context, "not-a-step")).rejects.toThrow(/setup step/);
  }, 120_000);

  it("refuses a skip written straight to the table, not only one asked for politely", async () => {
    // The store checks, the domain ignores, and the database refuses. Each covers a different writer, and
    // this is the one that covers a hand-written INSERT during a support call.
    await expect(
      db().$executeRaw`
        INSERT INTO "onboarding_skips" ("id", "workspace_id", "business_profile_id", "step", "skipped_by_user_id")
        VALUES (gen_random_uuid()::text, ${main.context.workspaceId}, ${main.businessProfileId}, 'KNOWLEDGE', ${main.context.userId})`,
    ).rejects.toThrow(/onboarding_skips_skippable_check/);
  }, 120_000);

  it("lets only an owner or admin decide to skip a step", async () => {
    const agentUserId = await createTestUser(db(), "setup-agent");
    const workspace = await authorizeWorkspaceAccess(db(), { userId: main.context.userId, workspaceId: main.context.workspaceId });
    await addWorkspaceMember(db(), workspace, { userId: agentUserId, role: "AGENT", businessProfileScope: "ALL" });
    const agentContext = await authorizeBusinessProfileAccess(db(), {
      userId: agentUserId,
      workspaceId: main.context.workspaceId,
      businessProfileId: main.businessProfileId,
    });

    // An AGENT may read the checklist — it is their work queue too — and may not decide the business will
    // launch without a voice.
    await expect(readOnboarding(db(), agentContext)).resolves.toBeDefined();
    await expect(skipOnboardingStep(db(), agentContext, "STYLE")).rejects.toThrow();
  }, 120_000);

  it("does not ask an Instagram-free profile to choose an Instagram policy", async () => {
    const workspace = await authorizeWorkspaceAccess(db(), { userId: main.context.userId, workspaceId: main.context.workspaceId });
    const { businessProfileId } = await createBusinessProfile(db(), workspace, { name: "Profile without Instagram" });
    const context = await authorizeBusinessProfileAccess(db(), {
      userId: main.context.userId,
      workspaceId: main.context.workspaceId,
      businessProfileId,
    });
    await createChannelAccount(db(), context, {
      channel: "WHATSAPP",
      externalAccountId: "wa-account-setup",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });

    // A step that can never be completed is a checklist that can never be finished.
    expect((await readOnboarding(db(), context)).state.steps.find((s) => s.step === "CHANNEL_POLICY")?.state).toBe("COMPLETE");
  }, 120_000);

  describe("taking a profile live", () => {
    /** A profile that is genuinely ready, built from scratch so the other cases cannot disturb it. */
    const readyProfile = async (label: string) => {
      const workspace = await authorizeWorkspaceAccess(db(), { userId: main.context.userId, workspaceId: main.context.workspaceId });
      const { businessProfileId } = await createBusinessProfile(db(), workspace, { name: `Ready ${label}` });
      const context = await authorizeBusinessProfileAccess(db(), {
        userId: main.context.userId,
        workspaceId: main.context.workspaceId,
        businessProfileId,
      });
      await createChannelAccount(db(), context, {
        channel: "INSTAGRAM",
        externalAccountId: `ig-ready-${label}`,
        capabilities: { ...NO_CAPABILITIES, text: true },
      });
      await db().automationPolicy.create({
        data: { workspaceId: context.workspaceId, businessProfileId, mode: "DRAFT", mandatoryReviewReasons: [] },
      });
      await db().knowledgeDocument.create({
        data: {
          workspaceId: context.workspaceId,
          businessProfileId,
          title: "Hours",
          sourceType: "MANUAL",
          status: "ACTIVE",
          version: 1,
          createdByUserId: context.userId,
        },
      });
      return { context, businessProfileId };
    };

    it("activates a profile whose checklist is clear", async () => {
      const { context, businessProfileId } = await readyProfile("go");

      expect(await activateBusinessProfile(db(), context)).toEqual({ kind: "ACTIVATED" });
      expect(
        (await db().businessProfile.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: context.workspaceId, id: businessProfileId } } })).status,
      ).toBe("ACTIVE");
    }, 120_000);

    it("refuses when the checklist is not clear, whatever a page was showing", async () => {
      const { context, businessProfileId } = await readyProfile("not-ready");
      // The page rendered a clear checklist, and it was true then. Now the knowledge is gone. Readiness is
      // re-evaluated at the moment of writing, so the button cannot assert what was true a minute ago.
      expect((await readOnboarding(db(), context)).state.canActivate).toBe(true);
      await db().knowledgeDocument.deleteMany({ where: { workspaceId: context.workspaceId, businessProfileId } });

      const outcome = await activateBusinessProfile(db(), context);

      expect(outcome.kind).toBe("NOT_READY");
      expect(outcome.kind === "NOT_READY" ? outcome.blockers : []).toContain("NO_KNOWLEDGE");
      expect(
        (await db().businessProfile.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: context.workspaceId, id: businessProfileId } } })).status,
      ).toBe("SETUP");
    }, 120_000);

    it("produces one activation for two simultaneous clicks", async () => {
      const { context } = await readyProfile("race");

      const [first, second] = await Promise.all([activateBusinessProfile(db(), context), activateBusinessProfile(db(), context)]);

      // Whichever transaction gets the row lock first activates; the other finds the profile already out
      // of SETUP and says so rather than reporting a second activation.
      const kinds = [first.kind, second.kind].sort();
      expect(kinds).toEqual(["ACTIVATED", "ALREADY_SETTLED"]);
    }, 120_000);

    it("lets only an owner or admin take a profile live", async () => {
      const { context } = await readyProfile("role");
      const agentUserId = await createTestUser(db(), "activate-agent");
      const workspace = await authorizeWorkspaceAccess(db(), { userId: main.context.userId, workspaceId: main.context.workspaceId });
      await addWorkspaceMember(db(), workspace, { userId: agentUserId, role: "AGENT", businessProfileScope: "ALL" });
      const agentContext = await authorizeBusinessProfileAccess(db(), {
        userId: agentUserId,
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
      });

      await expect(activateBusinessProfile(db(), agentContext)).rejects.toThrow();
    }, 120_000);
  });
});
