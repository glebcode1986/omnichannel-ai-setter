/**
 * Accepting the terms, before any payment page (#47, ADR-019).
 *
 * Its own route rather than a section of the billing page, because that is what the accepted architecture
 * asks for: an explicit acceptance step between choosing a plan and being handed to a provider. Folding
 * it into the billing page would put the checkboxes next to a usage meter and a cancellation button, and
 * the one thing this page has to do is be unmistakable about what is being agreed to.
 *
 * **Nothing on this page is authoritative.** The form posts the plan, the interval and the document ids;
 * the server re-resolves the route, the price and the *current* document versions inside the transaction
 * that writes the contract, and refuses anything that moved while this page was open. So a stale tab
 * produces a sentence, not a purchase.
 */
import { CheckoutActions } from "@/ui/checkout/checkout-actions-pane";
import { CheckoutSummary } from "@/ui/checkout/checkout-summary";
import { TermsAcceptance } from "@/ui/checkout/terms-acceptance";
import { loadCheckoutPage } from "@/server/checkout-page";
import { CHECKOUT_REFUSAL_MESSAGES } from "@/server/checkout-screen";
import { acceptTermsAndOpenCheckoutAction } from "@/server/checkout-actions";
import type { RawSearchParams } from "@/server/inbox-view";

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const data = await loadCheckoutPage(workspaceId, businessProfileId, await searchParams);
  const { t } = data;
  const target = { workspaceId, businessProfileId };

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("checkout.title")}</h1>
        <a className="button" href={data.billingPath} data-action="back-to-billing">
          {t.t("checkout.back")}
        </a>
      </div>

      {data.refusal === undefined ? undefined : (
        // Why there is nothing to accept. The message comes from a total map over the store's own refusal
        // union, so a reason added later is a type error rather than a blank notice.
        <p className="notice" data-tone="stop" data-checkout-refusal={data.refusal.reason}>
          {t.t(CHECKOUT_REFUSAL_MESSAGES[data.refusal.reason])}
        </p>
      )}

      {data.canManage ? undefined : (
        <p className="muted" data-restricted="true">
          {t.t("checkout.ownerOnly")}
        </p>
      )}

      {data.offer === undefined || !data.canManage ? undefined : (
        <>
          <CheckoutSummary t={t} offer={data.offer} {...(data.plan === undefined ? {} : { plan: data.plan })} />

          <form action={acceptTermsAndOpenCheckoutAction.bind(null, target)} className="stack" data-checkout="form">
            <input type="hidden" name="plan" value={data.selection.planVersionId} />
            <input type="hidden" name="interval" value={data.selection.interval} />
            {/* Which commercial offer this page actually displayed — the selling entity, its
                jurisdiction, who remits the tax, the commitment and the price — as one opaque value.
                The server recomputes it from its own fresh resolution inside the opening transaction and
                refuses `OFFER_CHANGED` if the two differ, so an acceptance can never be recorded against
                terms somebody was not shown. It names nothing the client is allowed to choose. */}
            <input type="hidden" name="offer" value={data.offer.offerDigest} />
            {/* Which ticks this page actually rendered. It is how the server tells "you left one
                unticked" from "a requirement appeared while you were reading" — the second of which is
                not the reader's fault and must not be reported as one. It can only ever shrink the set
                the server enforces, never widen it. */}
            {data.required.map((document) => (
              <input key={document.legalDocumentId} type="hidden" name="offered" value={document.legalDocumentId} />
            ))}

            <TermsAcceptance
              t={t}
              required={data.required}
              linked={data.linked}
              viewerLocale={data.offer.viewerLocale}
              providerIsSeller={data.providerIsSeller}
              sellerLegalName={data.offer.seller.legalName}
            />

            <CheckoutActions t={t} checkoutReady={data.offer.checkoutReady} />
          </form>
        </>
      )}
    </div>
  );
}
