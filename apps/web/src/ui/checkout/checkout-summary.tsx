/**
 * Who is selling, at what price, and who owes the tax (#47, ADR-019).
 *
 * The seller is the legal entity rather than the product's brand, and that is not a formality: on a
 * Merchant-of-Record route the company the customer is contracting with is the provider, not us, and the
 * invoice they will receive says so. A checkout page that showed only the product name would be hiding
 * the one fact a public offer exists to state.
 *
 * Who remits the tax is shown for the same reason. "Tax is included and remitted by the seller of record"
 * and "you may be charged tax at checkout" are different promises, and which one applies is a property of
 * the route the server chose — not something a page may assume.
 *
 * Nothing provider-shaped appears here. The route's own code, the provider's name and its account
 * reference are deliberately not in `CheckoutOffer`, and `no-provider-payloads.test.ts` fails the build
 * if one of them turns up in this directory.
 */
import type { CheckoutOffer } from "@omnichannel/db";

import { formatPrice } from "@/ui/billing/money";
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export function CheckoutSummary({
  t,
  offer,
  plan,
}: {
  readonly t: Translator;
  readonly offer: CheckoutOffer;
  readonly plan?: { readonly code: string; readonly name: string; readonly version: number };
}) {
  return (
    <section className="card" data-checkout="summary">
      <h2>{t.t("checkout.summaryTitle")}</h2>

      <dl className="checkout-summary">
        {plan === undefined ? undefined : (
          <>
            <dt>{t.t("checkout.plan")}</dt>
            <dd data-summary="plan">{plan.name}</dd>
          </>
        )}

        <dt>{t.t("checkout.price")}</dt>
        <dd data-summary="price">
          {t.t(`billing.pricePer.${offer.interval}` as MessageKey, { amount: formatPrice(t, offer.base.amountMinor, offer.base.currency) })}
        </dd>

        <dt>{t.t("checkout.seller")}</dt>
        {/* The registered name and the jurisdiction, because that pair is what identifies a seller. */}
        <dd data-summary="seller">{offer.seller.legalName}</dd>

        <dt>{t.t("checkout.jurisdiction")}</dt>
        {/* The country's name in the reader's own language, not the two-letter code: `RO` is a code a
            form would recognise and a person would not. */}
        <dd data-summary="jurisdiction" data-jurisdiction={offer.seller.jurisdiction}>
          {t.region(offer.seller.jurisdiction)}
        </dd>

        <dt>{t.t("checkout.support")}</dt>
        <dd data-summary="support">
          <a href={`mailto:${offer.seller.supportEmail}`}>{offer.seller.supportEmail}</a>
        </dd>

        <dt>{t.t("checkout.tax")}</dt>
        <dd data-summary="tax" data-tax-remitted-by={offer.taxRemittedBy}>
          {offer.taxRemittedBy === "PROVIDER" ? t.t("checkout.taxByProvider") : t.t("checkout.taxBySeller")}
        </dd>

        <dt>{t.t("checkout.renewal")}</dt>
        {/* A prepaid term buys service until a stated date and renews nothing. The difference decides
            whether somebody has to come back, so it belongs on the page they commit from. */}
        <dd data-summary="renewal" data-arrangement={offer.arrangement}>
          {offer.arrangement === "RECURRING" ? t.t("checkout.renewsAutomatically") : t.t("checkout.prepaidTerm")}
        </dd>
      </dl>
    </section>
  );
}
