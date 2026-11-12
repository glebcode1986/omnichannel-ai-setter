/**
 * The KeepSayBot mark, and the character, which are deliberately the same thing.
 *
 * A speech bubble whose eyes do the talking because its mouth never does. That is the product in one
 * shape: it has the reply ready and it will not say it until a person allows it.
 *
 * The geometry is traced from the owner's artwork rather than redrawn by eye. The body's corners are
 * elliptical — a 242px flat run across a 906px width gives a horizontal radius of 332, and a 137px flat
 * run down a 703px height gives a vertical radius of 283 — which is why the form reads soft rather than
 * like a pill. The tail was contoured row by row from the raster and interpolated with a Catmull-Rom
 * curve so it passes *through* the measured points; an earlier version smoothed by midpoints, which made
 * every measured edge a control point, and a quadratic does not pass through its control point — the
 * tail came out uniformly thinner than the original and nothing but a difference blend showed it.
 *
 * Two sets of eyes, because the owner asked for the character to change its look when the demonstration
 * is restarted:
 *
 * - **sly** — the mark's own eyes, asymmetric on purpose: the left narrow and tall, the right wider,
 *   lower, with a flick at its outer corner. This is the resting brand face and the one it wears while
 *   it is holding a reply back.
 * - **plain** — two level ovals. Calm, attentive, nothing withheld. It wears this when the run is reset
 *   and nothing is pending.
 *
 * Both sets are in the markup at once and `data-eyes` says which one is forward. That is the whole
 * reason the change reads as a change of expression rather than a flicker: a component that rendered one
 * set or the other replaced a shape with a different shape between two frames, and no easing can soften
 * a swap that the stylesheet never sees. With both drawn, the stylesheet has two layers to move between.
 *
 * Each set nests its shapes in a second group, `mark-lids`, for a duller reason that matters: the
 * crossfade and the blink are both `transform`, and one element can only run one. The outer group owns
 * the change of expression, the inner one owns what the eyes do while an expression is held.
 */
export type MarkEyes = "sly" | "plain";

export interface MarkProps {
  readonly eyes?: MarkEyes;
  /** A label makes it an image to assistive technology; without one it is decoration and is hidden. */
  readonly title?: string;
  readonly className?: string;
}

export function Mark({ eyes = "sly", title, className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 1254 1254"
      className={className}
      data-eyes={eyes}
      {...(title === undefined ? { "aria-hidden": true, focusable: false } : { role: "img", "aria-label": title })}
    >
      <g className="mark-body">
        {/* The tail, its own shape in the same fill: overlapping the body it merges with it, and it can
            be adjusted — or moved on its own, which is what makes the character tap its foot — without
            touching the main form. */}
        <path
          className="mark-tail"
          d="M479 820 L479 944
             C470 946 437 953 423 958 C409 963 404 967 396 972 C388 977 380 981 372 986
             C364 991 356 995 347 1000 C338 1005 332 1009 321 1014 C310 1019 288 1026 281 1028
             C280 1028 280 1030 275 1028 C270 1026 253 1019 248 1014 C243 1009 244 1005 243 1000
             C242 995 241 991 242 986 C243 981 245 977 247 972 C249 967 251 963 253 958
             C255 953 258 947 259 944 L259 820 Z"
        />
        <rect x="166" y="240" width="906" height="703" rx="332" ry="283" />
      </g>

      <g className="mark-eyes" data-set="sly">
        <g className="mark-lids">
          {/* Левый: верх прямой, наклон 0.306 на пиксель — снят по замерам. Первая версия шла
              вдвое положе и глаз читался раскрытым, а не прищуренным. */}
          <path d="M386 471 L542 519 C540 543 535 634 530 662 C525 690 517 681 510 687
                   C503 693 497 696 490 699 C483 702 477 703 470 703 C463 703 457 702 450 701
                   C443 700 437 698 430 694 C423 690 417 687 410 679 C403 671 394 660 390 647
                   C386 634 387 608 386 600 Z" />
          {/* Правый: верх прямой до острия (862,577), оттуда одна гладкая диагональ вниз-влево.
              Первая версия ломала росчерк на четыре отрезка — получался зазубренный угол. */}
          <path d="M682 547 L862 577 C858 582 847 594 840 606 C833 618 827 634 820 646
                   C813 658 807 672 800 681 C793 690 787 695 780 699 C773 703 767 705 760 707
                   C753 709 747 709 740 709 C733 709 727 708 720 706 C713 704 707 702 700 696
                   C693 690 684 684 680 673 C676 662 673 646 673 630 C673 614 677 584 678 575 Z" />
        </g>
      </g>

      <g className="mark-eyes" data-set="plain">
        <g className="mark-lids">
          {/* Level, equal, unhurried. Sized and spaced to the sly pair so the swap does not jump. */}
          <ellipse cx="464" cy="560" rx="62" ry="78" />
          <ellipse cx="761" cy="560" rx="62" ry="78" />
        </g>
      </g>
    </svg>
  );
}
