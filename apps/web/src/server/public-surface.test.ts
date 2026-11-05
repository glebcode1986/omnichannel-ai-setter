/**
 * The two values the public surface reads out of cookies, and where its forms may send a reader.
 *
 * Both are attacker-settable — a cookie is, and a form field is — so both are narrowed on the way in,
 * and the cases worth writing are the hostile ones plus the one that is easy to model wrongly: a theme
 * nobody has chosen is not light, it is *absent*, and the difference is whether the page follows the
 * reader's machine or overrides it.
 */
import { describe, expect, it } from "vitest";

import { isPublicPath, publicPathOf, PUBLIC_PATHS } from "./public-paths";
import { isPublicTheme, publicThemeOf, PUBLIC_THEMES } from "./public-theme";

describe("the stored colour scheme", () => {
  it("reads back the two it can store", () => {
    expect(publicThemeOf("light")).toBe("light");
    expect(publicThemeOf("dark")).toBe("dark");
    expect(PUBLIC_THEMES).toEqual(["light", "dark"]);
  });

  it("treats no cookie as no choice, not as light", () => {
    // The distinction the whole control rests on: with no choice the document carries no `data-theme`
    // and the stylesheet's `prefers-color-scheme` query decides. Defaulting to `light` here would pin
    // every first-time reader on a dark machine to a white page.
    expect(publicThemeOf(undefined)).toBeUndefined();
    expect(publicThemeOf(null)).toBeUndefined();
    expect(publicThemeOf("")).toBeUndefined();
  });

  it("refuses anything else rather than passing it into an attribute", () => {
    for (const hostile of ["Light", "DARK", "light;dark", '"><script>', "auto", "system"]) {
      expect(publicThemeOf(hostile), hostile).toBeUndefined();
      expect(isPublicTheme(hostile), hostile).toBe(false);
    }
  });
});

describe("where a preference form may return a reader", () => {
  it("returns them to any of the public pages", () => {
    for (const page of PUBLIC_PATHS) {
      expect(publicPathOf(page)).toBe(page);
      expect(isPublicPath(page)).toBe(true);
    }
    // And the list is the public surface, not an accident of one page.
    expect([...PUBLIC_PATHS].toSorted()).toEqual(["/", "/privacy", "/sign-in", "/terms"]);
  });

  it("sends an off-site or unknown target to the landing page instead of following it", () => {
    // An unchecked redirect target is an open redirect, and a preference form is as good a carrier for
    // one as a login form. None of these may survive.
    for (const hostile of [
      "https://example.invalid/",
      "//example.invalid/",
      "/sign-in/../../etc",
      "/inbox",
      "javascript:alert(1)",
      "",
      undefined,
    ]) {
      expect(publicPathOf(hostile), String(hostile)).toBe("/");
    }
  });

  it("does not offer a signed-in route as a public destination", () => {
    // These pages are reachable with no session; `/inbox` is not, and a language form that redirected
    // there would bounce an anonymous reader into an authentication wall for choosing Russian.
    expect(isPublicPath("/inbox")).toBe(false);
    expect(isPublicPath("/settings")).toBe(false);
  });
});
