/**
 * A horizontal bar per row: the label, the bar, the number.
 *
 * Horizontal rather than columns because every category here is a sentence — "Held, outcome unknown",
 * "Handed to the provider" — and a column chart would either rotate those labels or truncate them.
 *
 * **The number is always printed beside its bar.** The bar is the only part of this that can mislead, and
 * it is marked `aria-hidden` for that reason: it is a picture of the figure next to it, not a second
 * figure, so a screen reader reads the list and skips the drawing. Nothing is reachable only by looking.
 *
 * **What a full bar means is a required prop, and there are only two honest answers.** Either the rows
 * are parts of a whole the caller can name — then the bar is a share of it and the leftover is real
 * space — or the categories overlap and no share of anything exists, in which case the longest bar is
 * simply the largest row and the chart says nothing about proportions. Review reasons are the second
 * kind: a draft that waited for three reasons is counted under all three, so bars drawn as shares of the
 * draft count would add up past the whole and look like an error in the data.
 */
import type { CSSProperties } from "react";

import { sharePercent } from "./scale";

export interface BarRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/**
 * What a full-length bar represents.
 *
 * `whole` takes the denominator from the caller, which is also what makes a leftover visible: eight
 * outcomes that only account for six of ten drafts leave four tenths of every track empty, and the panel
 * says why. `largest` fills the track with the biggest row and measures the others against it, which is
 * the only correct choice for categories that can double-count — their total is not a whole, so no bar
 * can be a share of it.
 */
export type BarScale = { readonly kind: "whole"; readonly of: number } | { readonly kind: "largest" };

export interface BarRowsProps {
  readonly rows: readonly BarRow[];
  readonly scale: BarScale;
}

/**
 * The width of one bar, as a custom property.
 *
 * A custom property rather than `width` directly, because the stylesheet has a rule the data must not be
 * able to overrule: a bar shorter than two pixels is rounded up to two, so one draft in five thousand is
 * still a mark rather than nothing. An inline `width` would win over that rule and silently erase the
 * smallest rows. The cast is React's: `CSSProperties` has no index signature for custom properties,
 * which are otherwise ordinary CSS.
 */
function barWidth(value: number, top: number): CSSProperties {
  return { "--bar": sharePercent(value, top) } as CSSProperties;
}

/**
 * Whether there is anything to draw: rows, and a denominator above zero to draw them against.
 *
 * Exported because the caller needs the same answer — a panel whose rows are all zero should show its
 * own sentence rather than a heading with nothing under it — and a second implementation of the question
 * is how the two come to disagree.
 */
export function hasBars(rows: readonly BarRow[], scale: BarScale): boolean {
  return rows.length > 0 && (scale.kind === "whole" ? scale.of > 0 : rows.some((row) => row.value > 0));
}

/**
 * The rows, or nothing.
 *
 * Returns `undefined` when `hasBars` is false. A chart of empty tracks is not an honest rendering of
 * "nothing happened"; it is a chart that looks broken. The caller keeps its own empty state, which is a
 * sentence.
 */
export function BarRows({ rows, scale }: BarRowsProps) {
  if (!hasBars(rows, scale)) {
    return undefined;
  }
  // The largest row itself, not a rounded ceiling above it. `niceTop` is for an axis with a stated top,
  // which is what `DayColumns` draws; here there is no axis, so rounding up would only make the longest
  // bar's length depend on where its value happens to fall — full width for five, three fifths for
  // twelve — while "scaled to the largest" says the longest bar is the full track.
  const top = scale.kind === "whole" ? scale.of : Math.max(0, ...rows.map((row) => row.value));

  return (
    <dl className="bar-rows" data-chart="bars" data-scale={scale.kind}>
      {rows.map((row) => (
        <div className="bar-row" key={row.key} data-row={row.key}>
          <dt>{row.label}</dt>
          <dd className="bar-value">{row.value}</dd>
          {/* The drawing is a second `dd`, which one term is allowed, and it is `aria-hidden`: it is a
              picture of the figure above it rather than a second figure, so the accessibility tree is
              left with exactly one description per row and a screen reader reads the list. */}
          <dd className="bar-plot" aria-hidden="true">
            <span className="bar-track">
              {/* No element at all for zero. An empty track is what "none" looks like, and the two-pixel
                  floor in the stylesheet would otherwise draw a mark for a row that has nothing. */}
              {row.value > 0 ? <span className="bar-fill" style={barWidth(row.value, top)} /> : undefined}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
