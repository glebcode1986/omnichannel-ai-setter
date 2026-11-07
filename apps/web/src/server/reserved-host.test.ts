/**
 * The reserved-hostname predicate.
 *
 * Both directions matter and the second one matters more: a predicate that refuses too much would take a
 * channel away from a deployment that can connect it perfectly well. So the names it must *accept* are
 * tested as deliberately as the names it must refuse, and the local-development forms are named one by
 * one, because those are the ones a reader expects to see refused.
 */
import { describe, expect, it } from "vitest";

import { isReservedHostname } from "./reserved-host";

describe("names nobody can own", () => {
  it.each([
    ["invalid", "the TLD itself"],
    ["staging.invalid", "a placeholder a deployment actually carries"],
    ["a.b.c.invalid", "however deeply nested"],
    ["STAGING.INVALID", "whatever the case (RFC 4343)"],
    ["staging.invalid.", "with the root dot a fully qualified name may carry"],
    ["example", "the documentation TLD"],
    ["app.example", "and anything under it"],
    ["example.com", "the documentation second-level names"],
    ["example.net", "all three of them"],
    ["example.org", "all three"],
    ["callback.example.org", "and their subdomains"],
  ])("refuses %s — %s", (hostname) => {
    expect(isReservedHostname(hostname)).toBe(true);
  });
});

describe("names a callback can actually reach", () => {
  it.each([
    ["localhost", "the operator's browser follows the redirect, so this works"],
    ["app.localhost", "and so does a label under it"],
    ["127.0.0.1", "loopback by address"],
    ["myapp.test", "a developer's own resolver or /etc/hosts"],
    ["dev.keepsaybot.online", "this product's development host"],
    ["keepsaybot.online", "and its production one"],
    ["examples.com", "a real name that merely starts the same way"],
    ["example.company", "and one whose TLD merely starts the same way"],
    ["notexample.com", "a real name ending in the reserved one's second label"],
    ["invalidation.com", "a real name beginning with the reserved TLD's spelling"],
    ["com", "a bare TLD is not one of the reserved second-level names"],
  ])("accepts %s — %s", (hostname) => {
    expect(isReservedHostname(hostname)).toBe(false);
  });
});

describe("the empty case", () => {
  it("accepts an empty hostname rather than claiming it is reserved", () => {
    // A URL cannot have one, so this is unreachable through the caller; it is asserted so the `slice(-2)`
    // and the last-label read cannot throw or report a reservation for a name that does not exist.
    expect(isReservedHostname("")).toBe(false);
  });
});
