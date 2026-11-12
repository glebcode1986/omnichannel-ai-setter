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
 *
 * **It is also the first screen a customer sees after signing in**, which is what the frame below is for.
 * It used to be a heading, a bare sentence, an unframed list carrying its own inline `listStyle`/`margin`/
 * `padding`, and a form under a lone `h2` — on a product where every other screen is made of panels. It
 * also never said what a workspace *is*, to the one person who has never had one.
 */
import Link from "next/link";
import { listWorkspacesForUser } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import { getDb } from "@/server/db";
import { createWorkspaceAction } from "@/server/onboarding-actions";
import { pageSessionUserId } from "@/server/page-context";
import { one } from "@/server/knowledge-view";
import type { RawSearchParams } from "@/server/inbox-view";
import { CreateWorkspaceForm } from "@/ui/onboarding/create-workspace-form";
import { OutcomeNotice } from "@/ui/outcome-notice";

export default async function WorkspacesPage({ searchParams }: { readonly searchParams: Promise<RawSearchParams> }) {
  const userId = await pageSessionUserId();
  const query = await searchParams;
  const workspaces = await listWorkspacesForUser(getDb(), userId);
  const t = await requestTranslator();

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("workspaces.title")}</h1>
        <p className="muted">{t.t("workspaces.lead")}</p>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      <div className="page-sections">
        {workspaces.length === 0 ? (
          <section aria-labelledby="workspaces-empty" className="panel">
            {/* Not a bare sentence on the page background. Somebody arriving here for the first time has
                nothing else on screen, so this space is the explanation rather than a report of absence. */}
            <div className="empty-state">
              <p className="empty-state-title" id="workspaces-empty">
                {t.t("workspaces.empty")}
              </p>
              <p className="empty-state-body">{t.t("workspaces.emptyBody")}</p>
            </div>
          </section>
        ) : (
          <section aria-labelledby="workspaces-yours" className="panel">
            <h2 id="workspaces-yours">{t.t("workspaces.yours")}</h2>
            <ul className="card-grid">
              {workspaces.map((workspace) => (
                <li className="card" key={workspace.workspaceId}>
                  {/* `h3` under the section's `h2`: a card title is not a sibling of the heading above
                      the list it is in. It used to be an `h2` with its size written inline. */}
                  <h3>
                    <Link href={`/workspaces/${workspace.workspaceId}`}>{workspace.name}</Link>
                  </h3>
                  {/* Translated before interpolation. Lowercasing the enum localized the sentence and left
                      the role itself in English, which a Russian reader saw as "Ваша роль: owner". */}
                  <p className="muted">{t.t("workspaces.role", { role: t.t(`role.${workspace.role}`) })}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="workspaces-create" className="panel">
          <h2 id="workspaces-create">{t.t("onboarding.createWorkspaceTitle")}</h2>
          <p className="muted">{t.t("onboarding.createWorkspaceBody")}</p>
          <CreateWorkspaceForm t={t} action={createWorkspaceAction} />
        </section>
      </div>
    </main>
  );
}
