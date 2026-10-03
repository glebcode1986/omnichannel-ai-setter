// @vitest-environment jsdom
/**
 * The shell's navigation (Issue #27).
 *
 * The assertions are about what a keyboard and a screen reader get, because that is what the acceptance
 * criteria ask for and it is the part that silently rots. "It looks right" is not in scope here.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { Navigation } from "./navigation";
import { NAV_SECTIONS } from "./sections";
import { catalogues } from "@/i18n/catalogue";

/** The English section names, as the server would resolve them. */
const navLabels = Object.fromEntries(NAV_SECTIONS.map((section) => [section, catalogues.en[`nav.${section}`]])) as Record<
  (typeof NAV_SECTIONS)[number],
  string
>;
const navProps = { labels: navLabels, toggleLabel: catalogues.en["shell.openNavigation"], navigationLabel: catalogues.en["shell.navigationLabel"] };

const BASE = "/workspaces/ws_1/profiles/bp_1";

afterEach(cleanup);

describe("workspace navigation", () => {
  it("offers every section the product architecture names", () => {
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox`} {...navProps} />);

    for (const section of NAV_SECTIONS) {
      expect(screen.getByRole("link", { name: navLabels[section] }).getAttribute("href")).toBe(`${BASE}/${section}`);
    }
  });

  it("marks exactly one link as the current page", () => {
    render(<Navigation basePath={BASE} currentPath={`${BASE}/review`} {...navProps} />);

    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe(navLabels.review);
  });

  it("keeps the current link marked inside a section's sub-routes", () => {
    // A conversation opened from the inbox is still the inbox. Losing "you are here" one level down is a
    // small break that is very confusing without sight of the page.
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox/conversation-7`} {...navProps} />);

    expect(screen.getByRole("link", { name: navLabels.inbox }).getAttribute("aria-current")).toBe("page");
  });

  it("does not mark two links when one section's path prefixes another", () => {
    render(<Navigation basePath={BASE} currentPath={`${BASE}/settings`} {...navProps} />);

    const marked = screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"));
    expect(marked).toHaveLength(1);
  });

  it("opens and closes on the keyboard, and says which it is", async () => {
    const user = userEvent.setup();
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox`} {...navProps} />);
    const toggle = screen.getByRole("button", { name: /sections/i });

    // Collapsed by default on a narrow viewport, and the state is announced rather than implied by CSS.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("list").getAttribute("data-collapsed")).toBe("true");

    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list").getAttribute("data-collapsed")).toBe("false");
  });

  it("points the disclosure at the list it controls", () => {
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox`} {...navProps} />);

    const controls = screen.getByRole("button", { name: /sections/i }).getAttribute("aria-controls");
    expect(controls).not.toBeNull();
    expect(screen.getByRole("list").id).toBe(controls);
  });

  it("reaches every section by tabbing, with no mouse-only step", async () => {
    const user = userEvent.setup();
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox`} {...navProps} />);

    await user.tab();
    const reached: string[] = [];
    for (let index = 0; index < NAV_SECTIONS.length; index += 1) {
      await user.tab();
      const focused = document.activeElement;
      if (focused !== null && focused.tagName === "A") {
        reached.push(focused.textContent ?? "");
      }
    }

    expect(reached).toEqual(NAV_SECTIONS.map((section) => navLabels[section]));
  });
});
