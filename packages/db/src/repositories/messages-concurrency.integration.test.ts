/**
 * Live PostgreSQL regression for concurrent inbound appends.
 *
 * The defect this pins is not visible to a stubbed transaction: the guarantee now lives in the database's
 * row lock, so only a real server contending on a real row can demonstrate it. Two messages arriving at
 * once must leave the conversation's timestamps at the *newest* of them, whatever order the two
 * transactions happen to commit in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendInboundMessage } from "./messages";
import { createDbClient, type DbClient } from "../client";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../testing/database";
import { seedWorkspace, type SeededProfile } from "../testing/fixtures";

// Later than anything the shared fixture seeds, so the assertions are about this test's own writes.
const OLDER = new Date("2027-01-01T01:00:00.000Z");
const NEWER = new Date("2027-01-01T02:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("concurrent inbound appends (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  /**
   * Two independent clients, so the two appends really do run at once. One Prisma client serialises its
   * own interactive transactions, which would make this suite pass against the very defect it exists to
   * catch — the failure mode needs two transactions open on two connections at the same moment.
   */
  let clientA: DbClient;
  let clientB: DbClient;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "concurrency")).profiles as [SeededProfile];
    clientA = createDbClient({ connectionString: database.url });
    clientB = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await clientA?.$disconnect();
    await clientB?.$disconnect();
    await database?.dispose();
  });

  const conversation = () =>
    database.db.conversation.findUniqueOrThrow({
      where: {
        workspaceId_businessProfileId_id: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          id: profile.conversationId,
        },
      },
      select: { lastInboundAt: true, lastMessageAt: true, stateVersion: true },
    });

  const inboundCount = () =>
    database.db.message.count({
      where: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        conversationId: profile.conversationId,
        direction: "IN",
      },
    });

  it("never lets a late older message pull the conversation's timestamps backwards", async () => {
    const before = await conversation();
    const messagesBefore = await inboundCount();
    let appended = 0;

    // Repeated because the losing interleaving is the one that matters and it is chosen by the pool, not
    // by us: the newer append is started first and the older one a beat later, which is exactly the order
    // that made an unlocked read-compute-write commit the older value last.
    for (let round = 0; round < 25; round += 1) {
      const newer = appendInboundMessage(clientA, profile.context, {
        conversationId: profile.conversationId,
        kind: "TEXT",
        text: `newer ${String(round)}`,
        occurredAt: NEWER,
      });
      await Promise.resolve();
      const older = appendInboundMessage(clientB, profile.context, {
        conversationId: profile.conversationId,
        kind: "TEXT",
        text: `older ${String(round)}`,
        occurredAt: OLDER,
      });

      const [newerMessage, olderMessage] = await Promise.all([newer, older]);
      appended += 2;

      // Both messages are persisted, whichever transaction went first.
      expect(newerMessage.id).not.toBe(olderMessage.id);

      const after = await conversation();
      expect(after.lastInboundAt?.toISOString()).toBe(NEWER.toISOString());
      expect(after.lastMessageAt.toISOString()).toBe(NEWER.toISOString());
      expect(after.stateVersion).toBe(before.stateVersion + appended);
    }

    // Nothing was lost or silently merged: the lock serialises the appends, it does not drop them.
    expect(await inboundCount()).toBe(messagesBefore + appended);
  }, 120_000);

  it("holds the lock across the whole append, so a concurrent append waits rather than interleaving", async () => {
    const before = await conversation();

    // Ten simultaneous appends with descending timestamps. Every one must be stored, the state version
    // must advance exactly once per message, and the newest timestamp must survive all of them.
    const newest = new Date("2027-02-01T12:00:00.000Z");
    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        appendInboundMessage(index % 2 === 0 ? clientA : clientB, profile.context, {
          conversationId: profile.conversationId,
          kind: "TEXT",
          text: `burst ${String(index)}`,
          occurredAt: new Date(newest.getTime() - index * 60_000),
        }),
      ),
    );

    const after = await conversation();
    expect(after.lastInboundAt?.toISOString()).toBe(newest.toISOString());
    expect(after.lastMessageAt.toISOString()).toBe(newest.toISOString());
    expect(after.stateVersion).toBe(before.stateVersion + 10);
  }, 120_000);

  it("locks only the scoped row, so a missing conversation is still reported as not found", async () => {
    await expect(
      appendInboundMessage(database.db, profile.context, {
        conversationId: "01a0b40c-0000-7000-8000-000000000000",
        kind: "TEXT",
        occurredAt: NEWER,
      }),
    ).rejects.toThrow(/Conversation/);
  });
});
