/**
 * Business Profile selection inside one workspace, and where the first profile is created
 * (DATA_MODEL.md v0.4, #115).
 *
 * `readWorkspaceOnboarding` returns only the profiles this membership covers — a SELECTED-scope member
 * sees their grants and not the workspace's whole list — so the page renders what it is given rather than
 * deciding visibility itself. It also answers the two questions a newly created workspace is actually
 * asking, which this page used not to answer anywhere: is anything connected, and has the trial started.
 *
 * The creation control is drawn from `mayWriteWorkspaceWide`, the same predicate the store's own guard is
 * implemented on. That is a courtesy and not the boundary: `createBusinessProfileAction` re-resolves the
 * role from the database on every call, so a constructed request is refused whether or not a button was
 * ever rendered.
 */
import Link from "next/link";
import { mayWriteWorkspaceWide, readWorkspaceOnboarding } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import { getDb } from "@/server/db";
import { createBusinessProfileAction } from "@/server/onboarding-actions";
import { requireWorkspaceContext } from "@/server/request-context";
import { one } from "@/server/knowledge-view";
import type { RawSearchParams } from "@/server/inbox-view";
import { CreateProfileForm } from "@/ui/onboarding/create-profile-form";
import { WorkspaceEntry } from "@/ui/onboarding/workspace-entry";
import { OutcomeNotice } from "@/ui/outcome-notice";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const context = await requireWorkspaceContext(workspaceId);
  const state = await readWorkspaceOnboarding(getDb(), context);
  const t = await requestTranslator();

  // Bound to the Workspace the route named and the request authorized, so the form cannot carry a
  // different one: the action's first argument is supplied here, not by the submission.
  const createProfile = createBusinessProfileAction.bind(null, workspaceId);

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("workspaces.profilesTitle")}</h1>
        <Link href="/workspaces">{t.t("workspaces.title")}</Link>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      <WorkspaceEntry t={t} workspaceId={workspaceId} state={state} />

      <section>
        <h2>{t.t("onboarding.createProfileTitle")}</h2>
        <CreateProfileForm t={t} action={createProfile} allowed={mayWriteWorkspaceWide(context)} />
      </section>
    </main>
  );
}
