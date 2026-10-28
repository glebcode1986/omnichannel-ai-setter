/**
 * Workspace selection, and the only place a workspace can be created (Issue #27, #115).
 *
 * The list comes from membership, so it is already the set this person may see; there is nothing to filter
 * client-side and nothing to guess. A person with one workspace still gets the page rather than a silent
 * redirect: "which business am I in" is a question the product should keep answering out loud, and an
 * automatic jump makes a second workspace appear out of nowhere the day one is added.
 *
 * The creation form is here rather than on a route of its own, deliberately. A `/workspaces/new` page
 * could name no workspace and could therefore reach none of the three context resolvers, so it would have
 * had to be added to the route-authorization allowlist — a page exempted from the app's one authorization
 * rule, in order to host its most consequential write. This page is already the exception, for the reason
 * the allowlist states, and the write below is authorized by the session the same way the list is.
 */
import Link from "next/link";
import { listWorkspacesForUser } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import { getDb } from "@/server/db";
import { createWorkspaceAction } from "@/server/onboarding-actions";
import { requireSessionUserId } from "@/server/request-context";
import { one } from "@/server/knowledge-view";
import type { RawSearchParams } from "@/server/inbox-view";
import { CreateWorkspaceForm } from "@/ui/onboarding/create-workspace-form";
import { OutcomeNotice } from "@/ui/outcome-notice";

export default async function WorkspacesPage({ searchParams }: { readonly searchParams: Promise<RawSearchParams> }) {
  const userId = await requireSessionUserId();
  const query = await searchParams;
  const workspaces = await listWorkspacesForUser(getDb(), userId);
  const t = await requestTranslator();

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("workspaces.title")}</h1>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      {workspaces.length === 0 ? <p>{t.t("workspaces.empty")}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {workspaces.map((workspace) => (
          <li className="card" key={workspace.workspaceId}>
            <h2 style={{ margin: "0 0 4px", fontSize: "1.1rem" }}>
              <Link href={`/workspaces/${workspace.workspaceId}`}>{workspace.name}</Link>
            </h2>
            {/* Translated before interpolation. Lowercasing the enum localized the sentence and left the
                role itself in English, which a Russian reader saw as "Ваша роль: owner". */}
            <p className="muted">{t.t("workspaces.role", { role: t.t(`role.${workspace.role}`) })}</p>
          </li>
        ))}
      </ul>

      <section>
        <h2>{t.t("onboarding.createWorkspaceTitle")}</h2>
        <CreateWorkspaceForm t={t} action={createWorkspaceAction} />
      </section>
    </main>
  );
}
