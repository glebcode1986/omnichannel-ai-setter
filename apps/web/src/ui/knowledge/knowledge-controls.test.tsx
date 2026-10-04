// @vitest-environment jsdom
/**
 * The lifecycle controls for one knowledge source (Issue #31).
 *
 * Astra's first finding lives here. The page offered Archive to every ACTIVE document and Publish only to
 * DRAFTs, so a live source someone had edited rendered the "saved v2, customers are answered with v1"
 * warning above a row whose only button was Archive — the store could publish v2 and an operator had no
 * way to ask it to. The property under test is reachability: whenever a version is not the published one,
 * there is a control that publishes it.
 *
 * Her third finding lives here too, as the hidden field. A button that posts "publish this document"
 * publishes whatever is current when it arrives; the version the operator was reading has to travel with
 * the click, or the server has nothing to refuse a stale tab with.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgeControls } from "./knowledge-controls";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const actions = () => ({
  publish: vi.fn(() => Promise.resolve()),
  restore: vi.fn(() => Promise.resolve()),
  archive: vi.fn(() => Promise.resolve()),
});

const controls = (document: { status: string; version: number; publishedVersion: number | null }) =>
  render(<KnowledgeControls t={t} target={TARGET} documentId="kd_1" document={document} actions={actions()} />);

const button = (action: string) => document.querySelector(`[data-action="${action}"]`);

describe("a draft", () => {
  it("can be published", () => {
    controls({ status: "DRAFT", version: 1, publishedVersion: null });

    expect(screen.getByRole("button", { name: text("knowledge.publish") })).toBeDefined();
    expect(button("archive")).toBeNull();
  });
});

describe("a live source somebody has edited", () => {
  it("can publish the version that is staged", () => {
    // The finding. This used to render Archive and nothing else, under a warning saying customers were
    // still being answered with v1.
    controls({ status: "ACTIVE", version: 2, publishedVersion: 1 });

    const publish = button("publish");
    expect(publish).not.toBeNull();
    expect(publish?.textContent).toBe("Answer with version 2");
    // Archive stays: stopping a live source is still something its operator may want.
    expect(button("archive")).not.toBeNull();
  });

  it("names the version in the button, because the source is already answerable", () => {
    controls({ status: "ACTIVE", version: 5, publishedVersion: 3 });

    // "Make it answerable" would be a false statement about a document that already answers customers.
    expect(button("publish")?.textContent).not.toBe(text("knowledge.publish"));
    expect(button("publish")?.textContent).toContain("5");
  });
});

describe("a live source nobody has edited", () => {
  it("offers no publish, because there is nothing to publish", () => {
    controls({ status: "ACTIVE", version: 2, publishedVersion: 2 });

    expect(button("publish")).toBeNull();
    expect(button("restore")).toBeNull();
    expect(button("archive")).not.toBeNull();
  });
});

describe("an archived source", () => {
  it("offers to use it again, whether or not it has a staged version", () => {
    controls({ status: "ARCHIVED", version: 3, publishedVersion: 1 });

    const restore = button("restore");
    expect(restore?.textContent).toBe(text("knowledge.restore"));
    // One control, not two: "publish" and "use it again" are the same write, and offering both would ask
    // an operator to choose between two buttons that do the same thing.
    expect(button("publish")).toBeNull();
    expect(button("archive")).toBeNull();
  });
});

describe("every control that decides about a version", () => {
  it("submits the version it was rendered against", () => {
    for (const state of [
      { status: "DRAFT", version: 1, publishedVersion: null },
      { status: "ACTIVE", version: 4, publishedVersion: 2 },
      { status: "ARCHIVED", version: 7, publishedVersion: 7 },
    ]) {
      cleanup();
      controls(state);

      const hidden = document.querySelector<HTMLInputElement>('input[name="expectedVersion"]');
      // Without this the server cannot tell a decision about v4 from a decision about whatever v4 became
      // while the page was open, and a stale tab's click publishes content it never showed.
      expect(hidden?.value).toBe(String(state.version));
    }
  });

  it("leaves Archive without one, because it is not a decision about a version", () => {
    cleanup();
    controls({ status: "ACTIVE", version: 2, publishedVersion: 2 });

    // Archiving removes the source from retrieval whatever its current wording is, so there is no newer
    // version it could be deciding about by mistake — and refusing it on staleness would strand the one
    // control that stops a source answering customers.
    expect(document.querySelector('input[name="expectedVersion"]')).toBeNull();
    expect(button("archive")).not.toBeNull();
  });
});
