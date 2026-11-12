"use client";

/**
 * The product's frame: a sidebar that holds navigation, and a bar across the top of everything else.
 *
 * The bar comes first in the document and the sidebar second, while the grid puts the sidebar on the
 * left of both. That order is deliberate: the button that opens the sidebar lives in the bar, and with
 * the sidebar written first a keyboard reached every section before reaching the control that reveals
 * them. Reading order is bar, navigation, page; `grid-template-areas` does the rest.
 *
 * It replaces a flat column of seven links with the shape both of the owner's reference products use —
 * brand at the top of the sidebar, sections grouped under captions with a mark each, the account pinned
 * to the bottom, and a bar carrying where-you-are on the left and the controls on the right. The
 * difference that matters is not decoration: seven equal links make a reader scan all seven, and
 * appearance and language had nowhere to live except in the middle of the navigation.
 *
 * One component rather than three, because the disclosure state belongs to one owner. The button that
 * opens the sidebar on a phone sits in the top bar and the sidebar it opens is its sibling, so splitting
 * them would mean lifting the state somewhere above both and passing it down twice.
 *
 * A client component for that state alone. Everything it shows arrives as server-rendered nodes or plain
 * strings — a translator carries functions and functions do not cross the boundary, which is the
 * constraint `sign-in-panel.tsx` states.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { CloseIcon, ExternalIcon, MenuIcon } from "@/ui/public/icons";
import { SectionIcon } from "./section-icons";
import { NAV_GROUPS, type NavGroup, type NavSection } from "./sections";

export interface ShellFrameProps {
  /** Route prefix for this workspace and profile, without a trailing slash. */
  readonly basePath: string;
  /** Section names in the reader's locale, resolved on the server. */
  readonly labels: Readonly<Record<NavSection, string>>;
  /** Group captions in the reader's locale. */
  readonly groupLabels: Readonly<Record<NavGroup, string>>;
  readonly navigationLabel: string;
  readonly toggleLabel: string;
  /** Said by the control that closes the sidebar from outside it. */
  readonly closeLabel: string;
  /** The mark and the product's name, for the top of the sidebar. */
  readonly brand: ReactNode;
  /** Who you are and where: workspace, profile, and the way to change them. */
  readonly account: ReactNode;
  /** Where you are, for the left of the bar. */
  readonly crumb: ReactNode;
  /** Appearance and language, for the right of the bar. */
  readonly controls: ReactNode;
  /** The published documentation, when a deployment says where it is. */
  readonly docsUrl?: string | undefined;
  readonly docsLabel?: string;
  readonly externalHint?: string;
  readonly skipLabel: string;
  readonly children: ReactNode;
}

/** Exactly one link is the page: a prefix match would light up two once a section gains sub-routes. */
function isCurrent(currentPath: string, basePath: string, section: NavSection): boolean {
  const sectionPath = `${basePath}/${section}`;
  return currentPath === sectionPath || currentPath.startsWith(`${sectionPath}/`);
}

export function ShellFrame({
  basePath,
  labels,
  groupLabels,
  navigationLabel,
  toggleLabel,
  closeLabel,
  brand,
  account,
  crumb,
  controls,
  docsUrl,
  docsLabel,
  externalHint,
  skipLabel,
  children,
}: ShellFrameProps) {
  const currentPath = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  return (
    <div className="shell" data-nav-open={open ? "true" : "false"}>
      {/* A real in-page anchor, not a router link: it moves focus within this document. */}
      <a className="skip-link" href="#shell-content">
        {skipLabel}
      </a>

      <header className="shell-topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="shell-nav"
          onClick={() => {
            setOpen((wasOpen) => !wasOpen);
          }}
        >
          {open ? <CloseIcon /> : <MenuIcon />}
          <span className="visually-hidden">{toggleLabel}</span>
        </button>
        <div className="shell-crumb">{crumb}</div>
        <div className="shell-topbar-controls">{controls}</div>
      </header>

      <nav className="shell-nav" id="shell-nav" aria-label={navigationLabel}>
        <div className="shell-brand">{brand}</div>

        <div className="shell-sections">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.id}>
              {/* Sentence case, not tracked-out capitals: a caption is there to be glanced past. */}
              <p className="nav-group-label">{groupLabels[group.id]}</p>
              <ul className="nav-list">
                {group.sections.map((section) => (
                  <li key={section}>
                    <Link
                      className="nav-link"
                      href={`${basePath}/${section}`}
                      onClick={() => {
                        setOpen(false);
                      }}
                      {...(isCurrent(currentPath, basePath, section) ? { "aria-current": "page" as const } : {})}
                    >
                      <SectionIcon section={section} />
                      <span>{labels[section]}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {docsUrl === undefined || docsLabel === undefined ? undefined : (
            <div className="nav-group">
              <ul className="nav-list">
                <li>
                  {/* A plain anchor: this leaves the application and the router has nothing to prefetch
                      on another origin. `noreferrer` because `noopener` alone still hands the new tab a
                      referrer it does not need. */}
                  <a className="nav-link" data-nav-external="docs" href={docsUrl} target="_blank" rel="noreferrer">
                    <ExternalIcon />
                    <span>{docsLabel}</span>
                    {externalHint === undefined ? undefined : <span className="visually-hidden">{externalHint}</span>}
                  </a>
                </li>
              </ul>
            </div>
          )}
        </div>

        <div className="shell-account">{account}</div>
      </nav>

      <main className="shell-main" id="shell-content">
        {children}
      </main>

      {/*
        The scrim. On a phone the sidebar comes over the page, and a tap outside it has to close it —
        without that the only way back is the button, which is now behind the panel you opened.

        A named control rather than a decoration hidden from everything. It was `aria-hidden` with
        `tabIndex={-1}`, which `semantics.test.ts` refuses on the ground that taking something out of
        the tab order takes it away from the people who need it most: closing the menu is exactly the
        thing a keyboard user needs here. It is `display: none` unless the sidebar is open, so it costs
        nobody a tab stop the rest of the time.
      */}
      <button
        type="button"
        className="shell-scrim"
        onClick={() => {
          setOpen(false);
        }}
      >
        <span className="visually-hidden">{closeLabel}</span>
      </button>
    </div>
  );
}
