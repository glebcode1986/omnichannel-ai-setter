/**
 * The two spellings of one key (Issue #56).
 *
 * A delivery claim derives the advisory keys that could cover it in TypeScript; the trigger on
 * `automation_suspensions` derives the key a write is ordered under in SQL. The ordering is only real
 * while those two agree, and nothing about a hash mismatch is visible at runtime: the claim would simply
 * never wait, and the race would be back with every test still green.
 *
 * So this holds the two derivations against each other, through the same `hashtextextended` both sides
 * actually use. It is the only test in the repository that would notice either one being edited alone.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { suspensionLockKeyOf, suspensionLockKeysFor } from "./suspension-lock";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";

const WORKSPACE = "ws_01JABCDEF0000000000000001";
const PROFILE = "bp_01JABCDEF0000000000000002";
const ACCOUNT = "ca_01JABCDEF0000000000000003";

describe.skipIf(!databaseTestsEnabled())("the kill-switch advisory key", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const sqlKey = async (scope: string, workspaceId: string | null, businessProfileId: string | null, channelAccountId: string | null) => {
    const rows = await database.db.$queryRaw<{ key: string; hashed: bigint }[]>`
      SELECT "automation_suspension_key"(${scope}::"SuspensionScope", ${workspaceId}, ${businessProfileId}, ${channelAccountId}) AS key,
             hashtextextended("automation_suspension_key"(${scope}::"SuspensionScope", ${workspaceId}, ${businessProfileId}, ${channelAccountId}), 0) AS hashed`;
    return rows[0];
  };

  const tsHash = async (key: string) => {
    const rows = await database.db.$queryRaw<{ hashed: bigint }[]>`SELECT hashtextextended(${key}, 0) AS hashed`;
    return rows[0]?.hashed;
  };

  const cases = [
    { scope: "GLOBAL", workspaceId: null, businessProfileId: null, channelAccountId: null },
    { scope: "WORKSPACE", workspaceId: WORKSPACE, businessProfileId: null, channelAccountId: null },
    { scope: "BUSINESS_PROFILE", workspaceId: WORKSPACE, businessProfileId: PROFILE, channelAccountId: null },
    { scope: "CHANNEL_ACCOUNT", workspaceId: WORKSPACE, businessProfileId: null, channelAccountId: ACCOUNT },
  ] as const;

  for (const row of cases) {
    it(`is the same string and the same hash on both sides for ${row.scope}`, async () => {
      const fromSql = await sqlKey(row.scope, row.workspaceId, row.businessProfileId, row.channelAccountId);
      const fromTypeScript = suspensionLockKeyOf(row);

      expect(fromSql?.key).toBe(fromTypeScript);
      expect(fromSql?.hashed).toBe(await tsHash(fromTypeScript));
    }, 120_000);
  }

  /**
   * The property the ordering actually rests on, stated directly.
   *
   * Parity of one spelling is not enough on its own: what has to be true is that a switch which *covers*
   * a send derives a key that send's claim is already holding. It does, and not by luck — a covering
   * switch is one whose scope and identifiers are the target's own, so the two sides build the identical
   * string rather than a similar one.
   */
  it("derives, for every covering switch, a key the target's claim already holds", async () => {
    const target = { workspaceId: WORKSPACE, businessProfileId: PROFILE, channelAccountId: ACCOUNT };
    const claimKeys = suspensionLockKeysFor(target);

    for (const row of cases) {
      const writerKey = await sqlKey(row.scope, row.workspaceId, row.businessProfileId, row.channelAccountId);
      expect(claimKeys, `${row.scope} covers this target but its key is not one the claim takes`).toContain(writerKey?.key);
    }
  }, 120_000);

  it("covers every key a claim would take, and no scope is missing one", async () => {
    const claimKeys = suspensionLockKeysFor({ workspaceId: WORKSPACE, businessProfileId: PROFILE, channelAccountId: ACCOUNT });
    const writerKeys = await Promise.all(cases.map((row) => sqlKey(row.scope, row.workspaceId, row.businessProfileId, row.channelAccountId)));

    // Every scope a switch can be written at is a key the claim holds. A scope the claim did not cover
    // would be a switch that orders against nothing at all.
    expect(claimKeys).toHaveLength(cases.length);
    expect([...claimKeys].sort()).toEqual([...writerKeys.map((row) => row?.key ?? "")].sort());
  }, 120_000);
});
