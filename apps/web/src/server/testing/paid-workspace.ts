/**
 * A workspace with an owner, an admin and a plan (#40, #42).
 *
 * Commercial access is a gate, so a workspace with no subscription resolves to `INACTIVE` with every
 * feature false — and a suite about a screen would really be asserting the billing gate. The admin is
 * here because billing is OWNER-only and the interesting case is the one where somebody who may do
 * everything else may not do this.
 */
import {
  addWorkspaceMember,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createWorkspaceWithOwner,
  publishPlanVersion,
  setWorkspaceSubscription,
  type DbClient,
  type WorkspaceContext,
} from "@omnichannel/db";
import { PLAN_FEATURES } from "@omnichannel/domain";

const TEST_PLAN_CODE = "web-test-everything";

export interface PaidTestWorkspace {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly owner: WorkspaceContext;
  /** Full workspace rights and no billing rights, which is the distinction worth testing. */
  readonly admin: WorkspaceContext;
  readonly planVersionId: string;
}

export async function createPaidWorkspace(db: DbClient, label: string): Promise<PaidTestWorkspace> {
  // `@omnichannel/db` cannot export its own `src/testing` helpers, so each app owns its harness — and the
  // member is added through the *production* path, which also exercises the seat gate the plan permits.
  const ownerUserId = (await db.user.create({ data: { name: `Owner ${label}`, email: `${label}-owner@example.test` } })).id;
  const { workspaceId } = await createWorkspaceWithOwner(db, { name: `Workspace ${label}`, ownerUserId });
  const owner = await authorizeWorkspaceAccess(db, { userId: ownerUserId, workspaceId });
  const planVersionId = await testPlanVersion(db);
  await setWorkspaceSubscription(db, owner, { planVersionId, state: "ACTIVE" });

  const adminUserId = (await db.user.create({ data: { name: `Admin ${label}`, email: `${label}-admin@example.test` } })).id;
  await addWorkspaceMember(db, owner, { userId: adminUserId, role: "ADMIN", businessProfileScope: "ALL" });
  const admin = await authorizeWorkspaceAccess(db, { userId: adminUserId, workspaceId });
  const { businessProfileId } = await createBusinessProfile(db, owner, { name: `Profile ${label}` });

  return { workspaceId, businessProfileId, owner, admin, planVersionId };
}

/** The shared plan: everything included, nothing capped, so a refusal in a test is one the test asked for. */
async function testPlanVersion(db: DbClient): Promise<string> {
  const existing = await db.planVersion.findFirst({ where: { plan: { code: TEST_PLAN_CODE } }, orderBy: { version: "desc" }, select: { id: true } });
  if (existing !== null) {
    return existing.id;
  }
  const published = await publishPlanVersion(db, {
    code: TEST_PLAN_CODE,
    name: "Web test plan",
    grants: { features: [...PLAN_FEATURES], limits: {}, quotas: { VOICE_TRANSCRIPTION_SECONDS: 100_000 } },
  });
  return published.planVersionId;
}
