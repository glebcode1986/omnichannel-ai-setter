/**
 * The dashboard locale must never reach a customer (Issue #58, LOCALIZATION.md).
 *
 * This is the requirement the whole feature is shaped around, and the one whose failure would be visible
 * to a customer rather than to us: an operator reading Russian must not cause a German customer to be
 * answered in Russian.
 *
 * It is tested against a real database because the claim is structural — the two languages live on
 * different rows, owned by different entities — and a test with fakes would only be checking that I wired
 * my own fakes consistently.
 */
import {
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createStyleProfileStore,
  createWorkspaceWithOwner,
} from "@omnichannel/db";
import { resolveStyleProfile } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveUiLocale } from "./locales";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../server/testing/database";

describe.skipIf(!databaseTestsEnabled())("a dashboard locale and a customer's language", () => {
  let database: TestDatabase;
  let userId: string;
  let workspaceId: string;
  let businessProfileId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const user = await db.user.create({ data: { name: "Agency Operator", email: "operator@example.test" } });
    userId = user.id;
    ({ workspaceId } = await createWorkspaceWithOwner(db, { name: "Agency", ownerUserId: userId }));
    const workspace = await authorizeWorkspaceAccess(db, { userId, workspaceId });
    ({ businessProfileId } = await createBusinessProfile(db, workspace, { name: "A German bakery" }));

    // The business answers its customers in German. Nothing about the operator is involved in that.
    await db.styleProfile.create({
      data: { workspaceId, businessProfileId, persona: "Warm and brief", language: "de" },
    });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** The language the assistant replies in, resolved the way the draft engine resolves it. */
  const businessLanguage = async () => {
    const layers = await createStyleProfileStore(database.db).load({ workspaceId, businessProfileId });
    return resolveStyleProfile(layers).language;
  };

  it("keeps the customer's language when the operator switches the interface to Russian", async () => {
    expect(await businessLanguage()).toBe("de");

    await database.db.user.update({ where: { id: userId }, data: { uiLocale: "ru" } });

    // The operator now reads the software in Russian. The bakery still answers in German.
    const reread = await database.db.user.findUniqueOrThrow({ where: { id: userId }, select: { uiLocale: true } });
    expect(resolveUiLocale(reread.uiLocale)).toBe("ru");
    expect(await businessLanguage()).toBe("de");
  }, 180_000);

  it("stores the two on different rows, so neither write can touch the other", async () => {
    // The structural claim, stated as a fact about the schema rather than a hope about the code: the
    // preference is a column on `users`, and the reply language is a column on the profile's style
    // profile. There is no query that could update one and mean the other.
    const [user, styleProfiles] = await Promise.all([
      database.db.user.findUniqueOrThrow({ where: { id: userId }, select: { uiLocale: true } }),
      database.db.styleProfile.findMany({ where: { workspaceId, businessProfileId }, select: { language: true } }),
    ]);

    expect(user.uiLocale).toBe("ru");
    expect(styleProfiles.map((profile) => profile.language)).toEqual(["de"]);
  }, 180_000);

  it("gives two operators of the same business different interfaces and one customer language", async () => {
    const second = await database.db.user.create({ data: { name: "Second Operator", email: "operator2@example.test" } });
    await database.db.user.update({ where: { id: second.id }, data: { uiLocale: "en" } });

    const first = await database.db.user.findUniqueOrThrow({ where: { id: userId }, select: { uiLocale: true } });
    const other = await database.db.user.findUniqueOrThrow({ where: { id: second.id }, select: { uiLocale: true } });

    expect([resolveUiLocale(first.uiLocale), resolveUiLocale(other.uiLocale)]).toEqual(["ru", "en"]);
    // One business, one language for its customers, whoever is looking at the screen.
    expect(await businessLanguage()).toBe("de");
  }, 180_000);
});
