/**
 * What a Knowledge form submitted, and what is refused before anything is written (Issue #31).
 *
 * This is the guard Astra's second finding was about. The action parsed `expectedVersion` and, when it
 * could not read one, simply left the property out — and the store checks staleness only when it is
 * present. A form that omitted the field therefore edited whichever version happened to be current and
 * reported success: the stale-tab overwrite the mechanism exists to prevent, reachable by sending one
 * fewer field.
 *
 * A server action is a public endpoint, so the cases below are mostly requests no browser would build.
 * That is the point: the screen's form is one caller among many, and the refusal has to depend on what
 * arrived rather than on who is believed to have sent it.
 */
import { describe, expect, it } from "vitest";

import { expectedVersionOf, factsOf, knowledgeEditOf, knowledgeOutcomeOf } from "./knowledge-submission";

const form = (entries: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    data.set(name, value);
  }
  return data;
};

describe("the expected version", () => {
  it("reads the version the form was rendered against", () => {
    expect(expectedVersionOf(form({ expectedVersion: "2" }))).toBe(2);
    expect(expectedVersionOf(form({ expectedVersion: " 11 " }))).toBe(11);
  });

  it("refuses a submission that does not carry one", () => {
    // The finding exactly: a form with the field missing used to be edited against whatever was current.
    expect(expectedVersionOf(form({ title: "Hours", facts: "We open at 10." }))).toBeUndefined();
    expect(expectedVersionOf(form({ expectedVersion: "" }))).toBeUndefined();
  });

  it("refuses anything that is not entirely a version number", () => {
    // `Number.parseInt` reads 2 out of every one of these. A guard whose answer depends on the shape of
    // the rest of the string is a guard that can be written around.
    for (const value of ["2x", "2 3", "2; DROP TABLE knowledge_documents", "0x2", "2.5", "+2", "١٢"]) {
      expect(expectedVersionOf(form({ expectedVersion: value }))).toBeUndefined();
    }
  });

  it("refuses a version no document can be at", () => {
    for (const value of ["0", "-1", "9007199254740993"]) {
      expect(expectedVersionOf(form({ expectedVersion: value }))).toBeUndefined();
    }
  });

  it("refuses a field that is not text at all", () => {
    const data = new FormData();
    data.set("expectedVersion", new Blob(["2"]), "version.txt");

    // A file upload named like the field. `FormData.get` hands back a `File`, and a guard that coerced it
    // would read "2" out of its name on some runtimes and nothing on others.
    expect(expectedVersionOf(data)).toBeUndefined();
  });
});

describe("an edit", () => {
  it("carries the wording and the version it was composed against", () => {
    expect(knowledgeEditOf(form({ title: "Hours", facts: "We open at 10.\n\nWe close at 18.\n", expectedVersion: "3" }))).toEqual({
      title: "Hours",
      chunks: ["We open at 10.", "We close at 18."],
      expectedVersion: 3,
    });
  });

  it("is not produced at all without a usable version, so there is nothing to apply", () => {
    // The action cannot forget to check: there is no edit object to pass on.
    expect(knowledgeEditOf(form({ title: "Hours", facts: "We open at 10." }))).toBeUndefined();
    expect(knowledgeEditOf(form({ title: "Hours", facts: "We open at 10.", expectedVersion: "latest" }))).toBeUndefined();
  });
});

describe("facts", () => {
  it("is one per line, with blank lines and padding dropped", () => {
    expect(factsOf(form({ facts: "  First fact.  \n\n\nSecond fact.\n  \n" }))).toEqual(["First fact.", "Second fact."]);
  });

  it("is empty when the field is absent, so the store refuses it rather than this", () => {
    // Validation of content belongs to the store, which answers with a sentence an operator can read.
    expect(factsOf(form({}))).toEqual([]);
  });
});

describe("the word the next screen explains", () => {
  it("distinguishes publishing a draft from using an archived source again", () => {
    expect(knowledgeOutcomeOf("RESTORED", "PUBLISHED")).toBe("PUBLISHED");
    expect(knowledgeOutcomeOf("RESTORED")).toBe("RESTORED");
  });

  it("carries a refusal through as itself", () => {
    expect(knowledgeOutcomeOf("CONFLICT")).toBe("CONFLICT");
    expect(knowledgeOutcomeOf("GONE")).toBe("GONE");
    expect(knowledgeOutcomeOf("REJECTED")).toBe("REJECTED");
    expect(knowledgeOutcomeOf("STALE")).toBe("REJECTED");
  });

  it("never turns an unrecognised store outcome into a success", () => {
    // A status added to the store later should arrive as something to look at, not as a quiet
    // "published" for a write that may not have happened.
    expect(knowledgeOutcomeOf("SOMETHING_ADDED_LATER", "PUBLISHED")).toBe("REJECTED");
  });
});
