/**
 * Authorization and the translator around the billing screen's own assembly (#42).
 *
 * The split is the one `style-page.ts` learned: this module imports the authenticated request path, which
 * cannot be loaded under Vitest, so everything a test needs to drive lives in `billing-screen.ts`.
 *
 * **Two contexts, deliberately.** The route sits inside the Business Profile shell — `PRODUCT_UX.md` names
 * seven sections and billing is not an eighth, so it lives under Settings exactly as the audit log does —
 * while the data it shows belongs to the workspace. The profile context is what the shell already
 * authorized; the workspace context is what the commercial readers must be scoped by, because they take a
 * bare workspace id and perform no authorization of their own.
 */
import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { assembleBillingScreen, type BillingScreenData } from "@/server/billing-screen";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { requireBusinessProfileContext, requireWorkspaceContext } from "@/server/request-context";

export interface BillingPageData extends BillingScreenData {
  readonly t: Translator;
}

export async function loadBillingPage(
  workspaceId: string,
  businessProfileId: string,
  searchParams: RawSearchParams,
): Promise<BillingPageData> {
  // The profile the shell is drawn around, and the workspace the money belongs to. Both are authorized
  // before any commercial state is read: the readers below take a workspace id and would happily answer
  // for one the viewer has nothing to do with.
  await requireBusinessProfileContext(workspaceId, businessProfileId);
  const context = await requireWorkspaceContext(workspaceId);
  const t = await requestTranslator();

  return {
    t,
    ...(await assembleBillingScreen(
      getDb(),
      context,
      searchParams,
      `/workspaces/${workspaceId}/profiles/${businessProfileId}/settings/billing`,
    )),
  };
}
