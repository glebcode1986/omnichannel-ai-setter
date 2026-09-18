/**
 * Live PostgreSQL regression for concurrent inbound appends.
 *
 * The defect this pins is invisible to a stubbed transaction: the guarantee lives in the database's row
 * lock, so only a real server contending on a real row can demonstrate it.
 *
 * The schedule is *forced*, not hoped for. An earlier version of this file started two promises a microtask
 * apart and repeated the pair; that leaves the interleaving to connection and server scheduling, so it can
 * pass against the very defect it exists to catch. Here a third connection holds the conversation's row
 * lock, the append under test is allowed to run until PostgreSQL itself reports it waiting on that lock,
 * and only then does the holder write a newer timestamp and commit. Both implementations reach the same
 * observable state — "blocked on a lock" — but for different reasons, and that is what separates them:
 *
 * - **with the lock**, the append is still waiting *before its read*, so after the commit it reads the new
 *   value and keeps the maximum;
 * - **without it**, the append already read the stale value and is waiting on its own UPDATE, so it writes
 *   the older timestamp over the newer one.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendInboundMessage } from "./messages";
import { createContactWithChannelIdentity } from "./contacts";
import { createConversation } from "./conversations";
import { createDbClient, type DbClient } from "../client";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../testing/database";
import { seedWorkspace, type SeededProfile } from "../testing/fixtures";

/** Later than anything the shared fixture seeds, so assertions are about this test's own writes. */
const OLDER = new Date("2027-01-01T01:00:00.000Z");
const NEWER = new Date("2027-01-01T02:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("concurrent inbound appends (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  /**
   * A separate client for the append under test. One Prisma client serialises its own interactive
   * transactions, so driving both sides through a single client would never produce two open transactions.
   */
  let appending: DbClient;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "concurrency")).profiles as [SeededProfile];
    appending = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await appending?.$disconnect();
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  const readConversation = (id: string) =>
    database.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope(), id } },
      select: { lastInboundAt: true, lastMessageAt: true, stateVersion: true },
    });

  let identitySeq = 0;

  /** A conversation with no messages at all, so `lastInboundAt` starts NULL. */
  const emptyConversation = async (): Promise<string> => {
    // A fresh contact each time: a channel identity owns at most one conversation.
    identitySeq += 1;
    const identity = await createContactWithChannelIdentity(database.db, profile.context, {
      channelAccountId: profile.channelAccount.id,
      externalUserId: `ig-user-empty-${String(identitySeq)}`,
    });
    const created = await createConversation(database.db, profile.context, {
      channelAccountId: profile.channelAccount.id,
      channelIdentityId: identity.channelIdentityId,
    });
    const row = await readConversation(created.id);
    expect(row.lastInboundAt).toBeNull();
    return created.id;
  };

  /** Blocks until PostgreSQL reports some backend in this database waiting on a lock. */
  const waitUntilBlockedOnLock = async (): Promise<void> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = await database.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      if ((waiting[0]?.count ?? 0n) > 0n) {
        return;
      }
      if (Date.now() > deadline) {
        // Neither implementation can finish without taking the row lock, so never blocking means the
        // append is not touching the row at all — itself a failure worth reporting loudly.
        throw new Error("the append never waited on the conversation row lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /**
   * Runs one forced interleaving and returns the conversation afterwards. A third connection holds the row
   * lock, the append is released only once PostgreSQL confirms it is waiting, and the holder then commits a
   * newer timestamp — the "newer message that got there first".
   */
  const forceStaleReadSchedule = async (conversationId: string) => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT "id" FROM "conversations" WHERE "workspace_id" = $1 AND "business_profile_id" = $2 AND "id" = $3 FOR UPDATE',
        [scope().workspaceId, scope().businessProfileId, conversationId],
      );

      const append = appendInboundMessage(appending, profile.context, {
        conversationId,
        kind: "TEXT",
        text: "the older message",
        occurredAt: OLDER,
      });

      await waitUntilBlockedOnLock();

      // The instant travels as an ISO-8601 string and is converted explicitly, never as a JavaScript
      // `Date`: node-postgres serialises those with the *process's* local offset, so on a machine that is
      // not on UTC the holder would write a different instant than the one this test asserts. That is the
      // same marshalling hazard that made a row lock preferable to raw `GREATEST` SQL in the fix itself.
      await holder.query(
        `UPDATE "conversations"
         SET "last_inbound_at" = ($4::timestamptz AT TIME ZONE 'UTC'),
             "last_message_at" = ($4::timestamptz AT TIME ZONE 'UTC'),
             "state_version" = "state_version" + 1,
             "updated_at" = NOW()
         WHERE "workspace_id" = $1 AND "business_profile_id" = $2 AND "id" = $3`,
        [scope().workspaceId, scope().businessProfileId, conversationId, NEWER.toISOString()],
      );
      await holder.query("COMMIT");

      await append;
      return await readConversation(conversationId);
    } finally {
      await holder.end();
    }
  };

  it("keeps the newest timestamp when an older message is forced to finish last", async () => {
    const conversationId = profile.conversationId;
    const before = await readConversation(conversationId);

    const after = await forceStaleReadSchedule(conversationId);

    // Without the row lock this is `2027-01-01T01:00:00.000Z`: the older message overwrote the newer one.
    expect(after.lastInboundAt?.toISOString()).toBe(NEWER.toISOString());
    expect(after.lastMessageAt.toISOString()).toBe(NEWER.toISOString());
    // One increment from the holder's write and one from the append: nothing was lost or merged.
    expect(after.stateVersion).toBe(before.stateVersion + 2);
  }, 120_000);

  it("keeps the newest timestamp when the conversation had none to begin with", async () => {
    // `lastInboundAt` starts NULL here, which is the branch the seeded fixture can never exercise.
    const conversationId = await emptyConversation();
    const before = await readConversation(conversationId);

    const after = await forceStaleReadSchedule(conversationId);

    expect(after.lastInboundAt?.toISOString()).toBe(NEWER.toISOString());
    expect(after.lastMessageAt.toISOString()).toBe(NEWER.toISOString());
    expect(after.stateVersion).toBe(before.stateVersion + 2);
  }, 120_000);

  it("fills a NULL inbound timestamp but never moves a newer one backwards", async () => {
    const conversationId = await emptyConversation();
    const before = await readConversation(conversationId);
    // A message the platform stamped long ago — a real case for a backfill or a delayed webhook.
    const past = new Date("2020-05-05T08:00:00.000Z");

    await appendInboundMessage(appending, profile.context, {
      conversationId,
      kind: "TEXT",
      text: "a long-delayed message",
      occurredAt: past,
    });

    const after = await readConversation(conversationId);
    // NULL has no maximum to defend, so the message's own time is taken.
    expect(after.lastInboundAt?.toISOString()).toBe(past.toISOString());
    // `lastMessageAt` already held the conversation's creation time, which is later, so it stays put:
    // the column takes the maximum, not the most recent write.
    expect(after.lastMessageAt.toISOString()).toBe(before.lastMessageAt.toISOString());
    expect(after.stateVersion).toBe(before.stateVersion + 1);
  }, 120_000);

  /**
   * Unlike the two tests above, this one does not force a schedule: ten appends race and PostgreSQL
   * decides the order. It is kept for what it *can* prove deterministically — that nothing is dropped or
   * merged under contention — and its timestamp assertion is a bonus that happens to catch the regression
   * some of the time. The proof that the defect is dead lives in the forced-schedule tests, which fail on
   * every single run without the lock.
   */
  it("loses no message when ten appends contend for the same conversation", async () => {
    const conversationId = await emptyConversation();
    const newest = new Date("2027-02-01T12:00:00.000Z");

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        appendInboundMessage(index % 2 === 0 ? appending : database.db, profile.context, {
          conversationId,
          kind: "TEXT",
          text: `burst ${String(index)}`,
          occurredAt: new Date(newest.getTime() - index * 60_000),
        }),
      ),
    );

    const after = await readConversation(conversationId);
    expect(after.lastInboundAt?.toISOString()).toBe(newest.toISOString());
    expect(after.stateVersion).toBe(10);
    expect(
      await database.db.message.count({ where: { ...scope(), conversationId, direction: "IN" } }),
    ).toBe(10);
  }, 120_000);

  it("locks only the scoped row, so a missing conversation is still reported as not found", async () => {
    await expect(
      appendInboundMessage(appending, profile.context, {
        conversationId: "01a0b40c-0000-7000-8000-000000000000",
        kind: "TEXT",
        occurredAt: NEWER,
      }),
    ).rejects.toThrow(/Conversation/);
  });
});
