"use client";

/**
 * The workspace shell's primary navigation.
 *
 * A client component for one reason: the mobile disclosure has state. Everything it needs to decide what
 * is current arrives as a prop rather than being read from a router hook, so it renders in a test without
 * a router — and so the "current page" decision is one thing rather than scattered per link.
 *
 * The mobile behaviour is a real `<button>` with real `aria-expanded`, not a hover menu. PRODUCT_UX.md
 * requires the critical actions to stay reachable "without desktop-only hover interactions", and a
 * disclosure that only responds to a pointer fails that for everyone using a keyboard.
 */
import Link from "next/link";
import { useState } from "react";

import { NAV_SECTIONS, navLabels, shellText, type NavSection } from "./labels";

export interface NavigationProps {
  /** Route prefix for this workspace and profile, without a trailing slash. */
  readonly basePath: string;
  /** The current path, used to mark exactly one link as the page. */
  readonly currentPath: string;
}

export function Navigation({ basePath, currentPath }: NavigationProps) {
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
        {shellText.openNavigation}
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
              {navLabels[section]}
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
