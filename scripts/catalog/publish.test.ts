/**
 * What `pnpm catalog:publish` decides, which is the only part of it worth testing without a database.
 *
 * The command's job is almost entirely a decision: publish into an empty catalogue, cut another version
 * when told to, or decline. The decline is the case that matters — a catalogue version is never edited, so
 * a repeat puts a second identical version on sale, and an operator who ran the deployment step twice
 * should be told rather than obeyed.
 */
import { describe, expect, it } from "vitest";

import { decidePublication } from "./publish.ts";

const empty = { planCodes: [], addOnCodes: [] };
const published = { planCodes: ["STARTER", "GROWTH", "SCALE"], addOnCodes: ["EXTRA_SEAT"] };

describe("deciding whether to publish the accepted catalogue", () => {
  it("publishes into a database that has none", () => {
    expect(decidePublication({ present: empty, republish: false })).toEqual({
      action: "PUBLISH",
      reason: "no plan or add-on version is published yet",
    });
  });

  it("declines a repeat and names what it found", () => {
    const decision = decidePublication({ present: published, republish: false });

    expect(decision.action).toBe("DECLINE");
    // The codes are in the message on purpose: an operator who sees "already published" without knowing
    // *what* is published has to go and look, and this runs where looking is least convenient.
    expect(decision.reason).toContain("STARTER");
    expect(decision.reason).toContain("EXTRA_SEAT");
    expect(decision.reason).toContain("--republish");
  });

  it("cuts a new version only when asked in as many words", () => {
    expect(decidePublication({ present: published, republish: true }).action).toBe("REPUBLISH");
  });

  it("publishes an empty catalogue without needing the flag", () => {
    // `--republish` is about not overwriting what is on sale. With nothing on sale it is irrelevant, and a
    // deployment step that demanded a flag on a fresh database would be a step nobody could run first.
    expect(decidePublication({ present: empty, republish: true }).action).toBe("PUBLISH");
  });

  it("treats an add-on alone as a published catalogue", () => {
    // Half a catalogue is still a catalogue: republishing over it would duplicate the add-on as well as
    // filling in the plans, and which half is missing is a question for whoever looks, not for this.
    expect(decidePublication({ present: { planCodes: [], addOnCodes: ["EXTRA_SEAT"] }, republish: false }).action).toBe("DECLINE");
    expect(decidePublication({ present: { planCodes: ["STARTER"], addOnCodes: [] }, republish: false }).action).toBe("DECLINE");
  });
});
