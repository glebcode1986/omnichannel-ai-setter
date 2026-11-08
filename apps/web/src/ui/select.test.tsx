// @vitest-environment jsdom
/**
 * The product's own select.
 *
 * A hand-built menu is the component people get wrong, and they get it wrong in the same place every
 * time: the keyboard. So the keyboard is most of this file. A native `<select>` opens on Enter, Space
 * and either arrow; moves with the arrows, Home and End; chooses with Enter and Space; closes on
 * Escape and hands focus back; changes value with the arrows while *closed*; and jumps to an option
 * when you type its first letters. Replacing it means owning all of that, and a test per behaviour is
 * the only way to know it is still owned a month from now.
 *
 * The other half is what the form sees. A select submits a value under a name; so must this, or every
 * filter row and every server action around it silently stops carrying a field.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "./select";

const OPTIONS = [
  { value: "ALL", label: "Every channel" },
  { value: "IG", label: "Instagram" },
  { value: "WA", label: "WhatsApp" },
];

afterEach(cleanup);

const mount = (overrides: Partial<React.ComponentProps<typeof Select>> = {}) =>
  render(<Select name="channel" options={OPTIONS} value="ALL" ariaLabel="Channel" {...overrides} />);

const combobox = () => screen.getByRole("combobox", { name: "Channel" });
const hidden = (): HTMLInputElement => document.querySelector('input[type="hidden"][name="channel"]') as HTMLInputElement;

describe("before any script has run", () => {
  it("is a real select, so a page that never hydrates still has a working control", () => {
    // The server render is what a reader gets with JavaScript off, or before it arrives. A button that
    // opens nothing would be worse than the native menu this replaces.
    const markup = renderToStaticMarkup(<Select name="channel" options={OPTIONS} value="IG" ariaLabel="Channel" />);

    expect(markup).toContain("<select");
    expect(markup).toContain('name="channel"');
    expect(markup).toContain('value="IG" selected=""');
    // And no half-built custom control alongside it: one control, not two.
    expect(markup).not.toContain('role="combobox"');
    expect(markup).not.toContain('type="hidden"');
  });
});

describe("once it has", () => {
  it("replaces the native control rather than hiding one behind the other", () => {
    mount();

    // Two controls would be two tab stops, and hiding one from assistive technology is the mistake the
    // a11y gate in this repository exists to catch.
    expect(document.querySelectorAll("select").length).toBe(0);
    expect(combobox()).toBeDefined();
  });

  it("submits under the same name a select would", () => {
    mount({ value: "WA" });

    expect(hidden().value).toBe("WA");
    expect(combobox().textContent).toContain("WhatsApp");
  });

  it("follows the value the server re-rendered, rather than the one it opened with", () => {
    // The bug this is the general form of: the language control kept showing "English" after the page,
    // `<html lang>` and the database had all moved to Russian, because an uncontrolled select reads its
    // default once and a re-render reconciles the same element.
    const view = mount({ value: "ALL" });
    expect(combobox().textContent).toContain("Every channel");

    view.rerender(<Select name="channel" options={OPTIONS} value="WA" ariaLabel="Channel" />);

    expect(combobox().textContent).toContain("WhatsApp");
    expect(hidden().value).toBe("WA");
  });
});

describe("the pointer", () => {
  it("opens, chooses, closes, and hands focus back", async () => {
    const user = userEvent.setup();
    const chose = vi.fn();
    mount({ onChoose: chose });

    await user.click(combobox());
    expect(combobox().getAttribute("aria-expanded")).toBe("true");

    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Instagram" }));

    expect(chose).toHaveBeenCalledWith("IG");
    expect(hidden().value).toBe("IG");
    expect(screen.queryByRole("listbox")).toBeNull();
    // Focus goes back to the control, or the next Tab starts from the top of the document.
    expect(document.activeElement).toBe(combobox());
  });

  it("closes when the pointer goes down outside it", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Select name="channel" options={OPTIONS} value="ALL" ariaLabel="Channel" />
        <p>elsewhere</p>
      </div>,
    );

    await user.click(combobox());
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.click(screen.getByText("elsewhere"));

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("the keyboard, which is the part a hand-built menu loses", () => {
  it("opens on Enter, Space and either arrow", async () => {
    const user = userEvent.setup();
    for (const key of ["{Enter}", " ", "{ArrowDown}", "{ArrowUp}"]) {
      cleanup();
      mount();
      combobox().focus();
      await user.keyboard(key);
      expect(screen.getByRole("listbox"), key).toBeDefined();
    }
  });

  it("moves with the arrows and says which option it is on", async () => {
    const user = userEvent.setup();
    mount();
    combobox().focus();

    await user.keyboard("{ArrowDown}");
    const first = combobox().getAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    const second = combobox().getAttribute("aria-activedescendant");

    // The option the keyboard is on is named to assistive technology, not only drawn: options in a
    // listbox are not focusable, so this attribute is the only thing announcing the move.
    expect(first).not.toBe(second);
    expect(document.getElementById(String(second))?.textContent).toBe("Instagram");
  });

  it("chooses with Enter", async () => {
    const user = userEvent.setup();
    const chose = vi.fn();
    mount({ onChoose: chose });
    combobox().focus();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(chose).toHaveBeenCalledWith("IG");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("jumps to the first and the last with Home and End", async () => {
    const user = userEvent.setup();
    mount();
    combobox().focus();

    await user.keyboard("{ArrowDown}{End}{Enter}");
    expect(hidden().value).toBe("WA");

    await user.keyboard("{ArrowDown}{Home}{Enter}");
    expect(hidden().value).toBe("ALL");
  });

  it("closes on Escape without choosing, and hands focus back", async () => {
    const user = userEvent.setup();
    const chose = vi.fn();
    mount({ onChoose: chose });
    combobox().focus();

    await user.keyboard("{ArrowDown}{ArrowDown}{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chose).not.toHaveBeenCalled();
    expect(hidden().value).toBe("ALL");
    expect(document.activeElement).toBe(combobox());
  });

  it("answers an arrow on a closed control by opening it, and changes nothing until Enter", async () => {
    const user = userEvent.setup();
    const chose = vi.fn();
    mount({ onChoose: chose });
    combobox().focus();

    // Windows changes the value under a closed select; this does not, deliberately. Editing a form
    // nobody has opened is not something a reader can see happen, and the ARIA combobox pattern opens.
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("listbox")).toBeDefined();
    expect(hidden().value).toBe("ALL");
    expect(chose).not.toHaveBeenCalled();
  });

  it("jumps to an option when its first letters are typed", async () => {
    const user = userEvent.setup();
    mount();
    combobox().focus();

    await user.keyboard("wh");

    // Type-ahead is the one native behaviour people use without being told it exists, and the first
    // thing a hand-built menu drops.
    expect(hidden().value).toBe("WA");
  });

  it("leaves on Tab rather than trapping focus", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Select name="channel" options={OPTIONS} value="ALL" ariaLabel="Channel" />
        <button type="button">after</button>
      </div>,
    );
    combobox().focus();
    await user.keyboard("{ArrowDown}");

    await user.tab();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "after" }));
  });
});

describe("a control the reader may not change", () => {
  it("submits nothing, which is what the native control it replaced did", () => {
    // The defect this is here for, found by rendering the two side by side: a disabled `<select>` is
    // excluded from submission and sends no field at all, while a hidden input beside a disabled button
    // keeps sending. The settings screen disables eleven controls for a viewer who may not edit, so the
    // conversion had quietly turned eleven absent fields into eleven present ones.
    const { container } = render(
      <form>
        <Select name="mode" options={OPTIONS} value="WA" ariaLabel="Channel" disabled />
      </form>,
    );

    const form = container.querySelector("form") as HTMLFormElement;
    expect([...new FormData(form).keys()]).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Channel" })).toHaveProperty("disabled", true);
  });

  it("still submits when it is not disabled, so the rule above is not simply off", () => {
    const { container } = render(
      <form>
        <Select name="mode" options={OPTIONS} value="WA" ariaLabel="Channel" />
      </form>,
    );

    expect([...new FormData(container.querySelector("form") as HTMLFormElement).entries()]).toEqual([["mode", "WA"]]);
  });
});

describe("inside a wrapping label, which is how every filter row in this app is written", () => {
  const wrapped = () =>
    render(
      <label>
        Channel
        <Select name="channel" options={OPTIONS} value="ALL" />
      </label>,
    );

  it("is named by the label and not by its own selected value", () => {
    // Measured rather than assumed: for a `<button>`, content usually wins, and here it does not — the
    // host-language label comes first in the name computation. So a converted filter row keeps saying
    // which field it is, and does not announce itself as "Every channel".
    wrapped();

    expect(screen.getByRole("combobox", { name: "Channel" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Every channel" })).toBeNull();
  });

  it("closes when an option is clicked, rather than being reopened by the label", async () => {
    // The trap this is here for. Label activation is the default action of a click anywhere inside the
    // label, so the click that chose an option was also forwarded to the combobox and toggled the list
    // back open: the value was taken and the menu stayed up, which reads as a broken control. The option
    // handler cancels the default for that reason.
    const user = userEvent.setup();
    wrapped();

    await user.click(screen.getByRole("combobox", { name: "Channel" }));
    await user.click(screen.getByRole("option", { name: "WhatsApp" }));

    expect(hidden().value).toBe("WA");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("an option that cannot be chosen", () => {
  const withDisabled = [
    { value: "ALL", label: "Every channel" },
    { value: "IG", label: "Instagram", disabled: true },
    { value: "WA", label: "WhatsApp" },
  ];

  it("is skipped by the keyboard and refuses a click", async () => {
    const user = userEvent.setup();
    const chose = vi.fn();
    render(<Select name="channel" options={withDisabled} value="ALL" ariaLabel="Channel" onChoose={chose} />);
    combobox().focus();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(hidden().value, "the arrows step over it").toBe("WA");

    await user.click(combobox());
    await user.click(screen.getByRole("option", { name: "Instagram" }));
    expect(chose, "and a click on it does nothing").not.toHaveBeenCalledWith("IG");
  });
});
