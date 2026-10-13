/**
 * The other plans, each with what moving to it would cost (#42).
 *
 * The consequences are rendered beside the offer rather than behind a confirmation step, because the
 * accepted downgrade behaviour is that the person is shown what exceeds the new limits and *chooses* what
 * stays active. A warning that only appears after the click is a warning nobody was given.
 *
 * No action is offered while this deployment has no provider. `BILLING_ENTITLEMENTS.md` is explicit that
 * an upgrade becomes effective only after authoritative server-side confirmation that money moved, so a
 * button that could not produce one would be a button that lies.
 */
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { PlanOffer } from "@/server/billing-screen";

import { formatPrice } from "./money";

export function PlanOffers({
  t,
  offers,
  checkoutAvailable,
}: {
  readonly t: Translator;
  readonly offers: readonly PlanOffer[];
  readonly checkoutAvailable: boolean;
}) {
  return (
    <section className="card" data-billing="offers">
      <h2>{t.t("billing.offersTitle")}</h2>

      {checkoutAvailable ? undefined : (
        <p className="muted" data-checkout="unavailable">
          {t.t("billing.checkoutUnavailable")}
        </p>
      )}

      <ul className="billing-offers">
        {offers.map((offer) => (
          <li key={offer.planVersionId} data-offer={offer.code} data-current={offer.current}>
            <h3>{offer.name}</h3>
            <ul>
              {offer.prices.map((price) => (
                <li key={`${price.currency}-${price.interval}`} data-price={price.interval}>
                  {t.t(`billing.pricePer.${price.interval}` as MessageKey, { amount: formatPrice(t, price.amountCents, price.currency) })}
                </li>
              ))}
            </ul>

            {offer.current ? (
              <p className="muted" data-offer-state="current">
                {t.t("billing.currentOffer")}
              </p>
            ) : offer.consequences.clean ? (
              <p className="muted" data-offer-state="clean">
                {t.t("billing.offerClean")}
              </p>
            ) : (
              <>
                <ul className="billing-consequences" data-offer-state="consequences">
                  {offer.consequences.overCapacity.map((excess) => (
                    <li key={excess.limit} data-consequence={excess.limit}>
                      {t.t("billing.offerOverCapacity", {
                        inUse: t.number(excess.inUse),
                        limit: t.t(`planLimit.${excess.limit}` as MessageKey),
                        ceiling: t.number(excess.ceiling),
                      })}
                    </li>
                  ))}
                  {offer.consequences.losingFeatures.map((feature) => (
                    <li key={feature} data-consequence={feature}>
                      {t.t("billing.offerLosingFeature", { feature: t.t(`feature.${feature}` as MessageKey) })}
                    </li>
                  ))}
                </ul>
                {/* Said once, beside the list: nothing is deleted, and the choice is theirs. */}
                <p className="muted">{t.t("billing.offerExplains")}</p>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
