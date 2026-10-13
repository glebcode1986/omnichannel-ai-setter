/**
 * Authorization and the translator around the checkout screen's own assembly (#47).
 *
 * The split is `billing-page.ts`'s: this module imports the authenticated request path, which cannot be
 * loaded under Vitest, so everything a test needs to drive lives in `checkout-screen.ts`.
 *
 * **Two contexts, deliberately**, for the reason the billing page gives: the route sits inside the
 * Business Profile shell while the money belongs to the workspace, and the commercial readers take a bare
 * workspace id and perform no authorization of their own.
 *
 * The reader's own locale is passed in rather than read inside the screen, because it is the thing that
 * decides which language the terms are offered in — and the acceptance records it. A screen that fetched
 * it for itself would be a second place that could disagree with what the action later writes.
 */
import { requestLocale, requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { assembleCheckoutScreen, type CheckoutScreenData } from "@/server/checkout-screen";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { requireBusinessProfileContext, requireWorkspaceContext } from "@/server/request-context";

export interface CheckoutPageData extends CheckoutScreenData {
  readonly t: Translator;
}

export async function loadCheckoutPage(workspaceId: string, businessProfileId: string, searchParams: RawSearchParams): Promise<CheckoutPageData> {
  await requireBusinessProfileContext(workspaceId, businessProfileId);
  const context = await requireWorkspaceContext(workspaceId);
  const [t, locale] = await Promise.all([requestTranslator(), requestLocale()]);

  return {
    t,
    ...(await assembleCheckoutScreen(
      getDb(),
      context,
      searchParams,
      `/workspaces/${workspaceId}/profiles/${businessProfileId}/settings/billing/checkout`,
      locale,
    )),
  };
}
