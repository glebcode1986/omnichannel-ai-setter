/**
 * Customer identity and durable memory (Issue #54).
 *
 * The cases here are mostly refusals, because the task is defined by what the product will not do. Four
 * of them are asserted against the database rather than against this file — a CHECK, or the absence of an
 * enum value — so they hold for a migration, a console session and any code written after this one.
 */
import { noRetrieval } from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import {
  confirmFact,
  confirmPreference,
  dismissDuplicateCandidate,
  expireStaleMemory,
  forgetCustomer,
  listContactPoints,
  listDuplicateCandidates,
  normalizeContactPoint,
  proposeFact,
  proposePreference,
  readAuthoritativeMemory,
  readConversationSummary,
  readMemoryHistory,
  recordContactPoint,
  recordConversationSummary,
  recordExternalIdentity,
  searchCustomers,
  searchLimit,
} from "./customer-memory-store";
import { createContactWithChannelIdentity } from "./repositories/contacts";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-10-01T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("customer identity and memory", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let sibling: SeededProfile;
  let neighbour: SeededWorkspace;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "memory", ["main", "sibling"]);
    [profile, sibling] = workspace.profiles as [SeededProfile, SeededProfile];
    neighbour = await seedWorkspace(database.db, "memory-neighbour");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  /** A second contact in the same profile, for the duplicate-candidate cases. */
  const anotherContact = async (name: string, target: SeededProfile = profile) => {
    seq += 1;
    const identity = await createContactWithChannelIdentity(db(), target.context, {
      channelAccountId: target.channelAccount.id,
      externalUserId: `memory-user-${String(seq)}`,
      displayName: name,
    });
    return identity.contactId;
  };

  describe("what the schema will not store", () => {
    /**
     * The strongest form this invariant can take.
     *
     * "No durable inferred vulnerability/wealth/psychological traits" is not a rule somebody could forget:
     * `CustomerFactCategory` has no value for one. A writer cannot store such a fact by being careless,
     * only by writing a migration that adds the value — which is a decision somebody makes on purpose.
     */
    it("has no category for an inferred vulnerability, wealth or psychological trait", async () => {
      const values = await db().$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label
          FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'CustomerFactCategory'`;
      const labels = values.map((row) => row.label);

      expect(labels.sort()).toEqual(["CONSENT", "CONTACT_PREFERENCE", "LOGISTICS", "SERVICE_HISTORY", "STATED_REQUIREMENT"]);
      for (const forbidden of ["VULNERABILITY", "WEALTH", "PSYCHOLOGICAL", "AFFLUENCE", "PERSUASION"]) {
        expect(labels, `the enum must not admit ${forbidden}`).not.toContain(forbidden);
      }
    }, 180_000);

    it("refuses such a category outright, because there is nothing to cast it to", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "customer_facts" ("workspace_id","business_profile_id","contact_id","category","subject","value","source","status","updated_at")
           VALUES ($1,$2,$3,'WEALTH','budget','high','HUMAN_RECORDED','SUGGESTED',NOW())`,
          profile.context.workspaceId,
          profile.businessProfileId,
          profile.contactId,
        ),
      ).rejects.toThrow(/invalid input value for enum|WEALTH/u);
    }, 180_000);

    /**
     * The other invariant the issue names, also in the database.
     *
     * A model may propose. Only a person makes memory authoritative, and the row has to say which person.
     */
    it("cannot make a fact authoritative without a person's name on it", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "customer_facts" ("workspace_id","business_profile_id","contact_id","category","subject","value","source","status","updated_at")
           VALUES ($1,$2,$3,'SERVICE_HISTORY','last visit','March','AI_SUGGESTED','ACTIVE',NOW())`,
          profile.context.workspaceId,
          profile.businessProfileId,
          profile.contactId,
        ),
      ).rejects.toThrow(/customer_facts_authority_check|customer_facts_ai_provenance_check/u);
    }, 180_000);

    it("cannot make a preference authoritative without one either", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "customer_preferences" ("workspace_id","business_profile_id","contact_id","subject","value","source","status","updated_at")
           VALUES ($1,$2,$3,'time of day','mornings','HUMAN_RECORDED','ACTIVE',NOW())`,
          profile.context.workspaceId,
          profile.businessProfileId,
          profile.contactId,
        ),
      ).rejects.toThrow(/customer_preferences_authority_check/u);
    }, 180_000);

    it("still accepts an ordinary suggestion, so the checks are not refusing everything", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "customer_facts" ("workspace_id","business_profile_id","contact_id","category","subject","value","source","status","updated_at")
           VALUES ($1,$2,$3,'LOGISTICS','parking','street only','CUSTOMER_STATED','SUGGESTED',NOW())`,
          profile.context.workspaceId,
          profile.businessProfileId,
          profile.contactId,
        ),
      ).resolves.toBeGreaterThan(0);
    }, 180_000);
  });

  describe("a model's proposal", () => {
    const aiDraft = async () => {
      seq += 1;
      const { aiDraftId } = await createAiDraftStore(db()).saveDraft({
        scope: { ...scope(), conversationId: profile.conversationId },
        generationKey: `memory_${String(seq)}`,
        trigger: "AUTOMATIC",
        anchorMessageId: profile.messageId,
        anchorStateVersion: 1,
        text: "Shall I book you for the usual slot?",
        structuredOutput: { reply: "x" },
        confidence: 0.9,
        modelSuggestsSend: true,
        needsReview: false,
        reasonCodes: [],
        factualSourceIds: [],
        retrieval: noRetrieval("OK"),
        status: "PENDING",
        provider: "anthropic",
        model: "claude-opus-5",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      });
      return aiDraftId;
    };

    it("is recorded as a suggestion and is invisible to a reader of authoritative memory", async () => {
      const draftId = await aiDraft();

      const outcome = await proposeFact(db(), profile.context, {
        contactId: profile.contactId,
        category: "SERVICE_HISTORY",
        subject: "usual slot",
        value: "Thursday at 4",
        source: "AI_SUGGESTED",
        sourceDraftId: draftId,
      });

      expect(outcome.status).toBe("RECORDED");
      const memory = await readAuthoritativeMemory(db(), profile.context, profile.contactId, AT);
      // The model said it. Nothing that reads memory as the business's own can see it.
      expect(memory.facts.map((fact) => fact.subject)).not.toContain("usual slot");
      const history = await readMemoryHistory(db(), profile.context, profile.contactId);
      expect(history.facts.find((fact) => fact.subject === "usual slot")?.status).toBe("SUGGESTED");
    }, 180_000);

    it("must name the draft it came from, so a person can read the reply before believing it", async () => {
      expect(
        await proposeFact(db(), profile.context, {
          contactId: profile.contactId,
          category: "SERVICE_HISTORY",
          subject: "unsourced",
          value: "something",
          source: "AI_SUGGESTED",
        }),
      ).toEqual({ status: "REFUSED", reason: "a model's proposal must name the draft it came from" });
    }, 180_000);

    it("refuses a fact or preference with nothing in it", async () => {
      for (const [subject, value] of [["", "value"], ["subject", ""], ["  ", "  "]] as const) {
        expect(await proposeFact(db(), profile.context, { contactId: profile.contactId, category: "LOGISTICS", subject, value, source: "HUMAN_RECORDED" })).toEqual({
          status: "REFUSED",
          reason: "a fact needs both a subject and a value",
        });
        expect(await proposePreference(db(), profile.context, { contactId: profile.contactId, subject, value, source: "HUMAN_RECORDED" })).toEqual({
          status: "REFUSED",
          reason: "a preference needs both a subject and a value",
        });
      }
    }, 180_000);

    it("becomes memory only when a person confirms it, and the row names them", async () => {
      const draftId = await aiDraft();
      const proposed = await proposeFact(db(), profile.context, {
        contactId: profile.contactId,
        category: "STATED_REQUIREMENT",
        subject: "allergy",
        value: "none stated",
        source: "AI_SUGGESTED",
        sourceDraftId: draftId,
      });
      const factId = proposed.status === "RECORDED" ? proposed.id : "";

      expect(await confirmFact(db(), profile.context, factId, AT)).toEqual({ status: "CONFIRMED", id: factId });

      const memory = await readAuthoritativeMemory(db(), profile.context, profile.contactId, AT);
      const fact = memory.facts.find((candidate) => candidate.subject === "allergy");
      expect(fact?.value).toBe("none stated");
      expect(fact?.confirmedByName).toBe("Test memory-owner");
      // The provenance survives confirmation: it is still the model that proposed it.
      expect(fact?.source).toBe("AI_SUGGESTED");
      expect(fact?.sourceDraftId).toBe(draftId);
    }, 180_000);

    it("cannot be confirmed twice", async () => {
      const draftId = await aiDraft();
      const proposed = await proposeFact(db(), profile.context, {
        contactId: profile.contactId,
        category: "CONSENT",
        subject: "marketing",
        value: "declined",
        source: "AI_SUGGESTED",
        sourceDraftId: draftId,
      });
      const factId = proposed.status === "RECORDED" ? proposed.id : "";
      await confirmFact(db(), profile.context, factId, AT);

      expect(await confirmFact(db(), profile.context, factId, AT)).toEqual({ status: "GONE" });
    }, 180_000);
  });

  describe("superseding and expiry", () => {
    const recordAndConfirm = async (subject: string, value: string, expiresAt?: Date) => {
      const proposed = await proposeFact(db(), profile.context, {
        contactId: profile.contactId,
        category: "LOGISTICS",
        subject,
        value,
        source: "HUMAN_RECORDED",
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      const id = proposed.status === "RECORDED" ? proposed.id : "";
      await confirmFact(db(), profile.context, id, AT);
      return id;
    };

    it("replaces the older entry for the same subject and keeps it as history", async () => {
      const first = await recordAndConfirm("address", "12 High Street");
      const second = await recordAndConfirm("address", "44 Mill Lane");

      const memory = await readAuthoritativeMemory(db(), profile.context, profile.contactId, AT);
      const addresses = memory.facts.filter((fact) => fact.subject === "address");
      // Exactly one current answer: memory that contradicted itself would be worse than none.
      expect(addresses).toHaveLength(1);
      expect(addresses[0]?.value).toBe("44 Mill Lane");

      const history = await readMemoryHistory(db(), profile.context, profile.contactId);
      expect(history.facts.find((fact) => fact.id === first)?.status).toBe("SUPERSEDED");
      expect(history.facts.find((fact) => fact.id === second)?.status).toBe("ACTIVE");
    }, 180_000);

    it("stops returning an entry whose expiry has passed, before anything marks it expired", async () => {
      await recordAndConfirm("temporary code", "4417", new Date(AT.getTime() + 60_000));

      const live = await readAuthoritativeMemory(db(), profile.context, profile.contactId, AT);
      const later = await readAuthoritativeMemory(db(), profile.context, profile.contactId, new Date(AT.getTime() + 120_000));

      // Applied on read rather than trusted to a sweeper: a late job must not make stale memory
      // authoritative for as long as it is behind.
      expect(live.facts.map((fact) => fact.subject)).toContain("temporary code");
      expect(later.facts.map((fact) => fact.subject)).not.toContain("temporary code");
    }, 180_000);

    it("marks expired entries when housekeeping runs, so the history matches the reader", async () => {
      await recordAndConfirm("short lived", "value", new Date(AT.getTime() + 60_000));

      const swept = await expireStaleMemory(db(), profile.context, new Date(AT.getTime() + 120_000));

      expect(swept.facts).toBeGreaterThan(0);
      const history = await readMemoryHistory(db(), profile.context, profile.contactId);
      expect(history.facts.find((fact) => fact.subject === "short lived")?.status).toBe("EXPIRED");
      // And nothing else: a sweeper that expired memory with no expiry date would quietly erase the
      // business's own record every time it ran.
      expect(history.facts.find((fact) => fact.subject === "address")?.status).toBe("ACTIVE");
    }, 180_000);

    it("does the same for preferences", async () => {
      const proposed = await proposePreference(db(), profile.context, {
        contactId: profile.contactId,
        subject: "time of day",
        value: "mornings",
        source: "CUSTOMER_STATED",
      });
      const id = proposed.status === "RECORDED" ? proposed.id : "";
      await confirmPreference(db(), profile.context, id, AT);

      const memory = await readAuthoritativeMemory(db(), profile.context, profile.contactId, AT);
      expect(memory.preferences.find((preference) => preference.subject === "time of day")?.value).toBe("mornings");
      expect(memory.preferences.find((preference) => preference.subject === "time of day")?.confirmedByName).toBe("Test memory-owner");
    }, 180_000);
  });

  describe("identity links", () => {
    it("normalizes a phone and an email so two spellings are one contact point", () => {
      expect(normalizeContactPoint("PHONE", " +34 600 111 222 ")).toBe("+34600111222");
      expect(normalizeContactPoint("PHONE", "(34) 600-111-222")).toBe("+34600111222");
      expect(normalizeContactPoint("EMAIL", "  Ann@Example.TEST ")).toBe("ann@example.test");
    });

    it("records a contact point and returns it", async () => {
      const outcome = await recordContactPoint(db(), profile.context, {
        contactId: profile.contactId,
        kind: "PHONE",
        value: "+34 600 111 222",
        verification: "CUSTOMER_STATED",
      });

      expect(outcome.status).toBe("RECORDED");
      const points = await listContactPoints(db(), profile.context, profile.contactId);
      // The raw spelling is kept because that is what an operator recognises on screen.
      expect(points.find((point) => point.normalizedValue === "+34600111222")?.rawValue).toBe("+34 600 111 222");
      // One customer's points, not the profile's: a contact panel showing somebody else's phone number
      // would be a disclosure inside the business as well as a bug.
      expect(points.every((point) => point.contactId === profile.contactId)).toBe(true);
      const elsewhere = await anotherContact("Not This Panel");
      await recordContactPoint(db(), profile.context, { contactId: elsewhere, kind: "EMAIL", value: "elsewhere@example.test", verification: "CUSTOMER_STATED" });
      expect((await listContactPoints(db(), profile.context, profile.contactId)).map((point) => point.contactId)).not.toContain(elsewhere);
    }, 180_000);

    it("suggests a duplicate for a weak match, and merges nothing", async () => {
      const other = await anotherContact("Same Number Person");

      const outcome = await recordContactPoint(db(), profile.context, {
        contactId: other,
        kind: "PHONE",
        value: "+34 600 111 222",
        verification: "CUSTOMER_STATED",
      });

      // A number somebody typed into a chat is worth recording and is not proof: people mistype, and
      // people give a partner's number.
      expect(outcome.status).toBe("SUGGESTED_DUPLICATE");
      const candidates = await listDuplicateCandidates(db(), profile.context);
      expect(candidates.some((candidate) => candidate.contactId === other || candidate.otherContactId === other)).toBe(true);
      // Both contacts still exist, separately.
      expect(await db().contact.count({ where: { ...scope(), id: { in: [profile.contactId, other] } } })).toBe(2);
    }, 180_000);

    it("offers the same pair once, however many times it is noticed", async () => {
      const other = await anotherContact("Repeatedly Matched");
      await recordContactPoint(db(), profile.context, { contactId: other, kind: "EMAIL", value: "shared@example.test", verification: "CUSTOMER_STATED" });
      await recordContactPoint(db(), profile.context, { contactId: profile.contactId, kind: "EMAIL", value: "shared@example.test", verification: "CUSTOMER_STATED" });
      await recordContactPoint(db(), profile.context, { contactId: profile.contactId, kind: "EMAIL", value: "SHARED@EXAMPLE.TEST", verification: "CUSTOMER_STATED" });

      const candidates = await listDuplicateCandidates(db(), profile.context);
      const forPair = candidates.filter(
        (candidate) => [candidate.contactId, candidate.otherContactId].includes(other) && [candidate.contactId, candidate.otherContactId].includes(profile.contactId),
      );
      // A suggestion queue that repeated itself is one somebody stops reading.
      expect(forPair).toHaveLength(1);
    }, 180_000);

    it("associates automatically only when both sides are provider-verified", async () => {
      const other = await anotherContact("Verified Both Sides");
      await recordContactPoint(db(), profile.context, { contactId: other, kind: "PHONE", value: "+34999000111", verification: "PROVIDER_VERIFIED" });

      const outcome = await recordContactPoint(db(), profile.context, {
        contactId: profile.contactId,
        kind: "PHONE",
        value: "+34999000111",
        verification: "PROVIDER_VERIFIED",
      });

      // Strong deterministic evidence: somebody other than the customer vouched for it on both sides.
      expect(outcome.status).toBe("ASSOCIATED");
      // Associated is still not merged: the contacts remain separate records.
      expect(await db().contact.count({ where: { ...scope(), id: { in: [profile.contactId, other] } } })).toBe(2);
    }, 180_000);

    it("still only suggests when one side is provider-verified and the other is not", async () => {
      const other = await anotherContact("One Side Verified");
      await recordContactPoint(db(), profile.context, { contactId: other, kind: "PHONE", value: "+34888000111", verification: "PROVIDER_VERIFIED" });

      const outcome = await recordContactPoint(db(), profile.context, {
        contactId: profile.contactId,
        kind: "PHONE",
        value: "+34888000111",
        verification: "CUSTOMER_STATED",
      });

      // The provider vouched for the number against *the other* contact. That is not evidence about this
      // one, so the strong path must need both sides, not either.
      expect(outcome.status).toBe("SUGGESTED_DUPLICATE");
    }, 180_000);

    it("does the same when the verified side arrives second", async () => {
      const other = await anotherContact("Verified Second");
      await recordContactPoint(db(), profile.context, { contactId: other, kind: "PHONE", value: "+34888000222", verification: "CUSTOMER_STATED" });

      const outcome = await recordContactPoint(db(), profile.context, {
        contactId: profile.contactId,
        kind: "PHONE",
        value: "+34888000222",
        verification: "PROVIDER_VERIFIED",
      });

      expect(outcome.status).toBe("SUGGESTED_DUPLICATE");
    }, 180_000);

    it("lets verification strengthen but never weaken", async () => {
      const contactId = await anotherContact("Strengthening");
      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "strength@example.test", verification: "CUSTOMER_STATED" });

      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "strength@example.test", verification: "UNVERIFIED" });
      const afterSoft = await listContactPoints(db(), profile.context, contactId);
      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "strength@example.test", verification: "PROVIDER_VERIFIED" });
      const afterStrong = await listContactPoints(db(), profile.context, contactId);

      // Restating a value is not evidence about it. A provider vouching for it is.
      expect(afterSoft.find((point) => point.normalizedValue === "strength@example.test")?.verification).toBe("CUSTOMER_STATED");
      expect(afterStrong.find((point) => point.normalizedValue === "strength@example.test")?.verification).toBe("PROVIDER_VERIFIED");
    }, 180_000);

    it("refuses a value that is not a contact point at all", async () => {
      for (const value of ["", "   ", "-- --"]) {
        expect(await recordContactPoint(db(), profile.context, { contactId: profile.contactId, kind: "PHONE", value, verification: "CUSTOMER_STATED" })).toEqual({
          status: "REFUSED",
          reason: "that is not a usable contact point",
        });
      }
    }, 180_000);

    it("keeps a dismissed suggestion out of the queue without forgetting it", async () => {
      const other = await anotherContact("Dismissed Match");
      const outcome = await recordContactPoint(db(), profile.context, { contactId: other, kind: "EMAIL", value: "dismissed@example.test", verification: "CUSTOMER_STATED" });
      await recordContactPoint(db(), profile.context, { contactId: profile.contactId, kind: "EMAIL", value: "dismissed@example.test", verification: "CUSTOMER_STATED" });
      const candidates = await listDuplicateCandidates(db(), profile.context);
      const target = candidates.find(
        (candidate) => [candidate.contactId, candidate.otherContactId].includes(other) && [candidate.contactId, candidate.otherContactId].includes(profile.contactId),
      );

      await dismissDuplicateCandidate(db(), profile.context, target?.id ?? "", AT);

      expect((await listDuplicateCandidates(db(), profile.context)).map((candidate) => candidate.id)).not.toContain(target?.id);
      expect(await db().duplicateContactCandidate.count({ where: { ...scope(), id: target?.id } })).toBe(1);
      expect(outcome.status).toBe("RECORDED");
    }, 180_000);

    /**
     * The decision this whole task rests on.
     *
     * The same phone number in two Business Profiles is two unrelated customers. Not a filter somebody
     * could forget — the unique index is scoped to the profile, so both rows exist and neither profile
     * can see the other's.
     */
    it("treats the same phone number in another Business Profile as a different customer", async () => {
      const here = await anotherContact("Here");
      const there = await anotherContact("There", sibling);
      const number = "+34700700700";

      expect((await recordContactPoint(db(), profile.context, { contactId: here, kind: "PHONE", value: number, verification: "PROVIDER_VERIFIED" })).status).toBe("RECORDED");
      expect((await recordContactPoint(db(), sibling.context, { contactId: there, kind: "PHONE", value: number, verification: "PROVIDER_VERIFIED" })).status).toBe("RECORDED");

      // No duplicate suggestion crosses the profiles, and neither search sees the other's customer.
      const candidatesHere = await listDuplicateCandidates(db(), profile.context);
      expect(candidatesHere.some((candidate) => [candidate.contactId, candidate.otherContactId].includes(there))).toBe(false);
      expect((await searchCustomers(db(), profile.context, number)).map((hit) => hit.contactId)).not.toContain(there);
      expect((await searchCustomers(db(), sibling.context, number)).map((hit) => hit.contactId)).not.toContain(here);
    }, 180_000);

    it("refuses an external identity with no system or no id", async () => {
      for (const [system, externalId] of [["", "X-1"], ["crm", ""], [" ", " "]] as const) {
        expect(await recordExternalIdentity(db(), profile.context, { contactId: profile.contactId, system, externalId })).toEqual({
          status: "REFUSED",
          reason: "an external identity needs both a system and an id",
        });
      }
    }, 180_000);

    it("records an external-system id and keeps it inside the profile", async () => {
      expect((await recordExternalIdentity(db(), profile.context, { contactId: profile.contactId, system: "booking", externalId: "BK-1001" })).status).toBe("RECORDED");

      expect((await searchCustomers(db(), profile.context, "BK-1001")).map((hit) => hit.contactId)).toContain(profile.contactId);
      expect(await searchCustomers(db(), sibling.context, "BK-1001")).toEqual([]);
    }, 180_000);
  });

  describe("search", () => {
    it("finds a customer by name, contact point, channel identifier and external id", async () => {
      const contactId = await anotherContact("Searchable Sam");
      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "sam@example.test", verification: "CUSTOMER_STATED" });
      await recordExternalIdentity(db(), profile.context, { contactId, system: "till", externalId: "TILL-77" });

      expect((await searchCustomers(db(), profile.context, "searchable")).map((hit) => hit.contactId)).toContain(contactId);
      expect((await searchCustomers(db(), profile.context, "sam@example.test")).map((hit) => hit.contactId)).toContain(contactId);
      expect((await searchCustomers(db(), profile.context, "TILL-77")).map((hit) => hit.contactId)).toContain(contactId);
    }, 180_000);

    it("says which field matched, so an operator can see why somebody came up", async () => {
      const contactId = await anotherContact("Why Matched");
      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "why@example.test", verification: "CUSTOMER_STATED" });

      expect((await searchCustomers(db(), profile.context, "why@example.test")).find((hit) => hit.contactId === contactId)?.matchedOn).toBe("CONTACT_POINT");
      expect((await searchCustomers(db(), profile.context, "Why Matched")).find((hit) => hit.contactId === contactId)?.matchedOn).toBe("NAME");
    }, 180_000);

    it("returns one row per customer, not one per reason", async () => {
      const contactId = await anotherContact("Duplicated Reasons");
      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "duplicated reasons@example.test".replace(" ", ""), verification: "CUSTOMER_STATED" });

      const hits = await searchCustomers(db(), profile.context, "Duplicated");
      expect(hits.filter((hit) => hit.contactId === contactId)).toHaveLength(1);
    }, 180_000);

    it("does not search message text unless the caller asks", async () => {
      const text = (await db().message.findFirst({ where: scope(), select: { text: true } }))?.text ?? "";
      expect(text, "the fixture must have a message to search for").not.toBe("");

      const identityOnly = await searchCustomers(db(), profile.context, text);
      const withText = await searchCustomers(db(), profile.context, text, { includeMessageText: true });

      // Searching customers' words is a different question from "who is this", so it is a decision at the
      // call site rather than something that happens whenever somebody types a name.
      expect(identityOnly).toEqual([]);
      expect(withText.map((hit) => hit.contactId)).toContain(profile.contactId);
      expect(withText.find((hit) => hit.contactId === profile.contactId)?.matchedOn).toBe("MESSAGE_TEXT");
    }, 180_000);

    it("keeps message text inside the Business Profile as well", async () => {
      const text = (await db().message.findFirst({ where: scope(), select: { text: true } }))?.text ?? "";

      expect(await searchCustomers(db(), sibling.context, text, { includeMessageText: true })).toEqual([]);
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      expect(await searchCustomers(db(), theirProfile.context, text, { includeMessageText: true })).toEqual([]);
    }, 180_000);

    it("ranks a name match above somebody who merely said the word", async () => {
      const named = await anotherContact("Ambiguous");
      // Somebody else used the word in a message, which is what would otherwise outrank the customer
      // actually called it.
      const planted = await db().message.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          direction: "IN",
          source: "PARTICIPANT",
          kind: "TEXT",
          text: "Is the Ambiguous option still available?",
          occurredAt: new Date(AT.getTime() - 5_000),
        },
        select: { id: true },
      });

      const hits = await searchCustomers(db(), profile.context, "Ambiguous", { includeMessageText: true });
      expect(hits.some((hit) => hit.matchedOn === "MESSAGE_TEXT")).toBe(true);
      await db().message.delete({ where: { id: planted.id } });

      // Otherwise a customer actually called Ambiguous can be pushed off the end of the list by everybody
      // who ever typed the word.
      expect(hits[0]?.contactId).toBe(named);
      expect(hits[0]?.matchedOn).toBe("NAME");
    }, 180_000);

    it("honours a caller's limit", async () => {
      expect(await searchCustomers(db(), profile.context, "a", { limit: 1 })).toHaveLength(1);
      expect((await searchCustomers(db(), profile.context, "a", { limit: 2 })).length).toBeGreaterThan(1);
    }, 180_000);

    it("clamps a nonsense limit to something an operator can read", () => {
      expect(searchLimit(25)).toBe(25);
      // A floor, so a caller's arithmetic slip shows one customer rather than a blank screen somebody
      // reads as "no such person".
      expect(searchLimit(0)).toBe(1);
      expect(searchLimit(-5)).toBe(1);
      // A ceiling, so no caller can pull every contact the business has in one query.
      expect(searchLimit(10_000)).toBe(100);
      expect(searchLimit(101)).toBe(100);
      expect(searchLimit(2.7)).toBe(2);
      expect(searchLimit(Number.NaN)).toBe(25);
      expect(searchLimit(Number.POSITIVE_INFINITY)).toBe(25);
    });

    it("finds nothing for an empty term rather than everything", async () => {
      expect(await searchCustomers(db(), profile.context, "   ")).toEqual([]);
      expect(await searchCustomers(db(), profile.context, "", { includeMessageText: true })).toEqual([]);
    }, 180_000);

    it("never discloses another Workspace's customers", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await anotherContact("Their Customer", theirProfile);
      // Their customer has memory worth leaking, otherwise an unscoped read would pass this by returning
      // nothing for a reason that has nothing to do with authorization.
      const proposed = await proposeFact(db(), theirProfile.context, {
        contactId: theirs,
        category: "LOGISTICS",
        subject: "their address",
        value: "somewhere private",
        source: "HUMAN_RECORDED",
      });
      await confirmFact(db(), theirProfile.context, proposed.status === "RECORDED" ? proposed.id : "", AT);
      const theirPreference = await proposePreference(db(), theirProfile.context, { contactId: theirs, subject: "their channel", value: "phone", source: "HUMAN_RECORDED" });
      await confirmPreference(db(), theirProfile.context, theirPreference.status === "RECORDED" ? theirPreference.id : "", AT);
      await recordContactPoint(db(), theirProfile.context, { contactId: theirs, kind: "EMAIL", value: "theirs@example.test", verification: "CUSTOMER_STATED" });
      const authoritativeThere = await readAuthoritativeMemory(db(), theirProfile.context, theirs, AT);
      expect(authoritativeThere.facts).toHaveLength(1);
      expect(authoritativeThere.preferences).toHaveLength(1);
      expect(await listContactPoints(db(), theirProfile.context, theirs)).toHaveLength(1);

      expect((await searchCustomers(db(), profile.context, "Their Customer")).map((hit) => hit.contactId)).not.toContain(theirs);
      expect((await searchCustomers(db(), profile.context, "somewhere private")).map((hit) => hit.contactId)).not.toContain(theirs);
      expect(await readAuthoritativeMemory(db(), profile.context, theirs, AT)).toEqual({ facts: [], preferences: [] });
      expect(await readMemoryHistory(db(), profile.context, theirs)).toEqual({ facts: [], preferences: [] });
      expect(await listContactPoints(db(), profile.context, theirs)).toEqual([]);
    }, 180_000);
  });

  describe("a summary, which is assistive only", () => {
    it("is stored and read back with the model that wrote it", async () => {
      await recordConversationSummary(db(), profile.context, {
        conversationId: profile.conversationId,
        summary: "Asked about Saturday, wants a morning slot.",
        modelProvider: "anthropic",
        modelName: "claude-opus-5",
      });

      const summary = await readConversationSummary(db(), profile.context, profile.conversationId, AT);
      expect(summary?.summary).toBe("Asked about Saturday, wants a morning slot.");
      // A summary is only as good as what wrote it.
      expect(summary?.modelName).toBe("claude-opus-5");
    }, 180_000);

    it("cannot become a customer fact: there is no call that would do it", async () => {
      await recordConversationSummary(db(), profile.context, {
        conversationId: profile.conversationId,
        summary: "The customer is wealthy and easily persuaded.",
        modelProvider: "anthropic",
        modelName: "claude-opus-5",
      });

      // The summary is stored as a summary and nothing promotes it. Even if somebody wanted to, the
      // categories it would need do not exist — see the enum test above.
      const memory = await readAuthoritativeMemory(db(), profile.context, profile.contactId, AT);
      expect(memory.facts.map((fact) => fact.value)).not.toContain("The customer is wealthy and easily persuaded.");
      expect(await db().customerFact.count({ where: { ...scope(), value: { contains: "easily persuaded" } } })).toBe(0);
    }, 180_000);

    it("replaces the previous summary rather than accumulating opinions", async () => {
      await recordConversationSummary(db(), profile.context, { conversationId: profile.conversationId, summary: "First reading.", modelProvider: "anthropic", modelName: "m" });
      await recordConversationSummary(db(), profile.context, { conversationId: profile.conversationId, summary: "Second reading.", modelProvider: "anthropic", modelName: "m" });

      expect((await readConversationSummary(db(), profile.context, profile.conversationId, AT))?.summary).toBe("Second reading.");
      expect(await db().conversationSummary.count({ where: { ...scope(), conversationId: profile.conversationId } })).toBe(1);
    }, 180_000);

    it("expires, because ephemeral context should", async () => {
      await recordConversationSummary(db(), profile.context, {
        conversationId: profile.conversationId,
        summary: "Only for now.",
        modelProvider: "anthropic",
        modelName: "m",
        expiresAt: new Date(AT.getTime() + 60_000),
      });

      expect(await readConversationSummary(db(), profile.context, profile.conversationId, AT)).toBeDefined();
      expect(await readConversationSummary(db(), profile.context, profile.conversationId, new Date(AT.getTime() + 120_000))).toBeUndefined();
    }, 180_000);

    it("cannot be read from another Workspace", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await recordConversationSummary(db(), theirProfile.context, { conversationId: theirProfile.conversationId, summary: "Theirs.", modelProvider: "anthropic", modelName: "m" });

      expect(await readConversationSummary(db(), profile.context, theirProfile.conversationId, AT)).toBeUndefined();
    }, 180_000);
  });

  describe("forgetting a customer", () => {
    it("removes the memory and counts what it removed", async () => {
      const contactId = await anotherContact("To Be Forgotten");
      await recordContactPoint(db(), profile.context, { contactId, kind: "EMAIL", value: "forget@example.test", verification: "CUSTOMER_STATED" });
      await recordExternalIdentity(db(), profile.context, { contactId, system: "crm", externalId: "CRM-9" });
      await proposeFact(db(), profile.context, { contactId, category: "LOGISTICS", subject: "address", value: "somewhere", source: "HUMAN_RECORDED" });
      await proposePreference(db(), profile.context, { contactId, subject: "channel", value: "email", source: "HUMAN_RECORDED" });

      const outcome = await forgetCustomer(db(), profile.context, contactId);

      // "We deleted your data" is a claim that should be countable.
      expect(outcome.status).toBe("FORGOTTEN");
      expect(outcome.removed).toMatchObject({ contactPoints: 1, externalIdentities: 1, facts: 1, preferences: 1 });
      expect(await db().contactPoint.count({ where: { ...scope(), contactId } })).toBe(0);
      expect(await db().customerFact.count({ where: { ...scope(), contactId } })).toBe(0);
    }, 180_000);

    it("leaves the correspondence alone, which is the business's own record", async () => {
      const before = await db().message.count({ where: scope() });

      await forgetCustomer(db(), profile.context, profile.contactId);

      // Deleting a customer's record is not deleting the business's own correspondence, and conflating
      // them would destroy an audit trail somebody may be required to keep.
      expect(await db().message.count({ where: scope() })).toBe(before);
    }, 180_000);

    it("is the only way memory goes away: a stray contact delete is refused", async () => {
      // No channel identity, so the only thing holding this contact down is the memory itself. With one,
      // a pre-existing rule refuses the delete first and this test would prove nothing about mine.
      const { id: contactId } = await db().contact.create({ data: { ...scope(), displayName: "Deleted Out From Under" }, select: { id: true } });
      await proposeFact(db(), profile.context, { contactId, category: "LOGISTICS", subject: "address", value: "somewhere", source: "HUMAN_RECORDED" });

      // Nothing cascades from the contact. `constraints.integration.test.ts` holds the whole schema to
      // that; here it is what it means in practice — memory is removed on purpose or not at all.
      const blocked = await db()
        .contact.delete({ where: { id: contactId } })
        .then(() => "deleted")
        .catch((error: unknown) => String((error as { meta?: { driverAdapterError?: { cause?: { constraint?: { index?: string } } } } }).meta?.driverAdapterError?.cause?.constraint?.index));
      expect(blocked).toContain("customer_facts");

      // And once the memory is gone on purpose, the delete goes through.
      await forgetCustomer(db(), profile.context, contactId);
      await expect(db().contact.delete({ where: { id: contactId } })).resolves.toBeDefined();
    }, 180_000);

    it("cannot forget a customer of another Workspace", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await anotherContact("Not Ours To Forget", theirProfile);

      expect(await forgetCustomer(db(), profile.context, theirs)).toEqual({ status: "GONE", removed: {} });
      expect(await db().contact.count({ where: { id: theirs } })).toBe(1);
    }, 180_000);
  });
});
