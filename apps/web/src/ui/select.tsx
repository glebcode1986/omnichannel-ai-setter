"use client";

/**
 * The product's own select, drawn by the product.
 *
 * A native `<select>` can be styled down to the last pixel while it is *closed* — this stylesheet
 * already does that — and not at all while it is open: the list is drawn by the operating system, in
 * the system's font, colours and metrics. On a desktop that means a grey Windows menu dropping out of a
 * console that has spent a lot of effort not looking like one.
 *
 * **The native control is still what ships without scripting.** This renders a real `<select>` on the
 * server and replaces it with the listbox below only after hydration, so a page with no JavaScript, or
 * one that has not hydrated yet, has a working control and not a dead button. There is exactly one
 * control at any moment — the native one *or* ours — because two would mean two tab stops, and hiding
 * one from assistive technology is the mistake the a11y gate in this repository exists to catch.
 *
 * **It submits like a select.** Once enhanced, a hidden input carries the value under the same `name`,
 * so every form around it — a GET filter row, a server action — keeps working without knowing.
 *
 * The keyboard is the part a hand-built menu usually loses, so it is written out here: Enter, Space and
 * the arrows open it; the arrows, Home and End move inside it; Enter and Space choose; Escape closes it
 * and gives focus back; and typing letters jumps to a matching option, which is the one native
 * behaviour people reach for without being told it exists.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly name: string;
  readonly options: readonly SelectOption[];
  /** The value the server rendered. The control follows it, so a re-render cannot leave the two apart. */
  readonly value: string;
  /** The accessible name, when no `<label for>` points at this control. */
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  /** Called after a choice, with the chosen value. Submit-on-change rows use it. */
  readonly onChoose?: (value: string) => void;
}

/** Where the type-ahead buffer stops being one word and starts being the next. */
const TYPE_AHEAD_RESET_MS = 700;

/** Hydration never changes after it happens, so there is nothing to subscribe to. */
function subscribeToNothing(): () => void {
  return () => {
    /* nothing to unsubscribe from */
  };
}

