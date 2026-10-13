/**
 * Reading an acceptance out of a form (#47).
 *
 * What is worth asserting is the shape of the wire format, because the format is what makes the server's
 * enforcement testable at all: an unticked checkbox posts *nothing*, so "which documents were accepted"
 * is the set that arrived — and the separate `offered` field is the only channel through which a client
 * can claim what it rendered.
 */
import { describe, expect, it } from "vitest";

import { acceptedDocumentIdsFrom, field, offeredDocumentIdsFrom } from "./checkout-form";

const form = (entries: readonly [string, string][]): FormData => {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
};

describe("reading the accepted documents", () => {
  it("takes every ticked box, and nothing from the ones that were not", () => {
    // An unticked checkbox contributes no entry at all, which is exactly why the absence is the untick.
    expect(acceptedDocumentIdsFrom(form([["accept", "doc-1"], ["accept", "doc-2"]]))).toEqual(["doc-1", "doc-2"]);
    expect(acceptedDocumentIdsFrom(form([["accept", "doc-1"]]))).toEqual(["doc-1"]);
    expect(acceptedDocumentIdsFrom(new FormData())).toEqual([]);
  });

  it("reads what the page said it rendered from its own field", () => {
    const posted = form([["accept", "doc-1"], ["offered", "doc-1"], ["offered", "doc-2"]]);

    expect(acceptedDocumentIdsFrom(posted)).toEqual(["doc-1"]);
    expect(offeredDocumentIdsFrom(posted)).toEqual(["doc-1", "doc-2"]);
  });

  it("drops a blank, a repeat and anything that is not a string", () => {
    const data = form([["accept", "doc-1"], ["accept", "  "], ["accept", "doc-1"], ["accept", " doc-2 "]]);
    data.append("accept", new Blob(["x"]));

    // A clean set, so a refusal the store reports names something real rather than an empty string.
    expect(acceptedDocumentIdsFrom(data)).toEqual(["doc-1", "doc-2"]);
  });
});

describe("reading one field", () => {
  it("is the empty string for anything that is not a string, never null", () => {
    const data = form([["plan", "pv_1"]]);
    data.append("file", new Blob(["x"]));

    expect(field(data, "plan")).toBe("pv_1");
    expect(field(data, "file")).toBe("");
    expect(field(data, "absent")).toBe("");
  });
});
