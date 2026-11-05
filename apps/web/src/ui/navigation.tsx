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
import { useState, type ReactNode } from "react";

import { CloseIcon, ExternalIcon, MenuIcon } from "@/ui/public/icons";
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
  /**
   * Appearance and language, rendered beside the menu button rather than inside the list.
   *
   * On a phone they used to collapse with the sections, so a reader who wanted to change the language
   * had to open a menu named "Sections" to find something that is not a section. They now sit in the
   * bar, where they are reachable without opening anything.
   */
  readonly controls?: ReactNode;
  /**
   * Where the published documentation lives, when there is any.
   *
   * Optional on purpose. The subdomain exists in DNS and serves nothing yet, and a navigation item
   * pointing at a host with no site and no certificate is worse than no item at all — so the link
   * appears the day the deployment is configured with its address and not before.
   */
  readonly docsUrl?: string | undefined;
  /** The documentation link's label, in the reader's locale. */
  readonly docsLabel?: string;
  /** Said after the label, so a screen reader announces that the link leaves the product. */
  readonly externalHint?: string;
}

export function Navigation({
  basePath,
  currentPath,
  labels,
  toggleLabel,
  controls,
  docsUrl,
  docsLabel,
  externalHint,
}: NavigationProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* The bar is the phone header: the menu button at one end, appearance and language at the other,
          and it is what stays on screen when the sections are closed. On a wide screen there is no bar
          to speak of — the button is hidden and the controls sit at the top of the column. */}
      <div className="nav-bar">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="shell-nav-list"
          onClick={() => {
            setOpen((wasOpen) => !wasOpen);
          }}
        >
          {open ? <CloseIcon /> : <MenuIcon />}
          <span className="nav-toggle-label">{toggleLabel}</span>
        </button>
        {controls === undefined ? undefined : <div className="nav-bar-controls">{controls}</div>}
      </div>
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
        {docsUrl === undefined || docsLabel === undefined ? undefined : (
          <li>
            {/* A plain anchor, not `next/link`: this leaves the application, and the router has nothing
                to prefetch on another origin. `noreferrer` with `_blank` because `noopener` alone still
                hands the new tab a referrer it does not need. */}
            <a className="nav-link" data-nav-external="docs" href={docsUrl} target="_blank" rel="noreferrer">
              <span>{docsLabel}</span>
              <ExternalIcon className="nav-link-external" />
              {externalHint === undefined ? undefined : <span className="visually-hidden">{externalHint}</span>}
            </a>
          </li>
        )}
      </ul>
    </>
  );
}

function isCurrent(currentPath: string, basePath: string, section: NavSection): boolean {
  const sectionPath = `${basePath}/${section}`;
  return currentPath === sectionPath || currentPath.startsWith(`${sectionPath}/`);
}
