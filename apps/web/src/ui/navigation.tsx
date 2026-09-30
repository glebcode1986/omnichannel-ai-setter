"use client";

/**
 * The workspace shell's primary navigation.
 *
 * A client component for one reason: the mobile disclosure has state. Its words arrive as plain strings
 * rather than a translator, because a translator carries functions and functions do not cross the
 * server/client boundary — and pushing the catalogue into the browser to re-translate what the server
 * already knew would be shipping the same text twice.
 *
 * Everything it needs to decide what is current also arrives as a prop, so it renders in a test without a
 * router and the "current page" decision has one home.
 *
 * The mobile behaviour is a real `<button>` with real `aria-expanded`, not a hover menu. PRODUCT_UX.md
 * requires critical actions to stay reachable "without desktop-only hover interactions", and a disclosure
 * that only responds to a pointer fails that for everyone using a keyboard.
 */
import Link from "next/link";
import { useState } from "react";

import { NAV_SECTIONS, type NavSection } from "./sections";

export interface NavigationProps {
  /** Route prefix for this workspace and profile, without a trailing slash. */
  readonly basePath: string;
  /** The current path, used to mark exactly one link as the page. */
  readonly currentPath: string;
  /** Section names in the reader's locale, resolved on the server. */
  readonly labels: Readonly<Record<NavSection, string>>;
  /** Accessible name of the mobile disclosure, in the reader's locale. */
  readonly toggleLabel: string;
  readonly navigationLabel: string;
}

export function Navigation({ basePath, currentPath, labels, toggleLabel }: NavigationProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="shell-nav-list"
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        {toggleLabel}
      </button>
      <ul className="nav-list" id="shell-nav-list" data-collapsed={open ? "false" : "true"}>
        {NAV_SECTIONS.map((section) => (
          <li key={section}>
            <Link
              className="nav-link"
              href={`${basePath}/${section}`}
              // Exactly one link is the page. A prefix match would light up two when a section gains
              // sub-routes, and "you are here" that points at two places tells a screen reader nothing.
              {...(isCurrent(currentPath, basePath, section) ? { "aria-current": "page" as const } : {})}
            >
              {labels[section]}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function isCurrent(currentPath: string, basePath: string, section: NavSection): boolean {
  const sectionPath = `${basePath}/${section}`;
  return currentPath === sectionPath || currentPath.startsWith(`${sectionPath}/`);
}
