/**
 * What the business is on, and what is about to happen to it (#42).
 *
 * The state is the server's answer, not the browser's. A page reached from a provider with
 * `?checkout=success` shows the subscription exactly as it is — `BILLING_ENTITLEMENTS.md` is explicit that
 * a browser return URL never grants entitlement — and says a confirmation is pending rather than claiming
 * an upgrade nobody has confirmed.
 *
 * Starts at `<h2>`: the route owns the page's `<h1>`, and a component that began at `<h3>` would fail the
 * heading-order check on its own file even though the page was correct.
 */
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { BillingScreenData } from "@/server/billing-screen";

import { formatPrice } from "./money";

export interface SubscriptionCardProps {
  readonly t: Translator;
  readonly data: BillingScreenData;
  readonly actions?: {
    readonly cancel: () => Promise<void>;
    readonly resume: () => Promise<void>;
  };
}

export function SubscriptionCard({ t, data, actions }: SubscriptionCardProps) {
  const subscription = data.overview.subscription;

  return (
    <section className="card" data-billing="subscription">
      <h2>{t.t("billing.planTitle")}</h2>

      {subscription === undefined ? (
        // Pre-trial is not the same as lapsed. A workspace that has never subscribed must not be told its
        // subscription ended.
        <p className="muted" data-plan="none">
          {t.t("billing.noPlan")}
        </p>
      ) : (
        <>
          <p data-plan={subscription.planCode}>
            <strong>{subscription.planName}</strong>{" "}
            <span className="badge" data-tone="muted" data-plan-version={subscription.planVersion}>
              {t.t("billing.versionLabel", { version: subscription.planVersion })}
            </span>{" "}
            <span className="badge" data-tone={data.overview.access.paidWorkAllowed ? "ok" : "stop"} data-state={subscription.state}>
              {t.t(`subscriptionState.${subscription.state}` as MessageKey)}
            </span>
          </p>

          <ul className="billing-prices">
            {subscription.prices.map((price) => (
              <li key={`${price.currency}-${price.interval}`} data-price={price.interval}>
                {t.t(`billing.pricePer.${price.interval}` as MessageKey, { amount: formatPrice(t, price.amountCents, price.currency) })}
              </li>
            ))}
          </ul>

          {/* Each date is a different promise, so each gets its own sentence rather than one "ends at". */}
          {subscription.trialEndsAt === undefined ? undefined : (
            <p className="muted" data-date="trial">
              <time dateTime={subscription.trialEndsAt.toISOString()}>
                {t.t("billing.trialEnds", { when: t.date(subscription.trialEndsAt, { dateStyle: "medium" }) })}
              </time>
            </p>
          )}
          {subscription.graceStartedAt === undefined ? undefined : (
            <p className="notice" data-tone="stop" data-date="grace">
              <time dateTime={subscription.graceStartedAt.toISOString()}>
                {t.t("billing.graceSince", { when: t.date(subscription.graceStartedAt, { dateStyle: "medium" }) })}
              </time>
            </p>
          )}
          {subscription.canceledAt === undefined || subscription.periodEndsAt === undefined ? undefined : (
            <p className="notice" data-tone="stop" data-date="canceling">
              <time dateTime={subscription.periodEndsAt.toISOString()}>
                {t.t("billing.endsOn", { when: t.date(subscription.periodEndsAt, { dateStyle: "medium" }) })}
              </time>
            </p>
          )}
          {subscription.canceledAt === undefined && subscription.periodEndsAt !== undefined ? (
            <p className="muted" data-date="renews">
              <time dateTime={subscription.periodEndsAt.toISOString()}>
                {t.t("billing.renewsOn", { when: t.date(subscription.periodEndsAt, { dateStyle: "medium" }) })}
              </time>
            </p>
          ) : undefined}
        </>
      )}

      {/* Said whether or not the person may act on it: an admin who cannot see why the buttons are absent
          would assume the product is broken rather than that it is not theirs to do. */}
      {data.canManage ? undefined : (
        <p className="muted" data-restricted="true">
          {t.t("billing.ownerOnly")}
        </p>
      )}

      {actions === undefined || !data.canManage || subscription === undefined ? undefined : (
        <div className="control-row">
          {subscription.canceledAt === undefined ? (
            <form action={actions.cancel}>
              <button className="button" type="submit" data-action="cancel-subscription">
                {t.t("billing.cancel")}
              </button>
            </form>
          ) : (
            <form action={actions.resume}>
              <button className="button primary" type="submit" data-action="resume-subscription">
                {t.t("billing.resume")}
              </button>
            </form>
          )}
        </div>
      )}

      {/* The consequence, before the act rather than after it. */}
      {data.canManage && subscription !== undefined && subscription.canceledAt === undefined ? (
        <p className="muted" data-consequence="cancel">
          {t.t("billing.cancelExplains")}
        </p>
      ) : undefined}
    </section>
  );
}
