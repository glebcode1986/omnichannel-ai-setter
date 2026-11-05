/**
 * One mark per section, so the navigation can be scanned instead of read.
 *
 * Drawn here rather than pulled from an icon set, for the reason the brand mark is: a dependency that
 * ships a thousand glyphs to use seven is a dependency, and these are seven paths. All one weight, all
 * on a 24 grid, all inheriting `currentColor` so the live item needs no second asset.
 *
 * Every one is `aria-hidden`. The link's own words are the accessible name; an icon that repeated them
 * would make a screen reader say each section twice.
 */
import type { NavSection } from "./sections";

function Frame({ children, className }: { readonly children: React.ReactNode; readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A tray with a message resting in it. */
const Inbox = () => (
  <Frame>
    <path d="M3.5 13h4l1.5 2.5h6L16.5 13h4" />
    <path d="M5.2 5h13.6l1.7 8v4.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V13Z" />
  </Frame>
);

/** A tick inside a ring: something looked at and let through. */
const Review = () => (
  <Frame>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.2l2.4 2.4 4.6-4.9" />
  </Frame>
);

/** Columns of a board, which is what the leads screen is. */
const Leads = () => (
  <Frame>
    <rect x="3.5" y="4.5" width="5" height="15" rx="1.4" />
    <rect x="10.5" y="4.5" width="5" height="10" rx="1.4" />
    <rect x="17" y="4.5" width="3.5" height="6.5" rx="1.4" />
  </Frame>
);

/** An open book: the facts the assistant may rely on. */
const Knowledge = () => (
  <Frame>
    <path d="M12 6.8C10.4 5.5 8.3 5 5.5 5H4v12.5h1.5c2.8 0 4.9.5 6.5 1.8 1.6-1.3 3.7-1.8 6.5-1.8H20V5h-1.5c-2.8 0-4.9.5-6.5 1.8Z" />
    <path d="M12 6.8v12.5" />
  </Frame>
);

/** A nib: how a reply sounds, as opposed to what it says. */
const Style = () => (
  <Frame>
    <path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8.5 18.5l-4 1Z" />
    <path d="M14.5 6.5l3 3" />
  </Frame>
);

/** Bars, rising. */
const Analytics = () => (
  <Frame>
    <path d="M4 20h16" />
    <path d="M6.5 20v-5.5M11.5 20V8.5M16.5 20v-8.5" />
  </Frame>
);

/**
 * Sliders, not a cog.
 *
 * The cog was a circle with eight rays, which at 18px is a sun — sitting six pixels from the sun that
 * means light mode. Two tracks with handles cannot be mistaken for anything else, and a settings
 * screen is in fact a wall of controls rather than a machine.
 */
const Settings = () => (
  <Frame>
    <path d="M4 8.5h10M18 8.5h2M4 15.5h4M12 15.5h8" />
    <circle cx="16" cy="8.5" r="2.2" />
    <circle cx="10" cy="15.5" r="2.2" />
  </Frame>
);

const ICONS: Readonly<Record<NavSection, () => React.JSX.Element>> = {
  inbox: Inbox,
  review: Review,
  leads: Leads,
  knowledge: Knowledge,
  style: Style,
  analytics: Analytics,
  settings: Settings,
};

export function SectionIcon({ section }: { readonly section: NavSection }) {
  const Icon = ICONS[section];
  return <Icon />;
}