export function Select({ name, options, value, ariaLabel, id, disabled = false, onChoose }: SelectProps) {
  // Server-rendered as the native control, swapped once this has hydrated. `useSyncExternalStore` is
  // what asks that question without a state write: it is told how to read the value on the server
  // (`false`) and in the browser (`true`), and nothing ever changes, so it never subscribes to
  // anything. An effect that set a flag would do the same thing and be a cascading render.
  const enhanced = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  // Follows the server's value, and is the reader's choice in between. Both are needed: the control
  // has to feel immediate, and it must not drift from what was actually stored — which is the defect
  // the language switcher had, reading "English" beside a page that had moved to Russian.
  //
  // Adjusted during render rather than in an effect. React documents this shape for exactly this case,
  // and the effect version renders twice with a wrong value in between.
  const [chosen, setChosen] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setChosen(value);
  }

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const generatedId = useId();
  const base = id ?? generatedId;
  const listId = `${base}-listbox`;
  const optionId = (index: number): string => `${base}-option-${String(index)}`;

  const selected = useMemo(() => options.find((option) => option.value === chosen) ?? options[0], [options, chosen]);
  const selectableIndexes = useMemo(
    () => options.flatMap((option, index) => (option.disabled === true ? [] : [index])),
    [options],
  );

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (option === undefined || option.disabled === true) {
        return;
      }
      setChosen(option.value);
      setOpen(false);
      button.current?.focus();
      onChoose?.(option.value);
    },
    [options, onChoose],
  );

  const openAt = useCallback(
    (index: number) => {
      setActive(index);
      setOpen(true);
    },
    [],
  );

  // Closing on an outside pointer, which a native select does and a `blur` handler gets wrong: a click
  // on an option blurs the button before the option's own handler runs.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (button.current?.contains(target) === true || list.current?.contains(target) === true)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.value === chosen),
  );

  /**
   * Moves the keyboard's position inside an open list.
   *
   * Only inside an open one. A closed select answers an arrow by *opening*, which is what the ARIA
   * combobox pattern asks for and what a reader can discover; changing the value under a closed
   * control is a Windows behaviour that silently edits a form nobody is looking at. An earlier draft
   * had a branch here for the closed case and nothing ever reached it, because the key handler opens
   * first — a dead branch that read as a feature.
   */
  const step = useCallback(
    (direction: 1 | -1) => {
      const from = selectableIndexes.indexOf(active);
      const next = selectableIndexes[Math.min(selectableIndexes.length - 1, Math.max(0, from + direction))];
      if (next !== undefined) {
        setActive(next);
      }
    },
    [active, selectableIndexes],
  );

  const typeAhead = useCallback(
    (character: string) => {
      const now = Date.now();
      const text = (now - typed.current.at > TYPE_AHEAD_RESET_MS ? "" : typed.current.text) + character.toLowerCase();
      typed.current = { text, at: now };
      const match = options.findIndex((option) => option.disabled !== true && option.label.toLowerCase().startsWith(text));
      if (match === -1) {
        return;
      }
      if (open) {
        setActive(match);
      } else {
        choose(match);
      }
    },
    [options, open, choose],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (open) {
            step(1);
          } else {
            openAt(currentIndex);
          }
          return;
        case "ArrowUp":
          event.preventDefault();
          if (open) {
            step(-1);
          } else {
            openAt(currentIndex);
          }
          return;
        case "Home":
          if (open) {
            event.preventDefault();
            setActive(selectableIndexes[0] ?? 0);
          }
          return;
        case "End":
          if (open) {
            event.preventDefault();
            setActive(selectableIndexes[selectableIndexes.length - 1] ?? 0);
          }
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          if (open) {
            choose(active);
          } else {
            openAt(currentIndex);
          }
          return;
        case "Escape":
          if (open) {
            event.preventDefault();
            setOpen(false);
            button.current?.focus();
          }
          return;
        case "Tab":
          setOpen(false);
          return;
        default:
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            typeAhead(event.key);
          }
      }
    },
    [open, active, currentIndex, selectableIndexes, step, openAt, choose, typeAhead],
  );

  if (!enhanced) {
    return (
      <select
        className="select-native"
        name={name}
        defaultValue={value}
        disabled={disabled}
        {...(id === undefined ? {} : { id })}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        onChange={(event) => {
          onChoose?.(event.currentTarget.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled === true}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="select" data-open={String(open)}>
      {/* What the form sees. The native control is gone by now, so this is the only thing carrying a
          value, and it carries it under the same name the form already expected. */}
      <input type="hidden" name={name} value={chosen} />
      <button
        className="select-button"
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        /* Which option the keyboard is on. Options in a listbox are not tab stops — focus stays here
           and moves by this attribute — which is also why each one carries a click handler rather than
           being a button of its own. */
        {...(open ? { "aria-activedescendant": optionId(active) } : {})}
        disabled={disabled}
        ref={button}
        {...(id === undefined ? {} : { id })}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openAt(currentIndex);
          }
        }}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected?.label ?? ""}</span>
        <span aria-hidden="true" className="select-mark" />
      </button>
      {/* No `tabIndex` on the list: focus never comes here. It stays on the combobox and moves by
          `aria-activedescendant`, which is the whole reason the options are not buttons. */}
      {open ? (
        <ul className="select-list" id={listId} ref={list} role="listbox">
          {options.map((option, index) => (
            <li
              aria-disabled={option.disabled === true ? true : undefined}
              aria-selected={option.value === chosen}
              className="select-option"
              data-active={String(index === active)}
              /* The option's value, which a native `<select>` put in the DOM and a listbox does not.
                 Without it the set of values a control offers is unreadable from the rendered markup —
                 only the labels are there — and every test that checked "these are the choices" would
                 have had to be rewritten into a weaker one about words on screen. */
              data-value={option.value}
              id={optionId(index)}
              key={option.value}
              role="option"
              onPointerEnter={() => {
                setActive(index);
              }}
              onClick={(event) => {
                // Cancelled, because this control is routinely written inside a wrapping `<label>` — the
                // shape every filter row in this app uses — and label activation is the *default action*
                // of a click anywhere inside it. Without this, choosing an option also forwarded the
                // click to the combobox, which toggled the list straight back open: the value was taken
                // and the menu stayed up. An option has no default action of its own to lose.
                event.preventDefault();
                choose(index);
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      ) : undefined}
    </div>
  );
}
