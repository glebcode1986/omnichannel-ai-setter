// @vitest-environment jsdom
/**
 * The shell's navigation (Issue #27).
 *
 * The assertions are about what a keyboard and a screen reader get, because that is what the acceptance
 * criteria ask for and it is the part that silently rots. "It looks right" is not in scope here.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentPath = "/workspaces/ws_1/profiles/bp_1/inbox";
vi.mock("next/navigation", () => ({ usePathname: () => currentPath }));

import { ShellFrame } from "./shell-frame";
import { NAV_GROUPS, NAV_SECTIONS } from "./sections";
import { catalogues } from "@/i18n/catalogue";

/** The English section names, as the server would resolve them. */
const navLabels = Object.fromEntries(NAV_SECTIONS.map((section) => [section, catalogues.en[`nav.${section}`]])) as Record<
  (typeof NAV_SECTIONS)[number],
  string
>;
const groupLabels = Object.fromEntries(NAV_GROUPS.map((group) => [group.id, catalogues.en[`navGroup.${group.id}`]])) as Record<
  (typeof NAV_GROUPS)[number]["id"],
  string
>;

/** Everything the frame needs that is not under test in a given case. */
const navProps = {
  labels: navLabels,
  groupLabels,
  toggleLabel: catalogues.en["shell.openNavigation"],
  closeLabel: catalogues.en["shell.closeNavigation"],
  navigationLabel: catalogues.en["shell.navigationLabel"],
  skipLabel: catalogues.en["shell.skipToContent"],
  brand: <span>KeepSayBot</span>,
  account: <span>account</span>,
  crumb: <span>crumb</span>,
  controls: <span />,
  children: <p>page</p>,
};

const BASE = "/workspaces/ws_1/profiles/bp_1";

beforeEach(() => {
  currentPath = `${BASE}/inbox`;
});

afterEach(cleanup);

describe("the documentation link", () => {
  const docsLabel = catalogues.en["nav.documentation"];

  it("is absent until a deployment says where the documentation is", () => {
    // `doc.keepsaybot.online` already resolves to the deployment host and serves nothing: no site and
    // no certificate covering the name, so a link added before the site exists takes a reader to a
    // connection failure. Keeping the item behind the address keeps "there is a link" and "there is a
    // site" the same fact.
    render(<ShellFrame basePath={BASE} {...navProps} docsLabel={docsLabel} />);

    expect(screen.queryByRole("link", { name: new RegExp(docsLabel, "u") })).toBeNull();
    expect(document.querySelector("[data-nav-external]")).toBeNull();
  });

  it("appears once the address is configured, and says it leaves the product", () => {
    render(
      <ShellFrame
        basePath={BASE}
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
      <ShellFrame
        basePath={BASE}
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
  it("keeps appearance and language in the bar, out of the navigation", () => {
    // They used to collapse with the sections, so changing the language on a phone meant opening a menu
    // named "Sections" to find something that is not a section.
    render(
      <ShellFrame
        basePath={BASE}
        {...navProps}
        controls={<button type="button" data-test-control="yes">control</button>}
      />,
    );

    const control = document.querySelector("[data-test-control]");
    expect(control).not.toBeNull();
    expect(control?.closest(".shell-topbar"), "the controls belong to the bar").not.toBeNull();
    expect(control?.closest(".shell-nav"), "and never to the navigation that collapses").toBeNull();
  });

  it("draws the menu button as a menu, and changes the mark when it opens", async () => {
    const user = userEvent.setup();
    render(<ShellFrame basePath={BASE} {...navProps} />);

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
    render(<ShellFrame basePath={BASE} {...navProps} />);

    for (const section of NAV_SECTIONS) {
      expect(screen.getByRole("link", { name: navLabels[section] }).getAttribute("href")).toBe(`${BASE}/${section}`);
    }
  });

  it("marks exactly one link as the current page", () => {
    currentPath = `${BASE}/review`;
    render(<ShellFrame basePath={BASE} {...navProps} />);

    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe(navLabels.review);
  });

  it("keeps the current link marked inside a section's sub-routes", () => {
    currentPath = `${BASE}/inbox/conv_1`;
    // A conversation opened from the inbox is still the inbox. Losing "you are here" one level down is a
    // small break that is very confusing without sight of the page.
    render(<ShellFrame basePath={BASE} {...navProps} />);

    expect(screen.getByRole("link", { name: navLabels.inbox }).getAttribute("aria-current")).toBe("page");
  });

  it("does not mark two links when one section's path prefixes another", () => {
    currentPath = `${BASE}/review`;
    render(<ShellFrame basePath={BASE} {...navProps} />);

    const marked = screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"));
    expect(marked).toHaveLength(1);
  });

  it("opens and closes on the keyboard, and says which it is", async () => {
    const user = userEvent.setup();
    render(<ShellFrame basePath={BASE} {...navProps} />);
    const toggle = screen.getByRole("button", { name: /sections/i });

    // Collapsed by default on a narrow viewport, and the state is announced rather than implied by CSS.
    // The flag now lives on the shell, because the sidebar is what opens: the sections are several
    // lists, one per group, and a disclosure cannot point at several things.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".shell")?.getAttribute("data-nav-open")).toBe("false");

    await user.keyboard("{Tab}");
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".shell")?.getAttribute("data-nav-open")).toBe("true");
  });

  it("points the disclosure at the thing it opens", () => {
    // It opens the sidebar, not one list: the sections are grouped now, so there are several lists and
    // `aria-controls` must name the element that actually appears and disappears.
    render(<ShellFrame basePath={BASE} {...navProps} />);

    const controls = screen.getByRole("button", { name: /sections/i }).getAttribute("aria-controls");
    expect(controls).not.toBeNull();
    expect(screen.getByRole("navigation").id).toBe(controls);
  });

  it("groups the sections under captions rather than listing seven in a row", () => {
    render(<ShellFrame basePath={BASE} {...navProps} />);

    const captions = [...document.querySelectorAll(".nav-group-label")].map((node) => node.textContent);
    expect(captions).toEqual(NAV_GROUPS.map((group) => groupLabels[group.id]));
    // And every section still has exactly one home, so none was lost in the grouping.
    expect(NAV_GROUPS.flatMap((group) => [...group.sections]).toSorted()).toEqual([...NAV_SECTIONS].toSorted());
  });

  it("gives every section a mark beside its name", () => {
    render(<ShellFrame basePath={BASE} {...navProps} />);

    for (const section of NAV_SECTIONS) {
      const link = screen.getByRole("link", { name: navLabels[section] });
      expect(link.querySelector("svg"), `${section} has no mark`).not.toBeNull();
      // The mark repeats the word it sits beside, so it must not be read out as well.
      expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("reaches every section by tabbing, with no mouse-only step", async () => {
    const user = userEvent.setup();
    render(<ShellFrame basePath={BASE} {...navProps} />);

    // Tabbed until the sections have all been reached rather than a fixed number of times: the frame
    // has chrome ahead of them now — the skip link, the menu button, the brand — and a count that
    // happened to match the old markup would fail on the next thing added in front.
    const wanted = new Set(NAV_SECTIONS.map((section) => navLabels[section]));
    const reached: string[] = [];
    for (let step = 0; step < 40 && reached.length < wanted.size; step += 1) {
      await user.tab();
      const focused = document.activeElement;
      const text = focused?.textContent ?? "";
      if (focused?.tagName === "A" && wanted.has(text)) {
        reached.push(text);
      }
    }

    // Every one of them, in the order the product architecture names them, with no mouse-only step.
    expect(reached).toEqual(NAV_SECTIONS.map((section) => navLabels[section]));
  });
});
