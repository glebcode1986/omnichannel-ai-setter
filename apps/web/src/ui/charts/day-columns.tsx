/**
 * One column per day, for the two counts that answer "how much is coming in".
 *
 * **Every day the window covers gets a slot, including the empty ones.** The store can only return days
 * that had something on them, so a chart drawn from its rows alone would stand Monday beside Thursday at
 * equal width and call it a week. `localDays` supplies the axis and the rows are matched onto it; a day
 * with no inbound draws no column, which is what a quiet day should look like.
 *
 * **The two series are nested, so they are drawn nested.** Conversations are the conversations those
 * messages arrived in, so the count can never exceed the message count — ten messages from one person
 * and one from ten people are the same number and not the same day, which is the whole reason both are
 * measured. A narrower, darker column in front of a wider, lighter one says "this many of those"; a
 * stack would say "these add up", which would be false, and two adjacent columns per day would halve
 * the width available at ninety days.
 *
 * **Plain elements rather than an SVG.** A scaled SVG scales everything in it: the two-pixel gap between
 * columns, the hairline of the axis and any text inside would each be a different size at 375px and at
 * 1600px, and the fixes for that (`non-scaling-stroke`, a width-dependent viewBox) are a workaround for
 * a problem that only exists if the chart is an image. Boxes in a flex row are real pixels at every
 * width, take their colours from the same tokens as the rest of the product, and get dark mode for free.
 */
import type { CSSProperties } from "react";

import { localDays, niceTop, sharePercent, type DayWindow } from "./scale";

export interface DayPoint {
  /** The local calendar day, `YYYY-MM-DD`, as `localDays` and the store both write it. */
  readonly day: string;
  readonly primary: number;
  readonly secondary: number;
}

export interface DayColumnsProps {
  readonly window: DayWindow;
  readonly points: readonly DayPoint[];
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  /** The hover text for one day, localized by the caller — including days with nothing on them. */
  readonly titleFor: (day: string, primary: number, secondary: number) => string;
}

/** See `bar-rows.tsx`: a custom property, so the stylesheet's two-pixel floor is not overruled inline. */
function columnHeight(value: number, top: number): CSSProperties {
  return { "--column": sharePercent(value, top) } as CSSProperties;
}

/** The slot count, so the stylesheet can reserve a minimum width per day and scroll past it. */
function slots(count: number): CSSProperties {
  return { "--day-count": String(count) } as CSSProperties;
}

export function DayColumns({ window, points, primaryLabel, secondaryLabel, titleFor }: DayColumnsProps) {
  const days = localDays(window);
  const byDay = new Map(points.map((point) => [point.day, point]));
  const top = niceTop(Math.max(0, ...points.flatMap((point) => [point.primary, point.secondary])));
  // Nothing measured, or a window that covers no day: the panel keeps its own sentence rather than
  // showing an axis with no scale.
  if (days.length === 0 || top <= 0) {
    return undefined;
  }

  return (
    <figure className="chart" data-chart="days" aria-hidden="true">
      <figcaption className="chart-legend">
        <span className="chart-key">{primaryLabel}</span>
        <span className="chart-key" data-series="secondary">
          {secondaryLabel}
        </span>
        {/* The axis ceiling, a clean number at or above the tallest column. Scaling to the tallest value
            itself would make every window look identical and leave the caption to carry the difference. */}
        <span className="chart-top">{top}</span>
      </figcaption>
      <ol className="chart-days" style={slots(days.length)}>
        {days.map((day) => {
          const point = byDay.get(day);
          const primary = point?.primary ?? 0;
          const secondary = point?.secondary ?? 0;
          return (
            <li key={day} title={titleFor(day, primary, secondary)}>
              {primary > 0 ? <span className="chart-column" style={columnHeight(primary, top)} /> : undefined}
              {secondary > 0 ? <span className="chart-column" data-series="secondary" style={columnHeight(secondary, top)} /> : undefined}
            </li>
          );
        })}
      </ol>
      {/* The first and last day, and nothing between them. A tick under every column is unreadable at
          ninety days and unnecessary at seven: the table below carries every date. */}
      <p className="chart-span">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </p>
    </figure>
  );
}
