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

/**
 * The menu, and the same control once it is open.
 *
 * Three lines rather than a word in a box. The product's phone header used a 358px-wide button with a
 * hairline border, a white fill and centred text, which is the exact drawing of a text input — the
 * owner read it as an empty field and never pressed it, which is the only review that matters.
 */
export function MenuIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" />
    </svg>
  );
}

export function CloseIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** An external destination, so a link that leaves the product says so before it is followed. */
export function ExternalIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
