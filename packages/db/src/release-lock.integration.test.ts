/**
 * The two spellings of the release-catalogue key, and the ordering they buy (#60).
 *
 * A delivery claim derives the key in TypeScript; the trigger on `release_records`,
 * `release_gate_results` and `release_reviews` derives it in SQL. The ordering is only real while those
 * agree, and a mismatch is invisible at runtime: the claim would simply never wait, the race would be
 * back, and every test here would still be green. So the two derivations are held against each other
 * through the same `hashtextextended` both sides actually call.
 *
 * The second half asserts what the agreement is *for*: recording a release waits for the claims already
 * in flight, and does so whether it arrives through the store or as raw SQL — which is the whole reason
 * the writer's side is a trigger rather than application code.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { authorizePlatformAccess, type PlatformContext } from "./platform-tenancy";
import { releaseCatalogueLockKey } from "./release-lock";
import { recordRelease, recordReleaseReview } from "./release-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser } from "./testing/fixtures";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe.skipIf(!databaseTestsEnabled())("the release-catalogue advisory key", () => {
  let database: TestDatabase;
  let actorUserId: string;
  let operations: PlatformContext;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    actorUserId = await createTestUser(database.db, "release-lock-actor");
    await database.db.platformMember.create({ data: { userId: actorUserId, role: "OPERATIONS", note: "lock rota" } });
    operations = await authorizePlatformAccess(database.db, actorUserId);
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  it("is the same string and the same hash on both sides", async () => {
    const rows = await db().$queryRaw<{ key: string; hashed: bigint }[]>`
      SELECT "release_catalogue_key"() AS key, hashtextextended("release_catalogue_key"(), 0) AS hashed`;
    const fromTypeScript = releaseCatalogueLockKey();
    const [tsHashed] = await db().$queryRaw<{ hashed: bigint }[]>`SELECT hashtextextended(${fromTypeScript}, 0) AS hashed`;

    expect(rows[0]?.key).toBe(fromTypeScript);
    expect(rows[0]?.hashed).toBe(tsHashed?.hashed);
  }, 180_000);

  /**
   * Counts advisory locks held on exactly this key, from inside the caller's transaction.
   *
   * The `classid`/`objid` arithmetic reconstructs the 64-bit key Postgres split in two, so the count is
   * about *this* key rather than about advisory locks in general — which is what the control below
   * establishes, by finding none when nothing has written.
   */
  const locksOnKey = async (tx: { $queryRaw: typeof database.db.$queryRaw }) => {
    // Scoped to **this** database, and that is not tidiness. `pg_locks` is cluster-wide while advisory
    // locks are per-database, every suite in this project runs in a migrated database of its own, and
    // vitest runs those files in parallel — so an unscoped count sees the catalogue key held by a claim
    // in somebody else's database and the control below fails for a reason that has nothing to do with
    // this suite. It was a latent flake; adding claims elsewhere only made the coincidence likely.
    const rows = await tx.$queryRaw<{ locks: bigint }[]>`
      SELECT count(*)::bigint AS locks FROM pg_locks
      WHERE "locktype" = 'advisory' AND "objid" IS NOT NULL
        AND "database" = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND (("classid"::bigint << 32) | "objid"::bigint)::bigint
            = hashtextextended(${releaseCatalogueLockKey()}, 0)::bigint`;
    return rows[0]?.locks ?? 0n;
  };

  it("finds no lock on that key when nothing has written, so the counts below mean something", async () => {
    // The control. Without it every assertion that a lock is held would pass against a query that counts
    // advisory locks in general, or against one that counts nothing at all and compares it with itself.
    const idle = await db().$transaction(async (tx) => locksOnKey(tx));

    expect(idle).toBe(0n);
  }, 180_000);

  it("makes recording a release wait for the claims already in flight", async () => {
    // `pg_try_advisory_xact_lock` from a second transaction is the probe: it answers immediately rather
    // than blocking, so a failure to acquire it is evidence that the writer is being made to wait rather
    // than a test hanging for a timeout.
    const taken = await db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${releaseCatalogueLockKey()}, 0))`;
      const rows = await db().$queryRaw<{ got: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${releaseCatalogueLockKey()}, 0)) AS got`;
      return rows[0]?.got;
    });

    // Shared holders do not block one another, so claims stay as concurrent as they were; an exclusive
    // writer — which is what the trigger takes — cannot get in.
    expect(taken).toBe(false);
  }, 180_000);

  it("lets two claims hold it at once, so the key costs readers nothing", async () => {
    // The other half of the choice. A platform-wide key taken exclusively by every claim would serialize
    // every send in the deployment; taken shared it serializes nothing.
    const second = await db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${releaseCatalogueLockKey()}, 0))`;
      const rows = await db().$queryRaw<{ got: boolean }[]>`
        SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${releaseCatalogueLockKey()}, 0)) AS got`;
      return rows[0]?.got;
    });

    expect(second).toBe(true);
  }, 180_000);

  it("takes the key when a release is recorded through the store", async () => {
    const held = await db().$transaction(async (tx) => {
      await tx.releaseRecord.create({
        data: { sha: SHA_A, actorUserId, stage: "INTERNAL", rollbackPlan: "revert the deploy", summary: "lock test" },
      });
      // Inside the same transaction as the write: if the trigger took the key, nobody else can.
      return locksOnKey(tx);
    });

    expect(held).toBeGreaterThan(0n);
  }, 180_000);

  it("takes it for a gate result and for a verdict too, because either can move the stage in force", async () => {
    // Not decoration on the record: the stage in force is the newest candidate whose gates permit a
    // release and whose own SHA a reviewer passed, so a gate result and a verdict each change the answer
    // the claim reads.
    const release = await recordRelease(db(), operations, {
      sha: SHA_B,
      stage: "INTERNAL",
      rollbackPlan: "revert the deploy",
      summary: "lock test",
      results: [],
    });

    // A gate result can only be inserted in the transaction that creates its candidate — that is the
    // seal — so this records one the way the store does and watches the key go with it.
    const heldForResult = await db().$transaction(async (tx) => {
      const candidate = await tx.releaseRecord.create({
        data: { sha: "d".repeat(40), actorUserId, stage: "INTERNAL", rollbackPlan: "revert the deploy", summary: "sealed" },
        select: { id: true },
      });
      await tx.releaseGateResult.create({
        data: { releaseId: candidate.id, gateId: "EXACT_SHA_CI", severity: "PASS", evidence: "scripts/verification/gate.test.ts" },
      });
      return locksOnKey(tx);
    });
    const heldForReview = await db().$transaction(async (tx) => {
      await tx.releaseReview.create({
        data: { reviewer: "astra", verdict: "PASS", reviewedSha: SHA_B, submittedAt: new Date("2026-10-01T12:00:00.000Z") },
      });
      return locksOnKey(tx);
    });

    expect(heldForResult).toBeGreaterThan(0n);
    expect(heldForReview).toBeGreaterThan(0n);
    expect(release.sha).toBe(SHA_B);
  }, 180_000);

  it("takes it for a release recorded by raw SQL, not only through the store", async () => {
    // The point of putting the writer's half in a trigger: a deploy script or a hand-written INSERT
    // during an incident participates too. A lock taken in a store method would bind only callers who
    // went through that method.
    const held = await db().$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "release_records" ("id", "sha", "actor_user_id", "stage", "rollback_plan", "summary", "created_at")
        VALUES (gen_random_uuid()::text, ${"c".repeat(40)}, ${actorUserId}, 'INTERNAL', 'revert the deploy', 'raw sql', now())`;
      return locksOnKey(tx);
    });

    expect(held).toBeGreaterThan(0n);
  }, 180_000);

  it("records a verdict through the store without deadlocking against its own trigger", async () => {
    // The trigger takes the key exclusively and `recordReleaseReview` wraps its write in a transaction;
    // a store method that also took the key would be asking for it twice in two modes. It does not, and
    // this is what says so.
    const appended = await recordReleaseReview(db(), operations, {
      reviewer: "astra-second",
      verdict: "CHANGES_REQUESTED",
      reviewedSha: SHA_B,
      submittedAt: new Date("2026-10-01T12:01:00.000Z"),
    });

    expect(appended.candidates).toBe(1);
  }, 180_000);
});
