/**
 * Filling an approved template (Issue #20).
 *
 * Every case here is a message a customer would read. A shuffled positional set renders the appointment
 * time where the name belongs; a missing named value renders a gap; a count that does not match is refused
 * by the provider after the customer was already promised a reply.
 */
import { describe, expect, it } from "vitest";

import {
  isPositionalParameterName,
  templateParameterFormatOf,
  templateVariablesProblem,
  type ApprovedTemplateShape,
} from "./message-template";

const positional: ApprovedTemplateShape = {
  name: "appointment_reminder",
  languageCode: "en_US",
  format: "POSITIONAL",
  parameters: ["1", "2"],
};

const named: ApprovedTemplateShape = {
  name: "order_confirmation",
  languageCode: "en_US",
  format: "NAMED",
  parameters: ["first_name", "order_number"],
};

describe("a positional template", () => {
  it("accepts values in the order the placeholders appear", () => {
    expect(
      templateVariablesProblem(positional, [
        { name: "1", value: "Jess" },
        { name: "2", value: "10:00" },
      ]),
    ).toBeUndefined();
  });

  it("refuses a shuffled set, even though it matches", () => {
    expect(
      templateVariablesProblem(positional, [
        { name: "2", value: "10:00" },
        { name: "1", value: "Jess" },
      ]),
    ).toEqual({ kind: "OUT_OF_ORDER", name: "2" });
  });

  it("refuses too few and too many", () => {
    expect(templateVariablesProblem(positional, [{ name: "1", value: "Jess" }])).toEqual({ kind: "COUNT_MISMATCH", expected: 2, supplied: 1 });
    expect(
      templateVariablesProblem(positional, [
        { name: "1", value: "a" },
        { name: "2", value: "b" },
        { name: "3", value: "c" },
      ]),
    ).toEqual({ kind: "COUNT_MISMATCH", expected: 2, supplied: 3 });
  });
});

describe("a named template", () => {
  it("accepts values in any order", () => {
    expect(
      templateVariablesProblem(named, [
        { name: "order_number", value: "SKBUP2" },
        { name: "first_name", value: "Jess" },
      ]),
    ).toBeUndefined();
  });

  it("refuses a value the template does not have", () => {
    expect(
      templateVariablesProblem(named, [
        { name: "first_name", value: "Jess" },
        { name: "surname", value: "Smith" },
      ]),
    ).toEqual({ kind: "UNKNOWN_PARAMETER", name: "surname" });
  });

  it("refuses one value sent twice in place of the one that is missing", () => {
    expect(
      templateVariablesProblem(named, [
        { name: "first_name", value: "Jess" },
        { name: "first_name", value: "Jess" },
      ]),
    ).toEqual({ kind: "MISSING_PARAMETER", name: "order_number" });
  });
});

describe("any template", () => {
  it("refuses an empty value before anything else, because it renders as a gap", () => {
    // "your order  is ready" is the failure this prevents, and the provider may well accept it.
    expect(
      templateVariablesProblem(positional, [
        { name: "1", value: "Jess" },
        { name: "2", value: "   " },
      ]),
    ).toEqual({ kind: "EMPTY_VALUE", name: "2" });
  });

  it("accepts a template with no placeholders and no values", () => {
    const fixed: ApprovedTemplateShape = { name: "closed_today", languageCode: "en_US", format: "POSITIONAL", parameters: [] };

    expect(templateVariablesProblem(fixed, [])).toBeUndefined();
    expect(templateVariablesProblem(fixed, [{ name: "1", value: "x" }])).toEqual({ kind: "COUNT_MISMATCH", expected: 0, supplied: 1 });
  });
});

describe("how values are serialized", () => {
  it("calls all-numeric names positional and anything else named", () => {
    expect(templateParameterFormatOf([{ name: "1", value: "a" }, { name: "2", value: "b" }])).toBe("POSITIONAL");
    expect(templateParameterFormatOf([{ name: "first_name", value: "a" }])).toBe("NAMED");
    // Mixed cannot be positional: one of them is not a position.
    expect(templateParameterFormatOf([{ name: "1", value: "a" }, { name: "first_name", value: "b" }])).toBe("NAMED");
  });

  it("calls an empty list named, which serializes to no parameters either way", () => {
    expect(templateParameterFormatOf([])).toBe("NAMED");
  });

  it("does not read a leading zero or a sign as a position", () => {
    // A name that merely looks numeric is not a position, and treating it as one would serialize a named
    // template's values without their names.
    for (const name of ["0", "01", "+1", "1.0", "1 ", ""]) {
      expect(isPositionalParameterName(name)).toBe(false);
    }
    expect(isPositionalParameterName("1")).toBe(true);
    expect(isPositionalParameterName("10")).toBe(true);
  });
});
