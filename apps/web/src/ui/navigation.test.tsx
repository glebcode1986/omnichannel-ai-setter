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

describe("the documentation link", () => {
  const docsLabel = catalogues.en["nav.documentation"];

  it("is absent until a deployment says where the documentation is", () => {
    // `doc.keepsaybot.online` already resolves to the deployment host and serves nothing: no site and
    // no certificate covering the name, so a link added before the site exists takes a reader to a
    // connection failure. Keeping the item behind the address keeps "there is a link" and "there is a
    // site" the same fact.
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox`} {...navProps} docsLabel={docsLabel} />);

    expect(screen.queryByRole("link", { name: new RegExp(docsLabel, "u") })).toBeNull();
    expect(document.querySelector("[data-nav-external]")).toBeNull();
  });

  it("appears once the address is configured, and says it leaves the product", () => {
    render(
      <Navigation
        basePath={BASE}
        currentPath={`${BASE}/inbox`}
        {...navProps}
        docsUrl="https://doc.keepsaybot.online"
        docsLabel={docsLabel}
        externalHint={catalogues.en["shell.externalLink"]}
      />,
    );

    const link = screen.getByRole("link", { name: new RegExp(docsLabel, "u") });
    expect(link.getAttribute("href")).toBe("https://doc.keepsaybot.online");
    expect(link.getAttribute("target")).toBe("_blank");
    // `noopener` alone would still hand the new tab a referrer it has no need for.
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.textContent).toContain(catalogues.en["shell.externalLink"]);
  });

  it("is not marked as the current page by a section route", () => {
    // It is not a section, and exactly one link may carry `aria-current`.
    render(
      <Navigation
        basePath={BASE}
        currentPath={`${BASE}/inbox`}
        {...navProps}
        docsUrl="https://doc.keepsaybot.online"
        docsLabel={docsLabel}
      />,
    );

    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(1);
    expect(document.querySelector("[data-nav-external]")?.getAttribute("aria-current")).toBeNull();
  });
});

describe("the shell bar", () => {
  it("keeps appearance and language out of the collapsing list", () => {
    // They used to collapse with the sections, so changing the language on a phone meant opening a menu
    // named "Sections" to find something that is not a section.
    render(
      <Navigation
        basePath={BASE}
        currentPath={`${BASE}/inbox`}
        {...navProps}
        controls={<button type="button" data-test-control="yes">control</button>}
      />,
    );

    const control = document.querySelector("[data-test-control]");
    expect(control).not.toBeNull();
    expect(control?.closest(".nav-bar"), "the controls belong to the bar").not.toBeNull();
    expect(control?.closest(".nav-list"), "and never to the list that collapses").toBeNull();
  });

  it("draws the menu button as a menu, and changes the mark when it opens", async () => {
    const user = userEvent.setup();
    render(<Navigation basePath={BASE} currentPath={`${BASE}/inbox`} {...navProps} />);

    const toggle = screen.getByRole("button", { name: new RegExp(catalogues.en["shell.openNavigation"], "u") });
    const closedMark = toggle.querySelector("svg")?.innerHTML ?? "";
    expect(closedMark, "a button with no mark is the field it used to look like").not.toBe("");

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector("svg")?.innerHTML, "the mark must change with the state").not.toBe(closedMark);
  });
});

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
