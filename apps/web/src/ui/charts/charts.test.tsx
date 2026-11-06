// @vitest-environment jsdom
/**
 * What the two chart components promise, as distinct from what they look like.
 *
 * Three claims carry the weight here. A column chart's axis is the window, not the rows the store
 * happened to return. Every number a bar stands for is also printed as text, so nothing on the page is
 * reachable only by looking. And a bar's length means whatever its `scale` says it means — a share of a
 * named whole, or a position relative to the largest row — because the two are not interchangeable and
 * the overlapping case has no shares at all.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BarRows, hasBars } from "./bar-rows";
import { DayColumns } from "./day-columns";

afterEach(cleanup);

const week = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-08T00:00:00Z"), timeZone: "UTC" };

const dayChart = (points: readonly { day: string; primary: number; secondary: number }[]) => (
  <DayColumns
    window={week}
    points={points}
    primaryLabel="Messages"
    secondaryLabel="Conversations"
    titleFor={(day, primary, secondary) => `${day}: ${String(primary)}/${String(secondary)}`}
  />
);

const slots = (): HTMLElement[] => [...document.querySelectorAll(".chart-days > li")] as HTMLElement[];

describe("one column per day", () => {
  it("gives every day in the window a slot, including the ones the store returned no row for", () => {
    // The store cannot emit a row for a day with nothing on it. Drawn from its rows alone, a week with
    // two busy days would be a two-column chart — which reads as a two-day week rather than a quiet one.
    render(dayChart([{ day: "2026-10-02", primary: 9, secondary: 3 }, { day: "2026-10-06", primary: 4, secondary: 4 }]));

    expect(slots().length).toBe(7);
  });

  it("draws nothing in a day that had nothing, and says so on hover", () => {
    render(dayChart([{ day: "2026-10-02", primary: 9, secondary: 3 }]));

    const [first, second] = slots();
    expect(first?.querySelectorAll(".chart-column").length, "the 1st had no inbound").toBe(0);
    expect(first?.title).toBe("2026-10-01: 0/0");
    expect(second?.querySelectorAll(".chart-column").length, "the 2nd had both counts").toBe(2);
    expect(second?.title).toBe("2026-10-02: 9/3");
  });

  it("scales both series to one clean ceiling, which it states", () => {
    render(dayChart([{ day: "2026-10-02", primary: 12, secondary: 4 }]));

    // 20, not 12: an axis that ends at the tallest column makes every window look identical.
    expect(document.querySelector(".chart-top")?.textContent).toBe("20");
    const columns = [...(slots()[1]?.querySelectorAll(".chart-column") ?? [])] as HTMLElement[];
    expect(columns[0]?.style.getPropertyValue("--column")).toBe("60.00%");
    expect(columns[1]?.style.getPropertyValue("--column")).toBe("20.00%");
  });

  it("reserves a width per day, so ninety of them scroll instead of becoming a texture", () => {
    render(dayChart([{ day: "2026-10-02", primary: 1, secondary: 1 }]));

    expect((document.querySelector(".chart-days") as HTMLElement).style.getPropertyValue("--day-count")).toBe("7");
  });

  it("draws nothing at all when there is nothing measured", () => {
    // Not an axis with no scale on it, and not a row of empty slots: the panel keeps its own sentence.
    expect(render(dayChart([])).container.firstChild).toBeNull();
    expect(render(dayChart([{ day: "2026-10-02", primary: 0, secondary: 0 }])).container.firstChild).toBeNull();
  });

  it("is a picture of the table beside it, so assistive technology is not read the slots", () => {
    render(dayChart([{ day: "2026-10-02", primary: 9, secondary: 3 }]));

    expect(document.querySelector("figure")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("one bar per row", () => {
  const rows = [
    { key: "sent", label: "Sent unattended", value: 5 },
    { key: "reviewed", label: "Sent after review", value: 2 },
    { key: "none", label: "Rejected", value: 0 },
  ];
  const widthOf = (key: string): string =>
    (document.querySelector(`[data-row="${key}"] .bar-fill`) as HTMLElement).style.getPropertyValue("--bar");

  it("prints every value as text next to its bar", () => {
    render(<BarRows rows={rows} scale={{ kind: "largest" }} />);

    for (const row of rows) {
      const rendered = document.querySelector(`[data-row="${row.key}"]`) as HTMLElement;
      expect(within(rendered).getByText(row.label), `${row.key} is labelled`).toBeDefined();
      expect(rendered.querySelector(".bar-value")?.textContent, `${row.key} prints its number`).toBe(String(row.value));
    }
  });

  it("measures a share against the whole the caller named, leaving the rest of the track empty", () => {
    // Ten drafts, seven accounted for: every track is three tenths empty, which is the fact the panel
    // above it explains rather than a gap in the drawing.
    render(<BarRows rows={rows} scale={{ kind: "whole", of: 10 }} />);

    expect(widthOf("sent")).toBe("50.00%");
    expect(widthOf("reviewed")).toBe("20.00%");
  });

  it("measures against the largest row when the categories overlap, never against their total", () => {
    // Review reasons double-count: a draft held for three reasons appears under all three. Shares of the
    // rows' own total would come to more than one whole and read as broken data, so the longest bar here
    // means "the most common" and the ceiling is a clean number above it.
    render(<BarRows rows={rows} scale={{ kind: "largest" }} />);

    // Five and two, drawn against five: the longest bar is the full track and the other is two fifths of
    // it. Against the rows' total of seven they would be 71% and 29%, which would be a claim about a
    // whole these categories do not form.
    expect(widthOf("sent")).toBe("100.00%");
    expect(widthOf("reviewed")).toBe("40.00%");
  });

  it("draws no mark for a zero but still prints the zero", () => {
    render(<BarRows rows={rows} scale={{ kind: "largest" }} />);

    expect(document.querySelector('[data-row="none"] .bar-fill')).toBeNull();
    expect(document.querySelector('[data-row="none"] .bar-track'), "the empty track is still there").not.toBeNull();
    expect(screen.getByText("0")).toBeDefined();
  });

  it("leaves the drawing out of the accessibility tree and the number in it", () => {
    render(<BarRows rows={rows} scale={{ kind: "largest" }} />);

    const plot = document.querySelector('[data-row="sent"] .bar-plot');
    expect(plot?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector('[data-row="sent"] .bar-value')?.getAttribute("aria-hidden")).toBeNull();
  });

  it("draws nothing when there is no denominator, and says the same thing to its caller", () => {
    // One implementation of "is there anything to draw": the component asks `hasBars` and so does the
    // panel, which is what keeps a heading from appearing above an empty box.
    const allZero = [{ key: "a", label: "A", value: 0 }];

    expect(hasBars([], { kind: "largest" })).toBe(false);
    expect(hasBars(allZero, { kind: "largest" })).toBe(false);
    expect(hasBars(allZero, { kind: "whole", of: 0 })).toBe(false);
    // A whole above zero *is* drawable even with every row at zero: "none of ten" is a measurement.
    expect(hasBars(allZero, { kind: "whole", of: 10 })).toBe(true);

    expect(render(<BarRows rows={allZero} scale={{ kind: "largest" }} />).container.firstChild).toBeNull();
    expect(render(<BarRows rows={[]} scale={{ kind: "whole", of: 10 }} />).container.firstChild).toBeNull();
  });
});
