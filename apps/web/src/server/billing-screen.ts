/**
 * What the billing screen shows, assembled where a test can drive it (#42).
 *
 * Free of the authenticated request path on purpose, exactly like `style-screen.ts`: `billing-page.ts`
 * adds the authorization and the translator, and it cannot be imported under Vitest because Auth.js
 * reaches for Next's server runtime. Everything a test needs to assert lives on this side of that line.
 *
 * Two properties this file exists to hold:
 *
 * **The browser is never the authority.** A checkout return parameter is read, and all it does is decide
 * which sentence to show. The plan, the state and the dates are the server's answer at `at` — so a page
 * reached with `?checkout=success` after a payment the webhook has not confirmed shows the subscription as
 * it actually is, and says a confirmation is pending rather than claiming an upgrade.
 *
 * **A downgrade is explained before it is offered.** The accepted behaviour is that nothing is deleted and
 * the person is shown which of their resources exceed the new plan, so every offer carries its own
 * consequences rather than a yes or no.
 */
import { billingProviderRegistered, readBillingOverview, readBillingRoutes, type BillingOverview, type DbClient, type WorkspaceContext } from "@omnichannel/db";
import { planChangeConsequences, type PlanChangeConsequences } from "@omnichannel/domain";

import type { RawSearchParams } from "@/server/inbox-view";
import { one } from "@/server/style-view";

/**
 * Whether this deployment can start a checkout (#47; was a constant `false` in #42).
 *
 * Derived rather than hard-coded, and the change matters more than it looks. A constant meant the whole
 * acceptance surface was unreachable no matter how a deployment was configured, and the day an adapter
 * landed somebody would have had to remember to edit this file — which is the shape of every capability
 * this codebase has shipped and never called.
 *
 * True when at least one enabled route's provider has an adapter registered in *this* process, which is
 * the process that would hand the customer to it. Until #41 chooses a provider nothing is registered and
 * this is false on its own, with no constant to maintain.
 */
export async function checkoutAvailable(db: DbClient): Promise<boolean> {
  const routes = await readBillingRoutes(db, { enabledOnly: true });
  const configured = await db.billingRoute.findMany({ where: { enabled: true }, select: { code: true, provider: true } });
  const providers = new Map(configured.map((route) => [route.code, route.provider]));
  return routes.some((route) => {
    const provider = providers.get(route.code);
    return provider !== undefined && billingProviderRegistered(provider);
  });
}

/** What the browser claims happened at a provider. Never trusted; only used to choose a sentence. */
export type CheckoutReturn = "success" | "cancelled";

const CHECKOUT_RETURNS: readonly string[] = ["success", "cancelled"];

export interface PlanOffer {
  readonly planVersionId: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly prices: BillingOverview["offers"][number]["prices"];
  readonly current: boolean;
  /**
   * What switching to this plan would cost the workspace as it stands.
   *
   * Carried per offer rather than computed when somebody clicks, because the point is that they read it
   * *before* deciding — and a consequence that only appears after the click is a consequence nobody was
   * warned about.
   */
  readonly consequences: PlanChangeConsequences;
}

export interface BillingScreenData {
  readonly overview: BillingOverview;
  readonly offers: readonly PlanOffer[];
  /** True for an OWNER. Billing mutations are the owner's, and the server refuses anyone else anyway. */
  readonly canManage: boolean;
  readonly checkoutAvailable: boolean;
  /**
   * What the browser said on its way back from a provider, where it said anything recognisable.
   *
   * Recognised values only: a query parameter is attacker-controlled, and echoing an unknown one would be
   * rendering a stranger's text inside the shell.
   */
  readonly checkoutReturn?: CheckoutReturn;
  readonly basePath: string;
  /** Where the acceptance step lives, so the offers can link to it rather than rebuild the path (#47). */
  readonly checkoutPath: string;
}

export async function assembleBillingScreen(
  db: DbClient,
  context: WorkspaceContext,
  searchParams: RawSearchParams,
  basePath: string,
  at = new Date(),
): Promise<BillingScreenData> {
  const [overview, available] = await Promise.all([readBillingOverview(db, context.workspaceId, at), checkoutAvailable(db)]);
  const returned = one(searchParams["checkout"]);

  return {
    overview,
    offers: overview.offers.map((offer) => ({
      planVersionId: offer.planVersionId,
      code: offer.code,
      name: offer.name,
      version: offer.version,
      prices: offer.prices,
      current: offer.current,
      consequences: planChangeConsequences({
        target: { limits: offer.limits, features: offer.features },
        inUse: Object.fromEntries(overview.capacity.map((entry) => [entry.limit, entry.inUse])),
        featuresInUse: overview.entitlement.features,
      }),
    })),
    // The role decides what is *offered*, never what is permitted: the store refuses an admin whatever
    // this says, so a wrong answer here is a confusing screen rather than a security hole.
    canManage: context.role === "OWNER",
    checkoutAvailable: available,
    checkoutPath: `${basePath}/checkout`,
    ...(returned !== undefined && CHECKOUT_RETURNS.includes(returned) ? { checkoutReturn: returned as CheckoutReturn } : {}),
    basePath,
  };
}
