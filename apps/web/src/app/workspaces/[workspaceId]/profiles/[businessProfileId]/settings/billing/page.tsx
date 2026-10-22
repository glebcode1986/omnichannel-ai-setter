/**
 * Plan, usage and billing (#42, BILLING_ENTITLEMENTS.md, PRICING_PACKAGING.md).
 *
 * Under Settings rather than as an eighth navigation section, for the reason the audit log is: PRODUCT_UX
 * names seven sections and "settings — workspace, channels, AI policy, members, security/audit" is where
 * commercial state belongs. A new top-level section would be a decision about the product rather than
 * about this task.
 *
 * Workspace-scoped data inside a Business-Profile-shaped route. A subscription belongs to the workspace,
 * and a page that implied per-profile billing would be describing a product this is not — so the shell's
 * profile is what draws the frame and the workspace is what the money is read against.
 *
 * **Nothing here is authoritative except the server.** The only thing a checkout return parameter does is
 * choose a sentence; every number on the page is the server's answer at the instant it read, and the page
 * says when that was. A provider redirect claiming success shows the subscription as it actually is and
 * reports a confirmation as pending, because `BILLING_ENTITLEMENTS.md` is explicit that a browser return
 * URL never grants entitlement.
 */
import { AllowanceMeter } from "@/ui/billing/allowance-meter";
import { CapacityList } from "@/ui/billing/capacity-list";
import { PlanOffers } from "@/ui/billing/plan-offers";
import { SubscriptionCard } from "@/ui/billing/subscription-card";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { loadBillingPage } from "@/server/billing-page";
import { requestCancellationAction, resumeSubscriptionAction } from "@/server/billing-actions";
import type { RawSearchParams } from "@/server/inbox-view";
import { one } from "@/server/style-view";

export default async function BillingPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const query = await searchParams;
  const data = await loadBillingPage(workspaceId, businessProfileId, query);
  const { t } = data;
  const target = { workspaceId, businessProfileId };

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("billing.title")}</h1>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      {/* What the browser said, and nothing more. The state below is the server's. */}
      {data.checkoutReturn === undefined ? undefined : (
        <p className="notice" data-tone={data.checkoutReturn === "success" ? undefined : "stop"} data-checkout-return={data.checkoutReturn}>
          {data.checkoutReturn === "success" ? t.t("billing.checkoutPending") : t.t("billing.checkoutCancelled")}
        </p>
      )}

      <SubscriptionCard
        t={t}
        data={data}
        actions={{
          cancel: requestCancellationAction.bind(null, target),
          resume: resumeSubscriptionAction.bind(null, target),
        }}
      />

      <section className="card" data-billing="usage">
        <h2>{t.t("billing.usageTitle")}</h2>
        {data.overview.allowances.length === 0 ? (
          // Not a zero. "This plan includes none of this" and "you have used it all" are different
          // sentences with different things to do about them.
          <p className="muted" data-allowances="none">
            {t.t("billing.noAllowances")}
          </p>
        ) : (
          <ul className="billing-allowances">
            {data.overview.allowances.map((allowance) => (
              <AllowanceMeter key={allowance.metric} t={t} allowance={allowance} />
            ))}
          </ul>
        )}
      </section>

      <CapacityList t={t} capacity={data.overview.capacity} addOns={data.overview.addOns} />

      <PlanOffers t={t} offers={data.offers} checkoutAvailable={data.checkoutAvailable} checkoutPath={data.checkoutPath} />

      <p className="muted" data-read-at={data.overview.readAt.toISOString()}>
        <time dateTime={data.overview.readAt.toISOString()}>
          {t.t("billing.readAt", { when: t.date(data.overview.readAt, { dateStyle: "medium", timeStyle: "short" }) })}
        </time>
      </p>
    </div>
  );
}
