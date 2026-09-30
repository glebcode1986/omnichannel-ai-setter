/**
 * What the shell is allowed to show, against a real database (Issue #27).
 *
 * `workspace-context.test.ts` covers the resolution logic with a fake client. This covers the thing that
 * fake cannot: that the queries behind it actually isolate tenants and actually return the role the shell
 * gates on. Every page in the product shell goes through these two functions, so a mistake here is a
 * mistake on every page at once.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  BusinessProfileAccessDeniedError,
  createBusinessProfile,
  createChannelAccount,
  createWorkspaceWithOwner,
  addWorkspaceMember,
  readOnboarding,
  skipOnboardingStep,
  WORKSPACE_ADMIN_ROLES,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { resolveBusinessProfileContext, resolveWorkspaceContext, UnauthenticatedError } from "./workspace-context";

describe.skipIf(!databaseTestsEnabled())("the shell's authorization", () => {
  let database: TestDatabase;
  let ownerId: string;
  let outsiderId: string;
  let agentId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let grantedProfileId: string;
  let ungrantedProfileId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;

    const owner = await db.user.create({ data: { name: "Shell Owner", email: "shell-owner@example.test" } });
    const outsider = await db.user.create({ data: { name: "Shell Outsider", email: "shell-outsider@example.test" } });
    const agent = await db.user.create({ data: { name: "Shell Agent", email: "shell-agent@example.test" } });
    ownerId = owner.id;
    outsiderId = outsider.id;
    agentId = agent.id;

    ({ workspaceId } = await createWorkspaceWithOwner(db, { name: "Shell Workspace", ownerUserId: ownerId }));
    const workspace = await authorizeWorkspaceAccess(db, { userId: ownerId, workspaceId });
    ({ businessProfileId: grantedProfileId } = await createBusinessProfile(db, workspace, { name: "Granted" }));
    ({ businessProfileId: ungrantedProfileId } = await createBusinessProfile(db, workspace, { name: "Ungranted" }));

    // A second tenant, owned by someone else entirely.
    const other = await createWorkspaceWithOwner(db, { name: "Someone Else's Workspace", ownerUserId: outsiderId });
    otherWorkspaceId = other.workspaceId;

    // An AGENT whose access is limited to one profile: the scope the shell must respect. The grant goes
    // through the repository rather than a hand-written row, so the test exercises the real path.
    await addWorkspaceMember(db, workspace, {
      userId: agentId,
      role: "AGENT",
      businessProfileScope: { selected: [grantedProfileId] },
    });

    const profileContext = await authorizeBusinessProfileAccess(db, { userId: ownerId, workspaceId, businessProfileId: grantedProfileId });
    await createChannelAccount(db, profileContext, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-shell",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const as = (userId: string | undefined) => ({
    getSessionUserId: () => Promise.resolve(userId),
    db: database.db,
  });

  it("refuses every page to a request with no session", async () => {
    await expect(resolveWorkspaceContext(as(undefined), workspaceId)).rejects.toThrow(UnauthenticatedError);
    await expect(resolveBusinessProfileContext(as(undefined), workspaceId, grantedProfileId)).rejects.toThrow(UnauthenticatedError);
  }, 180_000);

  it("lets a member into their own workspace", async () => {
    const context = await resolveBusinessProfileContext(as(ownerId), workspaceId, grantedProfileId);

    expect(context.workspaceId).toBe(workspaceId);
    expect(context.businessProfileId).toBe(grantedProfileId);
    expect(WORKSPACE_ADMIN_ROLES.includes(context.role)).toBe(true);
  }, 180_000);

  it("refuses another tenant's workspace to someone who is not in it", async () => {
    // The URL is guessable and the profile is real; membership is the only thing standing between them.
    await expect(resolveWorkspaceContext(as(ownerId), otherWorkspaceId)).rejects.toThrow();
    await expect(resolveBusinessProfileContext(as(ownerId), otherWorkspaceId, grantedProfileId)).rejects.toThrow();
  }, 180_000);

  it("refuses a profile a scoped member was not granted", async () => {
    await expect(resolveBusinessProfileContext(as(agentId), workspaceId, grantedProfileId)).resolves.toBeDefined();
    await expect(resolveBusinessProfileContext(as(agentId), workspaceId, ungrantedProfileId)).rejects.toThrow(
      BusinessProfileAccessDeniedError,
    );
  }, 180_000);

  it("returns the role the shell gates its controls on", async () => {
    const owner = await resolveBusinessProfileContext(as(ownerId), workspaceId, grantedProfileId);
    const agent = await resolveBusinessProfileContext(as(agentId), workspaceId, grantedProfileId);

    // This is the single decision behind every "can this person change setup" in the shell, so it is
    // worth asserting directly rather than through a rendered button.
    expect(WORKSPACE_ADMIN_ROLES.includes(owner.role)).toBe(true);
    expect(WORKSPACE_ADMIN_ROLES.includes(agent.role)).toBe(false);
  }, 180_000);

  it("never names a Workspace or profile the request did not", async () => {
    // "There is no implicit current or default Workspace." A shell that filled in a blank would be the
    // one place a person could reach a tenant they never asked for.
    await expect(resolveWorkspaceContext(as(ownerId), undefined)).rejects.toThrow();
    await expect(resolveWorkspaceContext(as(ownerId), "")).rejects.toThrow();
    await expect(resolveBusinessProfileContext(as(ownerId), workspaceId, undefined)).rejects.toThrow();
    await expect(resolveBusinessProfileContext(as(ownerId), workspaceId, "")).rejects.toThrow();
  }, 180_000);

  it("reads the setup surface for the profile the route named and no other", async () => {
    const granted = await resolveBusinessProfileContext(as(ownerId), workspaceId, grantedProfileId);
    const ungranted = await resolveBusinessProfileContext(as(ownerId), workspaceId, ungrantedProfileId);

    // One profile has a channel and the other does not. The setup page is built from this read, so a
    // checklist that crossed profiles would tell a business it had connected something it had not.
    expect((await readOnboarding(database.db, granted)).facts.channels).toHaveLength(1);
    expect((await readOnboarding(database.db, ungranted)).facts.channels).toHaveLength(0);
  }, 180_000);

  it("lets a scoped member read setup and not change it", async () => {
    const agent = await resolveBusinessProfileContext(as(agentId), workspaceId, grantedProfileId);

    await expect(readOnboarding(database.db, agent)).resolves.toBeDefined();
    await expect(skipOnboardingStep(database.db, agent, "STYLE")).rejects.toThrow();
  }, 180_000);
});
