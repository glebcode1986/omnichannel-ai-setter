// @vitest-environment jsdom
/**
 * One pane at a time on a phone (Issue #28).
 *
 * The pane switch is a CSS media query keyed on a `data-pane` attribute the route sets, which means it is
 * a contract spread across three files: the stylesheet names the classes, the components render them, and
 * the two routes declare which pane they are. Nothing type-checks that, and the way it breaks is silent —
 * a renamed class leaves a phone showing both panes stacked, or neither.
 *
 * So this holds the three sides against each other. It is deliberately not a claim that the layout looks
 * right: jsdom does not evaluate media queries, and a test that pretended otherwise would be worse than
 * none. What it proves is that the rules still exist and still name what the components render.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxRow } from "@omnichannel/db";

import { ConversationList } from "./conversation-list";
import { createTranslator } from "@/i18n/translate";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const css = readFileSync(path.join(srcRoot, "app/globals.css"), "utf8");
const routes = path.join(srcRoot, "app/workspaces/[workspaceId]/profiles/[businessProfileId]/inbox");
const listRoute = readFileSync(path.join(routes, "page.tsx"), "utf8");
const threadRoute = readFileSync(path.join(routes, "[conversationId]/page.tsx"), "utf8");

afterEach(cleanup);

/** The narrow-screen block, so an assertion cannot pass by matching a desktop rule of the same shape. */
function narrowScreenRules(): string {
  const start = css.indexOf("@media (max-width: 900px)");
  expect(start, "the narrow-screen block is what makes the Inbox usable on a phone").toBeGreaterThan(-1);
  return css.slice(start);
}

describe("the narrow-screen layout", () => {
  it("collapses the three columns into one", () => {
    expect(narrowScreenRules()).toMatch(/\.inbox\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  });

  it("hides the list while a conversation is open, and the placeholder while it is not", () => {
    const rules = narrowScreenRules();

    // Anchored at a selector boundary: `toContain(".inbox-list")` also matches `.inbox-listing`, so a
    // renamed class would slip through a substring check — which is exactly how this test first passed
    // against a mutation that broke the layout.
    expect(rules).toMatch(/\.inbox\[data-pane="thread"\] \.inbox-list(?![\w-])/u);
    expect(rules).toMatch(/\.inbox\[data-pane="list"\] \.inbox-thread-empty(?![\w-])/u);
    expect(rules).toMatch(/\.inbox\[data-pane="list"\] \.inbox-thread-empty \{\s*display: none;/u);
  });

  it("shows the back link only where the list is off screen", () => {
    // On a desktop the list is right there, so a "back to conversations" link would be noise.
    expect(css).toMatch(/\.inbox-back \{\s*display: none;/u);
    expect(narrowScreenRules()).toMatch(/\.inbox-back \{\s*display: inline-block;/u);
  });

  it("lets the page scroll as a whole, rather than three panes scrolling inside a phone screen", () => {
    expect(narrowScreenRules()).toMatch(/\.inbox\s*\{[^}]*max-height:\s*none/u);
  });
});

describe("the classes the media query names", () => {
  it("are the ones the list pane actually renders", () => {
    const row: InboxRow = {
      id: "cv_1",
      channelAccountId: "ca_ig",
      channel: "INSTAGRAM",
      contactName: "Ann Petrova",
      handle: "@ann",
      status: "OPEN",
      leadStage: "NEW",
      takeoverState: "NONE",
      takeoverReviewMode: null,
      modeOverride: "DRAFT",
  effectiveMode: "DRAFT",
      aiEnabled: true,
      lastMessageAt: new Date("2026-09-30T10:00:00.000Z"),
      awaitingReply: false,
      preview: "hello",
    };
    render(<ConversationList t={createTranslator("en")} rows={[row]} view={{}} basePath="/inbox" />);

    expect(document.querySelector(".inbox-list")).not.toBeNull();
  });

  it("are declared by the routes, one pane each", () => {
    // A source-level check on purpose: the attribute is what selects a pane, and no other test in the
    // repository would notice if a route stopped setting it or both routes claimed the same pane.
    expect(listRoute).toContain('data-pane="list"');
    expect(threadRoute).toContain('data-pane="thread"');
    expect(listRoute).not.toContain('data-pane="thread"');
    expect(threadRoute).not.toContain('data-pane="list"');
  });

  it("include a back link on the thread route, pointing at the list with its filters kept", () => {
    expect(threadRoute).toContain("inboxQueryString(screen.view)");
    expect(threadRoute).toContain('data-inbox-back="true"');
  });
});
