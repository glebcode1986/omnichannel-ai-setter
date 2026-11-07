/**
 * Reading the product's own select from a test.
 *
 * A native `<select>` answers two questions directly from the DOM — what it offers, and what it will
 * submit — through `.options` and `.value`. The listbox that replaced it answers neither: its options do
 * not exist until it is open, and the value it submits lives in a hidden input beside it. Thirteen tests
 * asked those two questions, and rewriting each one by hand would have produced thirteen slightly
 * different and mostly weaker versions of the same two reads.
 *
 * So the two reads live here, once, and say the same thing they said before: `offered` is the values in
 * order, `chosen` is what the form will carry.
 *
 * Directly under `src/` and not beside the component, because that is where the architecture checker's
 * exemption for test support actually is: `testing/` counts only as the first directory under `src/`, so
 * production code cannot hide in a nested one. At `src/ui/testing/` this file was runtime code importing
 * a devDependency, and the check said so.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** The control itself, by its accessible name — a wrapping `<label>` or a `<label for>` both work. */
export function control(name: string | RegExp): HTMLElement {
  return screen.getByRole("combobox", { name });
}

/**
 * What the form will submit for this field.
 *
 * Read from the hidden input rather than from the button's text, because the text is a *label* and the
 * value is what travels. A test that compared labels would pass on a control that submits the wrong one.
 */
export function chosen(field: string): string | undefined {
  const input = document.querySelector(`input[type="hidden"][name="${field}"]`);
  return input instanceof HTMLInputElement ? input.value : undefined;
}

/**
 * This control's own open list.
 *
 * Found through `aria-controls` rather than by role across the document, because a test that reads two
 * selects in a row leaves the first one open — and `getByRole("listbox")` then finds two and throws, on
 * code that works. The attribute is the control's own statement about which list is its.
 */
async function openList(name: string | RegExp): Promise<HTMLElement> {
  const user = userEvent.setup();
  const button = control(name);
  if (button.getAttribute("aria-expanded") !== "true") {
    await user.click(button);
  }
  const id = button.getAttribute("aria-controls") ?? "";
  const list = document.getElementById(id);
  if (list === null) {
    throw new Error(`the select named ${String(name)} did not open a list (aria-controls=${JSON.stringify(id)})`);
  }
  return list;
}

/** Every value this control offers, in order. Opens it, because a listbox has no options while closed. */
export async function offered(name: string | RegExp): Promise<string[]> {
  const list = await openList(name);
  return [...list.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("data-value") ?? "");
}

/** The labels this control offers, for the cases that are about the words rather than the values. */
export async function offeredLabels(name: string | RegExp): Promise<string[]> {
  const list = await openList(name);
  return [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
}

/** Choose by label, the way a reader does. */
export async function choose(name: string | RegExp, label: string | RegExp): Promise<void> {
  const list = await openList(name);
  await userEvent.setup().click(within(list).getByRole("option", { name: label }));
}
