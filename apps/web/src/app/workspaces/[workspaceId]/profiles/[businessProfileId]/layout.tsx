/**
 * The authenticated workspace shell (PRODUCT_UX.md, Issue #27).
 *
 * The Workspace and the Business Profile are named by the route and authorized on every request. There is
 * no remembered "current" workspace and no default profile: ADR-009 is explicit that the session proves
 * who you are and nothing about what you may see, and a shell that carried a profile in a cookie would be
 * the first place that stopped being true.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { NavigationBar } from "@/ui/navigation-bar";
import { shellText } from "@/ui/labels";
import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";

export default async function ProfileShellLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  // Throws when the viewer is not a member, or the profile is not theirs to see. The shell renders
  // nothing at all in that case, rather than a frame around an authorization error.
  await requireBusinessProfileContext(workspaceId, businessProfileId);

  const [workspace, profile] = await Promise.all([
    getDb().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
    getDb().businessProfile.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: businessProfileId } },
      select: { name: true, status: true },
    }),
  ]);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;

  return (
    <div className="shell">
      {/* A real in-page anchor, not a router link: it moves focus within this document. */}
      <a className="skip-link" href="#shell-content">
        {shellText.skipToContent}
      </a>
      <nav className="shell-nav" aria-label={shellText.navigationLabel}>
        <div className="workspace-switch">
          <span className="muted">{shellText.workspaceLabel}</span>
          <strong>{workspace.name}</strong>
          <span className="muted">{profile.name}</span>
          <Link href="/workspaces">{shellText.switchWorkspace}</Link>
        </div>
        <NavigationBar basePath={basePath} />
        {profile.status === "SETUP" ? <Link href={`${basePath}/setup`}>{shellText.setupLink}</Link> : undefined}
      </nav>
      <main className="shell-main" id="shell-content">
        {children}
      </main>
    </div>
  );
}
