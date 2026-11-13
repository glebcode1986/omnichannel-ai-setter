// @vitest-environment jsdom
/**
 * The product's own select, as a form sees it.
 *
 * The component replaces a native `<select>` once it has hydrated, and its promise to every form around
 * it is that nothing notices: a hidden input carries the value under the same `name`. That promise is
 * what these tests hold it to, because the one place a hand-built listbox can quietly diverge from the
 * control it replaced is the gap between *what it shows* and *what it sends* — and a form that shows one
 * thing and sends another cannot be corrected by the reader, who is looking at the thing it shows.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { Select } from "./select";

const OPTIONS = [
  { value: "", label: "Every channel" },
  { value: "ca_ig", label: "@studio" },
  { value: "ca_wa", label: "+34600111222" },
] as const;

afterEach(cleanup);

/** The hidden input is the whole of what a GET form or a server action receives. */
const submitted = (container: HTMLElement): string | undefined => {
  const input = container.querySelector<HTMLInputElement>('input[type="hidden"]');
  return input === null ? undefined : input.value;
};

const shown = (): string => screen.getByRole("combobox").textContent ?? "";

describe("the product's select", () => {
  it("submits the value it was given", () => {
    const { container } = render(<Select name="account" value="ca_wa" options={[...OPTIONS]} ariaLabel="Channel" />);

    // The control that makes the next test mean something: when the value *is* an option, shown and
    // submitted agree, so a later disagreement is the defect and not the component's normal state.
    expect(shown()).toContain("+34600111222");
    expect(submitted(container)).toBe("ca_wa");
  });

  it("submits what it shows when the value matches no option, instead of re-sending the unknown one", () => {
    // Reachable, not contrived: the Inbox's channel filter reads `?account=` out of the URL, and its
    // valid set is a database row rather than a literal union, so the view can legitimately hold the id
    // of a deleted account or one belonging to another business profile.
    const { container } = render(<Select name="account" value="ca_deleted" options={[...OPTIONS]} ariaLabel="Channel" />);

    // A native select resolves an unmatched value to its first option, and that is the behaviour every
    // form around this component was written against.
    expect(shown()).toContain("Every channel");
    expect(submitted(container)).toBe("");

    // Which is the point: the reader sees "every channel", presses the form's own apply button, and the
    // filter is actually cleared. Carrying `ca_deleted` here left an empty list that no visible control
    // could explain or undo.
    expect(submitted(container)).not.toBe("ca_deleted");
  });

  it("submits the reader's choice once they have made one", async () => {
    const user = userEvent.setup();
    const { container } = render(<Select name="account" value="" options={[...OPTIONS]} ariaLabel="Channel" />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "@studio" }));

    expect(shown()).toContain("@studio");
    expect(submitted(container)).toBe("ca_ig");
  });

  it("sends nothing at all while it is disabled, the way a disabled select does not", () => {
    // Read through a real `FormData`, because "the input is disabled" and "the form does not carry this
    // field" are different claims and only the second one is the behaviour that matters.
    const enabled = render(
      <form>
        <Select name="account" value="ca_ig" options={[...OPTIONS]} ariaLabel="Channel" />
      </form>,
    );
    const enabledForm = enabled.container.querySelector("form");
    expect(enabledForm === null ? undefined : new FormData(enabledForm).get("account")).toBe("ca_ig");
    cleanup();

    const { container } = render(
      <form>
        <Select name="account" value="ca_ig" options={[...OPTIONS]} ariaLabel="Channel" disabled />
      </form>,
    );

    // A disabled control is excluded from submission, so the hidden input has to be disabled too.
    // Otherwise converting a field from native to this one turns "the form did not carry this" into
    // "the form carried the stored value" — two different facts to a partial update, or to an audit of
    // what a request actually contained.
    const form = container.querySelector("form");
    expect(form === null ? undefined : new FormData(form).get("account")).toBeNull();
  });
});
