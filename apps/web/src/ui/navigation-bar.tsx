"use client";

/**
 * The navigation, wired to the router.
 *
 * A thin wrapper so `Navigation` itself stays a function of its props: it can be rendered in a test with
 * no router, and the "which link is current" decision has one home rather than being re-derived per link.
 */
import { usePathname } from "next/navigation";

import { Navigation } from "./navigation";

export function NavigationBar({ basePath }: { readonly basePath: string }) {
  return <Navigation basePath={basePath} currentPath={usePathname()} />;
}
