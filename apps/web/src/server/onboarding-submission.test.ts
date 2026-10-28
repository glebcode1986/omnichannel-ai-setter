/**
 * The front door's decisions, on submissions no browser built (#115).
 *
 * `@omnichannel/db` is imported for real here rather than mocked, deliberately: the thing most worth
 * proving about this module is that its name limit **is** the store's, and a mocked constant would prove
 * only that the test agrees with itself.
 */
import { DbInputError, NAME_MAX_LENGTH, PlanLimitError, WorkspacePermissionError } from "@omnichannel/db";
import { describe, expect, it } from "vitest";

import { nameOf, refusalOutcome } from "./onboarding-submission";

const form = (entries: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
};

describe("a name a front-door form submitted", () => {
  it("is taken as typed, minus the whitespace around it", () => {
    expect(nameOf(form({ name: "  Acme Studio  " }))).toEqual({ kind: "NAMED", name: "Acme Studio" });
  });

  it("is refused when the submission does not name anything", () => {
    // A missing field, an empty one and one made of whitespace are the same answer. The third is the one
    // that matters: `required` on the input does not stop a constructed request, and without the trim a
    // workspace called " " would have been created and listed as a blank card nobody can identify.
    for (const data of [form({}), form({ name: "" }), form({ name: "   \t\n " })]) {
      expect(nameOf(data)).toEqual({ kind: "REFUSED", outcome: "NAME_REQUIRED" });
    }
  });

  it("is refused above the length the store itself enforces, and accepted at it", () => {
    expect(nameOf(form({ name: "a".repeat(NAME_MAX_LENGTH) }))).toEqual({ kind: "NAMED", name: "a".repeat(NAME_MAX_LENGTH) });
    expect(nameOf(form({ name: "a".repeat(NAME_MAX_LENGTH + 1) }))).toEqual({ kind: "REFUSED", outcome: "NAME_TOO_LONG" });
  });

  it("measures the trimmed name, not the padded field", () => {
    // Padding a maximal name used to fail here while the store accepted it, which is a screen refusing
    // what the database would have taken — the kind of refusal nobody can get past by editing the field.
    expect(nameOf(form({ name: `  ${"a".repeat(NAME_MAX_LENGTH)}  ` }))).toMatchObject({ kind: "NAMED" });
  });

  it("reads a field that is not a string as absent", () => {
    // `FormData.get` can return a `File`, and `String(file)` is "[object Object]" — a name the store would
    // then accept for the wrong reason.
    const data = new FormData();
    data.set("name", new File(["x"], "name.txt"));

    expect(nameOf(data)).toEqual({ kind: "REFUSED", outcome: "NAME_REQUIRED" });
  });

  it("reads the field it is told to", () => {
    expect(nameOf(form({ other: "Acme" }), "other")).toEqual({ kind: "NAMED", name: "Acme" });
  });
});

describe("a refusal the store raised", () => {
  it("maps a reached profile ceiling to its own sentence", () => {
    const error = new PlanLimitError({ kind: "AT_LIMIT", limit: "BUSINESS_PROFILES", ceiling: 1, current: 1 }, "creating a Business Profile");

    expect(refusalOutcome(error, "Second")).toBe("PROFILE_LIMIT_REACHED");
  });

  it("maps a role refusal to a refusal the page can render", () => {
    expect(refusalOutcome(new WorkspacePermissionError("creating Business Profiles"), "Second")).toBe("FORBIDDEN");
  });

  it("maps the store's own name rule by length rather than by its message", () => {
    // Defence in depth: the forms validate first, and this is what happens when a constructed request
    // gets past them. By length, because the error's message is prose and this is a branch.
    expect(refusalOutcome(new DbInputError("name", `must be 1-${NAME_MAX_LENGTH} characters`), "")).toBe("NAME_REQUIRED");
    expect(refusalOutcome(new DbInputError("name", `must be 1-${NAME_MAX_LENGTH} characters`), "a".repeat(NAME_MAX_LENGTH + 1))).toBe(
      "NAME_TOO_LONG",
    );
  });

  it("does not claim an input error about some other field", () => {
    expect(refusalOutcome(new DbInputError("ownerUserId", "must be a valid identifier"), "Acme")).toBeUndefined();
  });

  it("leaves an error nobody wrote a sentence for to the error boundary", () => {
    // Flattening an unknown fault into a rendered outcome is how a real failure becomes a sentence
    // somebody reads and ignores, with nothing in a log.
    expect(refusalOutcome(new Error("the database is on fire"), "Acme")).toBeUndefined();
    expect(refusalOutcome("not even an error", "Acme")).toBeUndefined();
  });
});
