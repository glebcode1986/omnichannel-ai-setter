/**
 * Live PostgreSQL regression for concurrent inbound appends.
 *
 * The defect is invisible to a stubbed transaction: the guarantee lives in the database's row lock, so only
 * a real server contending on a real row can demonstrate it.
 *
 * The schedule is *forced*, not hoped for. A second connection opens the newer message's transaction and
 * holds it: it locks the conversation, inserts a real inbound Message row with the same scope the
 * repository writes, and performs the matching conversation transition — then waits. The older message is
 * appended through the real repository path on an independent client and confirmed, by PostgreSQL's own
 * report of a backend waiting on a lock, to be stopped at the row. Only then does the newer transaction
 * commit.
 *
 * Ordering is decided by this test rather than by the lock queue. An earlier version queued two repository
 * appends behind a holder and relied on them being granted the lock in arrival order; PostgreSQL makes no
 * such promise, and measured against the unfixed code that version failed only 2 runs in 6.
 *
 * Both implementations reach the same observable state, blocked on a lock, but for different reasons, and
 * that is what separates them:
 *
 * - **with the lock**, the older append is still waiting *before its read*, so it reads the newer value
 *   once the newer append commits and keeps the maximum;
 * - **without it**, the older append already read the stale value and is waiting on its own UPDATE, so it
 *   writes the older timestamp last.
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
   * The older append runs on its own client. A single Prisma client serialises its own interactive
   * transactions, so sharing one with any other open transaction would never produce real contention — an
   * earlier version of this suite passed against the unfixed code for exactly that reason.
   */
  let olderClient: DbClient;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "concurrency")).profiles as [SeededProfile];
    olderClient = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await olderClient?.$disconnect();
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  const readConversation = (id: string) =>
    database.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope(), id } },
      select: { lastInboundAt: true, lastMessageAt: true, stateVersion: true },
    });

  const inboundMessages = (conversationId: string) =>
    database.db.message.findMany({
      where: { ...scope(), conversationId, direction: "IN" },
      select: { id: true, text: true, occurredAt: true },
      orderBy: { id: "asc" },
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
    expect((await readConversation(created.id)).lastInboundAt).toBeNull();
    return created.id;
  };

  /**
   * Blocks until PostgreSQL reports at least `expected` backends waiting on a lock in this database. A
   * real database-observed condition, never a sleep: the point of the barrier is that it cannot pass early.
   */
  const waitForLockWaiters = async (expected: number): Promise<void> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = await database.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      if ((waiting[0]?.count ?? 0n) >= BigInt(expected)) {
        return;
      }
      if (Date.now() > deadline) {
        // Neither implementation can finish without taking the row lock, so never blocking means the
        // append is not touching the row at all — itself a failure worth reporting loudly.
        throw new Error(`expected ${String(expected)} backend(s) waiting on the conversation row lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /**
   * The newer message's transaction, written as the repository writes it but held open so this test
   * decides when it commits. Every instant travels as ISO-8601 and is converted explicitly: node-postgres
   * serialises a JavaScript `Date` with the *process's* local offset, so on a machine that is not on UTC
   * this would otherwise store a different instant than the one asserted.
   */
  const openNewerMessageTransaction = async (conversationId: string) => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    const args = [scope().workspaceId, scope().businessProfileId, conversationId];

    await holder.query("BEGIN");
    await holder.query(
      'SELECT "id" FROM "conversations" WHERE "workspace_id" = $1 AND "business_profile_id" = $2 AND "id" = $3 FOR UPDATE',
      args,
    );
    await holder.query(
      `INSERT INTO "messages"
         ("id", "workspace_id", "business_profile_id", "channel_account_id", "conversation_id",
          "direction", "source", "kind", "text", "occurred_at", "created_at", "updated_at")
       SELECT gen_random_uuid()::text, $1, $2, c."channel_account_id", $3,
              'IN', 'PARTICIPANT', 'TEXT', $4, ($5::timestamptz AT TIME ZONE 'UTC'), NOW(), NOW()
       FROM "conversations" c
       WHERE c."workspace_id" = $1 AND c."business_profile_id" = $2 AND c."id" = $3`,
      [...args, "the newer message", NEWER.toISOString()],
    );
    await holder.query(
      `UPDATE "conversations"
       SET "last_inbound_at" = GREATEST("last_inbound_at", ($4::timestamptz AT TIME ZONE 'UTC')),
           "last_message_at" = GREATEST("last_message_at", ($4::timestamptz AT TIME ZONE 'UTC')),
           "state_version" = "state_version" + 1,
           "updated_at" = NOW()
       WHERE "workspace_id" = $1 AND "business_profile_id" = $2 AND "id" = $3`,
      [...args, NEWER.toISOString()],
    );
    return holder;
  };

  /**
   * Forces the interleaving in which the older append finishes last: the newer message's transaction is
   * open and holding the row, the older append is proven to be waiting at it, and only then does the newer
   * one commit.
   */
  const forceOlderCommitsLast = async (conversationId: string) => {
    const holder = await openNewerMessageTransaction(conversationId);
    try {
      const older = appendInboundMessage(olderClient, profile.context, {
        conversationId,
        kind: "TEXT",
        text: "the older message",
        occurredAt: OLDER,
      });
      await waitForLockWaiters(1);

      await holder.query("COMMIT");
      return await older;
    } finally {
      await holder.end();
    }
  };

  const expectBothPersisted = async (
    conversationId: string,
    before: { stateVersion: number },
    beforeCount: number,
    olderMessageId: string,
  ) => {
    const rows = await inboundMessages(conversationId);
    expect(rows).toHaveLength(beforeCount + 2);

    // Two distinct rows, one from each side of the interleaving.
    const newerRow = rows.find((row) => row.text === "the newer message");
    const olderRow = rows.find((row) => row.id === olderMessageId);
    expect(newerRow).toBeDefined();
    expect(olderRow?.text).toBe("the older message");
    expect(newerRow?.id).not.toBe(olderRow?.id);
    expect(newerRow?.occurredAt.toISOString()).toBe(NEWER.toISOString());
    expect(olderRow?.occurredAt.toISOString()).toBe(OLDER.toISOString());

    const conversation = await readConversation(conversationId);
    // Two real appends, so exactly two increments — no synthetic counter movement stands in for one.
    expect(conversation.stateVersion).toBe(before.stateVersion + 2);
    // Without the row lock this is `2027-01-01T01:00:00.000Z`: the older append overwrote the newer one.
    expect(conversation.lastInboundAt?.toISOString()).toBe(NEWER.toISOString());
    expect(conversation.lastMessageAt.toISOString()).toBe(NEWER.toISOString());
  };

  it("keeps the newest timestamp when a real older append is forced to finish last", async () => {
    const conversationId = profile.conversationId;
    const before = await readConversation(conversationId);
    const beforeCount = (await inboundMessages(conversationId)).length;

    const olderMessage = await forceOlderCommitsLast(conversationId);

    await expectBothPersisted(conversationId, before, beforeCount, olderMessage.id);
  }, 120_000);

  it("does the same when the conversation had no inbound timestamp to begin with", async () => {
    // `lastInboundAt` starts NULL here, which is the branch the seeded fixture can never exercise.
    const conversationId = await emptyConversation();
    const before = await readConversation(conversationId);

    const olderMessage = await forceOlderCommitsLast(conversationId);

    await expectBothPersisted(conversationId, before, 0, olderMessage.id);
  }, 120_000);

  it("fills a NULL inbound timestamp but never moves a newer one backwards", async () => {
    const conversationId = await emptyConversation();
    const before = await readConversation(conversationId);
    // A message the platform stamped long ago — a real case for a backfill or a delayed webhook.
    const past = new Date("2020-05-05T08:00:00.000Z");

    await appendInboundMessage(olderClient, profile.context, {
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

  it("locks only the scoped row, so a missing conversation is still reported as not found", async () => {
    await expect(
      appendInboundMessage(olderClient, profile.context, {
        conversationId: "01a0b40c-0000-7000-8000-000000000000",
        kind: "TEXT",
        occurredAt: NEWER,
      }),
    ).rejects.toThrow(/Conversation/);
  });
});
