/**
 * A workspace that may actually do paid work (#40).
 *
 * Commercial access became a send gate: a workspace with no subscription row resolves to `INACTIVE` on no
 * plan with every feature false, so automated work is held with `BILLING_INACTIVE` before any gate a test
 * was written to exercise is reached. Without this helper every integration suite in this app would
 * silently become a test of the billing gate — passing, but about the wrong thing.
 *
 * A test that wants an unpaid workspace changes the subscription itself. That is both explicit and the
 * thing it is actually asserting.
 */
import { authorizeWorkspaceAccess, createWorkspaceWithOwner, publishPlanVersion, setWorkspaceSubscription, type DbClient } from "@omnichannel/db";
import { PLAN_FEATURES } from "@omnichannel/domain";

/** The plan every test workspace is on: everything included, nothing metered out. */
const TEST_PLAN_CODE = "worker-test-everything";

export interface PaidWorkspace {
  readonly workspaceId: string;
  /** The version it is subscribed to, so a test can move it to another state or another plan. */
  readonly planVersionId: string;
}

export async function createPaidWorkspace(
  db: DbClient,
  input: { readonly name: string; readonly ownerUserId: string },
): Promise<PaidWorkspace> {
  const { workspaceId } = await createWorkspaceWithOwner(db, input);
  const planVersionId = await testPlanVersion(db);
  const context = await authorizeWorkspaceAccess(db, { userId: input.ownerUserId, workspaceId });
  await setWorkspaceSubscription(db, context, { planVersionId, state: "ACTIVE" });
  return { workspaceId, planVersionId };
}

/**
 * The shared plan version, published once per database.
 *
 * One definition across the suite rather than one per workspace: a plan is a product object, and
 * publishing hundreds of them would make `plan_versions` the slowest part of every fixture.
 */
export async function testPlanVersion(db: DbClient): Promise<string> {
  const existing = await db.planVersion.findFirst({
    where: { plan: { code: TEST_PLAN_CODE } },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (existing !== null) {
    return existing.id;
  }
  const published = await publishPlanVersion(db, {
    code: TEST_PLAN_CODE,
    name: "Worker test plan",
    grants: {
      features: [...PLAN_FEATURES],
      // No ceilings and a generous allowance: a capacity or quota refusal in a test is one the test asked
      // for, never one the fixture happened to impose.
      limits: {},
      quotas: { VOICE_TRANSCRIPTION_SECONDS: 100_000 },
    },
  });
  return published.planVersionId;
}
