/**
 * The two spellings of the entitlement key, and the ordering they buy (#40).
 *
 * A delivery claim derives the key in TypeScript; the trigger on `workspace_subscriptions` and
 * `entitlement_overrides` derives it in SQL. The ordering is only real while those agree, and a mismatch
 * is invisible at runtime: the claim would simply never wait, the race would be back, and every test
 * would still be green. So the two derivations are held against each other through the same
 * `hashtextextended` both sides actually call.
 *
 * The second half asserts what the agreement is *for*: a plan change waits for a claim already in
 * flight, and does so whether it arrives through the store or as raw SQL — which is the whole reason the
 * writer's side is a trigger rather than application code.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { entitlementLockKeyFor } from "./entitlement-lock";
import { publishPlanVersion, setWorkspaceSubscription } from "./entitlement-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("the entitlement advisory key", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "entitlement-lock");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  const sqlKey = async (workspaceId: string) => {
    const rows = await db().$queryRaw<{ key: string; hashed: bigint }[]>`
      SELECT "entitlement_change_key"(${workspaceId}) AS key,
             hashtextextended("entitlement_change_key"(${workspaceId}), 0) AS hashed`;
    return rows[0];
  };

  const tsHash = async (key: string) => {
    const rows = await db().$queryRaw<{ hashed: bigint }[]>`SELECT hashtextextended(${key}, 0) AS hashed`;
    return rows[0]?.hashed;
  };

  it("is the same string and the same hash on both sides", async () => {
    const fromSql = await sqlKey(workspace.workspaceId);
    const fromTypeScript = entitlementLockKeyFor(workspace.workspaceId);

    expect(fromSql?.key).toBe(fromTypeScript);
    expect(fromSql?.hashed).toBe(await tsHash(fromTypeScript));
  }, 180_000);

  it("gives two workspaces two keys, so one plan change cannot order against another's claim", async () => {
    const neighbour = await seedWorkspace(db(), "entitlement-lock-neighbour");

    expect(entitlementLockKeyFor(workspace.workspaceId)).not.toBe(entitlementLockKeyFor(neighbour.workspaceId));
  }, 180_000);

  /**
   * Holds the key the way a claim does, then watches a plan change wait for it.
   *
   * `pg_try_advisory_xact_lock` from a second transaction is the probe: it answers immediately rather than
   * blocking, so a failure to acquire it is evidence that the writer is being made to wait rather than a
   * test hanging for a timeout.
   */
  const whileClaimHoldsTheKey = async <T>(workspaceId: string, body: () => Promise<T>): Promise<T> =>
    db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${entitlementLockKeyFor(workspaceId)}, 0))`;
      return body();
    });

  it("makes a plan change wait for the claims already in flight", async () => {
    const taken = await whileClaimHoldsTheKey(workspace.workspaceId, async () => {
      const rows = await db().$queryRaw<{ got: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${entitlementLockKeyFor(workspace.workspaceId)}, 0)) AS got`;
      return rows[0]?.got;
    });

    // Shared holders do not block one another, so claims stay as concurrent as they were; an exclusive
    // writer — which is what the trigger takes — cannot get in.
    expect(taken).toBe(false);
  }, 180_000);

  /**
   * Counts advisory locks held on exactly this key, from inside the caller's transaction.
   *
   * The `classid`/`objid` arithmetic reconstructs the 64-bit key Postgres split in two, so the count is
   * about *this* key rather than about advisory locks in general — which is what the control below
   * establishes, by finding none when nothing has written.
   */
  const locksOnKey = async (tx: { $queryRaw: typeof database.db.$queryRaw }, workspaceId: string) => {
    const rows = await tx.$queryRaw<{ locks: bigint }[]>`
      SELECT count(*)::bigint AS locks FROM pg_locks
      WHERE "locktype" = 'advisory' AND "objid" IS NOT NULL
        AND (("classid"::bigint << 32) | "objid"::bigint)::bigint
            = hashtextextended(${entitlementLockKeyFor(workspaceId)}, 0)::bigint`;
    return rows[0]?.locks ?? 0n;
  };

  it("finds no lock on that key when nothing has written, so the counts below mean something", async () => {
    // The control. Without it every assertion that a lock is held would pass against a query that counts
    // advisory locks in general, or against one that counts nothing at all and compares it with itself.
    const idle = await db().$transaction(async (tx) => locksOnKey(tx, workspace.workspaceId));

    expect(idle).toBe(0n);
  }, 180_000);

  it("takes the key from a plan change written by raw SQL, not only through the store", async () => {
    // The point of putting the writer's half in a trigger: a support script or a hand-written UPDATE
    // during an incident participates too. A lock taken in a store method would bind only callers who
    // went through that method.
    const plan = await publishPlanVersion(db(), {
      code: "entitlement-lock-plan",
      name: "Lock plan",
      grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
    });
    await setWorkspaceSubscription(db(), workspace.context, { planVersionId: plan.planVersionId, state: "ACTIVE" });

    const held = await db().$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "workspace_subscriptions" SET "state" = 'INACTIVE' WHERE "workspace_id" = ${workspace.workspaceId}`;
      // Inside the same transaction as the raw write: if the trigger took the key, nobody else can.
      return locksOnKey(tx, workspace.workspaceId);
    });

    expect(held).toBeGreaterThan(0n);
  }, 180_000);

  it("takes it for an override too, because removing one is how a feature is taken away", async () => {
    const granter = await createTestUser(db(), "entitlement-lock-granter");
    await db().entitlementOverride.create({
      data: {
        workspaceId: workspace.workspaceId,
        features: { WHATSAPP: true },
        limits: {},
        quotas: {},
        reason: "lock test",
        grantedByUserId: granter,
      },
    });

    const held = await db().$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "entitlement_overrides" WHERE "workspace_id" = ${workspace.workspaceId}`;
      return locksOnKey(tx, workspace.workspaceId);
    });

    expect(held).toBeGreaterThan(0n);
  }, 180_000);
});
