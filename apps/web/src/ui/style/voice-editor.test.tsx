// @vitest-environment jsdom
/**
 * One layer of the voice (Issue #32).
 *
 * The case that matters is the empty field. In the Business Profile override an empty box means "use the
 * base voice", not "say nothing" — and the two are opposite instructions. The form has to say which, or
 * somebody clears a greeting expecting to inherit one and instead deletes it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleProfileLayerView } from "@omnichannel/db";

import { VoiceEditor } from "./voice-editor";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const layer = (overrides: Partial<StyleProfileLayerView> = {}): StyleProfileLayerView => ({
  scope: "WORKSPACE",
  exists: true,
  persona: "A calm neighbourhood salon",
  tone: "warm",
  replyLength: "SHORT",
  emoji: "SPARING",
  greeting: "Hi!",
  signOff: "See you soon",
  preferredPhrases: ["happy to help", "of course"],
  avoidedPhrases: ["cheap"],
  language: "en",
  updatedAt: new Date("2026-09-30T10:00:00.000Z"),
  ...overrides,
});

const editor = (overrides: Partial<StyleProfileLayerView> = {}) =>
  render(<VoiceEditor t={t} layer={layer(overrides)} target={TARGET} action={vi.fn(() => Promise.resolve())} />);

describe("reading a written layer back", () => {
  it("fills every field from what was stored", () => {
    editor();

    expect(screen.getByLabelText(text("style.persona"))).toHaveProperty("value", "A calm neighbourhood salon");
    expect(screen.getByLabelText(text("style.replyLength"))).toHaveProperty("value", "SHORT");
    expect(screen.getByLabelText(text("style.emoji"))).toHaveProperty("value", "SPARING");
    expect(screen.getByLabelText(text("style.signOff"))).toHaveProperty("value", "See you soon");
  });

  it("puts one phrase per line, the way it will be read back", () => {
    editor();

    expect(screen.getByLabelText(text("style.preferred"))).toHaveProperty("value", "happy to help\nof course");
  });

  it("carries which layer it is, so a save cannot land on the other one", () => {
    editor({ scope: "BUSINESS_PROFILE" });

    expect(document.querySelector('input[name="scope"]')?.getAttribute("value")).toBe("BUSINESS_PROFILE");
  });
});

describe("an empty field", () => {
  it("is empty rather than showing a placeholder value", () => {
    editor({ persona: null, replyLength: null, emoji: null, preferredPhrases: [] });

    expect(screen.getByLabelText(text("style.persona"))).toHaveProperty("value", "");
    expect(screen.getByLabelText(text("style.replyLength"))).toHaveProperty("value", "");
    expect(screen.getByLabelText(text("style.preferred"))).toHaveProperty("value", "");
  });

  it("says, in the override, that empty means inherit", () => {
    // Otherwise somebody clears a greeting expecting to inherit one, and deletes it instead.
    editor({ scope: "BUSINESS_PROFILE" });

    expect(screen.getByText(text("style.inherits"))).toBeDefined();
  });

  it("does not claim inheritance in the base layer, which has nothing beneath it", () => {
    editor({ scope: "WORKSPACE" });

    expect(screen.queryByText(text("style.inherits"))).toBeNull();
    // The selects still offer "no preference", which is a value rather than a claim about inheriting.
    expect(screen.getAllByText(text("style.noOpinion")).length).toBe(2);
  });
});

describe("a layer nobody has written", () => {
  it("says so, rather than looking like an empty voice somebody chose", () => {
    editor({ exists: false, persona: null, tone: null });

    expect(screen.getByText(text("style.layerUnwritten"))).toBeDefined();
    expect(document.querySelector('[data-unwritten="true"]')).not.toBeNull();
  });

  it("says nothing about being unwritten once it exists", () => {
    editor({ exists: true });

    expect(document.querySelector("[data-unwritten]")).toBeNull();
  });
});

describe("the vocabularies it offers", () => {
  it("offers the reply lengths and emoji settings the domain defines, plus no opinion", () => {
    editor();

    const lengths = [...screen.getByLabelText(text("style.replyLength")).querySelectorAll("option")].map((option) => option.value);
    const emoji = [...screen.getByLabelText(text("style.emoji")).querySelectorAll("option")].map((option) => option.value);

    expect(lengths).toEqual(["", "SHORT", "MEDIUM", "LONG"]);
    expect(emoji).toEqual(["", "NONE", "SPARING", "FREELY"]);
  });

  it("labels the language field and says what leaving it empty means", () => {
    editor();

    expect(screen.getByLabelText(text("style.language"))).toHaveProperty("value", "en");
    expect(screen.getByText(text("style.languageHint"))).toBeDefined();
  });

  it("reads in Russian", () => {
    render(<VoiceEditor t={createTranslator("ru")} layer={layer({ scope: "BUSINESS_PROFILE" })} target={TARGET} action={vi.fn(() => Promise.resolve())} />);

    expect(screen.getByText(catalogues.ru["style.layerProfile"])).toBeDefined();
    expect(screen.getByLabelText(catalogues.ru["style.persona"])).toBeDefined();
  });

  it("carries the version it was rendered against, so a stale save is refused rather than silent", () => {
    editor();

    // Each tab holds a *complete* profile, so a save with no version to check would replace every field a
    // colleague had just changed with an old copy of itself. The store has always been able to refuse
    // that; before this field the form never gave it anything to refuse against.
    const version = document.querySelector('input[name="expectedUpdatedAt"]');
    expect(version?.getAttribute("value")).toBe("2026-09-30T10:00:00.000Z");
  });

  it("claims no version for a layer nobody has written", () => {
    editor({ exists: false, updatedAt: null });

    // Empty is a claim too — "there was nothing here" — and the store checks it: a layer created in the
    // meantime makes this save a conflict rather than an overwrite.
    expect(document.querySelector('input[name="expectedUpdatedAt"]')?.getAttribute("value")).toBe("");
  });
});
