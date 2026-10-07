// @vitest-environment jsdom
/**
 * Adding a style example by hand (Issue #32).
 *
 * The regression this file exists for: the form shipped without a scope control. The store had always
 * supported a Workspace-level example and `scopeFrom` defaults a missing value to this profile, so the
 * Workspace layer was reachable from tests and from nowhere else. Nothing failed; a capability simply did
 * not exist in the product.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddExampleForm } from "./add-example-form";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const form = (translator = t) => render(<AddExampleForm t={translator} target={TARGET} action={vi.fn(() => Promise.resolve())} />);

describe("the add-example form", () => {
  it("asks for both halves of an example, and requires both", () => {
    form();

    // An example is a pair: the reply alone cannot be matched to a later question, and the question alone
    // has no tone in it. The store refuses half of one, so the form should not invite half of one.
    expect(screen.getByLabelText(text("style.exampleInbound"))).toHaveProperty("required", true);
    expect(screen.getByLabelText(text("style.exampleOutbound"))).toHaveProperty("required", true);
  });

  it("offers both layers, so a Workspace example can actually be created", () => {
    form();

    const scope = screen.getByLabelText(text("style.exampleScope"));
    const values = [...(scope as HTMLSelectElement).options].map((option) => option.value);
    expect(values).toEqual(["BUSINESS_PROFILE", "WORKSPACE"]);
  });

  it("defaults to this profile, which is the narrower of the two", () => {
    form();

    // An example meant for one business that lands on the base voice changes how every other profile in
    // the workspace sounds, so the default is the mistake that costs least.
    expect(screen.getByLabelText(text("style.exampleScope"))).toHaveProperty("value", "BUSINESS_PROFILE");
  });

  it("reads in Russian", () => {
    form(createTranslator("ru"));

    expect(screen.getByLabelText(catalogues.ru["style.exampleScope"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["style.addExample"])).toBeDefined();
  });
});
