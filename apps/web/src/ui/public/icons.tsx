/**
 * The two marks on the appearance control.
 *
 * Inline SVG rather than an icon font or an image: one fewer request, they inherit `currentColor` so the
 * live and idle states need no second asset, and they scale with the text rather than against it.
 *
 * Both are `aria-hidden` and carry no title. The control they sit in is a button whose accessible name
 * comes from the catalogue — "Light" / "Светлая" — so a screen reader reads a word rather than
 * announcing a graphic, and the icon is left to do the job it is good at, which is being recognised
 * without being read.
 */
export function SunIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.4v2.4M12 19.2v2.4M4.22 4.22l1.7 1.7M18.08 18.08l1.7 1.7M2.4 12h2.4M19.2 12h2.4M4.22 19.78l1.7-1.7M18.08 5.92l1.7-1.7" />
    </svg>
  );
}

export function MoonIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* A crescent as one closed path, so it reads at 16px: a two-circle cut-out loses its shape and
          turns into a grey blob at this size. */}
      <path d="M20.3 14.2A8.6 8.6 0 0 1 9.8 3.7a8.6 8.6 0 1 0 10.5 10.5Z" />
    </svg>
  );
}
