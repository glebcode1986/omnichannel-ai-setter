// @vitest-environment jsdom
/**
 * Writing a fact down (Issue #31).
 *
 * The case this exists for is the hidden version. An edit form that does not say which version it was
 * rendered against is an edit the server has to apply to whatever is current — so two tabs opened on the
 * same source both save, and the second one silently replaces the first with wording composed against
 * content it never saw. The field is the only thing that makes the refusal possible, and it is invisible,
 * which is exactly the kind of thing that disappears in a refactor with nothing on screen to show it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgeEditor } from "./knowledge-editor";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const editor = (document?: { id: string; title: string; facts: readonly string[]; scope: string; version: number }) =>
  render(<KnowledgeEditor t={t} target={TARGET} action={vi.fn(() => Promise.resolve())} {...(document === undefined ? {} : { document })} />);

const source = { id: "kd_1", title: "Opening hours", facts: ["We open at 10.", "We close at 18."], scope: "BUSINESS_PROFILE", version: 4 };

describe("editing an existing source", () => {
  it("submits the version the form was rendered against", () => {
    editor(source);

    expect(document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value).toBe("4");
  });

  it("shows the wording that is saved now, one fact per line", () => {
    editor(source);

    expect(screen.getByLabelText(text("knowledge.titleLabel")).getAttribute("value")).toBe("Opening hours");
    expect(screen.getByLabelText(text("knowledge.factsLabel")).textContent).toBe("We open at 10.\nWe close at 18.");
  });

  it("does not offer to move it between profiles", () => {
    editor(source);

    // Changing scope changes who a fact answers for. Doing that through an edit form would be a silent
    // migration of somebody else's knowledge.
    expect(document.querySelector('[name="scope"]')).toBeNull();
    expect(screen.getByRole("button", { name: text("knowledge.save") })).toBeDefined();
  });
});

describe("writing a new source", () => {
  it("carries no expected version, because there is nothing yet to be stale against", () => {
    editor();

    expect(document.querySelector('input[name="expectedVersion"]')).toBeNull();
  });

  it("asks who it applies to, and saves as a draft", () => {
    editor();

    expect(document.querySelector('[name="scope"]')).not.toBeNull();
    // A draft, not a live change: nothing typed into this form answers a customer until somebody
    // publishes it.
    expect(screen.getByRole("button", { name: text("knowledge.create") })).toBeDefined();
  });
});
