/**
 * What a form is allowed to say about the voice (Issue #32).
 *
 * `replyLength` and `emoji` are enum columns. The hostile case is a hand-edited form naming a member
 * nobody defined — which must become "no preference" rather than reaching the column, because a value the
 * enum does not have is a write that fails at the database with nothing on screen to explain it.
 */
import { describe, expect, it } from "vitest";

import { lines, scopeFrom, voiceDraftFrom } from "./style-form";

const form = (entries: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
};

describe("reading the voice from a form", () => {
  it("reads every field", () => {
    const draft = voiceDraftFrom(
      form({
        persona: "A calm salon",
        tone: "warm",
        replyLength: "SHORT",
        emoji: "SPARING",
        greeting: "Hi!",
        signOff: "See you",
        preferred: "happy to help\nof course",
        avoided: "cheap",
        language: "en",
      }),
    );

    expect(draft.persona).toBe("A calm salon");
    expect(draft.replyLength).toBe("SHORT");
    expect(draft.emoji).toBe("SPARING");
    expect(draft.preferredPhrases).toEqual(["happy to help", "of course"]);
    expect(draft.avoidedPhrases).toEqual(["cheap"]);
  });

  it.each(["LENGTHY", "short", "", "0"])("treats %o as no preference for reply length", (value) => {
    // Not an error and not a guess: the same thing an empty select means.
    expect(voiceDraftFrom(form({ replyLength: value })).replyLength).toBeNull();
  });

  it.each(["LOTS", "sparing", "", "true"])("treats %o as no preference for emoji", (value) => {
    expect(voiceDraftFrom(form({ emoji: value })).emoji).toBeNull();
  });

  it("accepts every member the domain does define", () => {
    for (const value of ["SHORT", "MEDIUM", "LONG"]) {
      expect(voiceDraftFrom(form({ replyLength: value })).replyLength).toBe(value);
    }
    for (const value of ["NONE", "SPARING", "FREELY"]) {
      expect(voiceDraftFrom(form({ emoji: value })).emoji).toBe(value);
    }
  });

  it("drops blank lines and trims the rest, so a stray newline is not a phrase", () => {
    expect(lines(form({ preferred: "  one  \n\n   \ntwo\n" }), "preferred")).toEqual(["one", "two"]);
  });

  it("reads a missing field as empty rather than throwing", () => {
    const draft = voiceDraftFrom(new FormData());

    expect(draft.persona).toBe("");
    expect(draft.preferredPhrases).toEqual([]);
    expect(draft.replyLength).toBeNull();
  });

  it("reads a File as no value, because a file is not a phrase", () => {
    const data = new FormData();
    data.set("persona", new File(["x"], "persona.txt"));

    expect(voiceDraftFrom(data).persona).toBe("");
  });
});

describe("which layer a save lands on", () => {
  it("is the Workspace base only when the form said so", () => {
    expect(scopeFrom(form({ scope: "WORKSPACE" }))).toBe("WORKSPACE");
  });

  it("is this profile's own layer for anything else, including nothing", () => {
    // Defaulting the other way would let a missing field edit every profile's base voice at once.
    expect(scopeFrom(form({ scope: "" }))).toBe("BUSINESS_PROFILE");
    expect(scopeFrom(form({ scope: "workspace" }))).toBe("BUSINESS_PROFILE");
    expect(scopeFrom(new FormData())).toBe("BUSINESS_PROFILE");
  });
});
