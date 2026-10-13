/**
 * The explicit acceptance control (#47, ADR-019).
 *
 * One tick per document version, and none of them pre-ticked. That is the whole requirement and it is
 * worth saying why the obvious shortcuts are wrong:
 *
 * - **One box for everything** would record a single consent against several documents, so an acceptance
 *   record could not say which version of which document anybody agreed to.
 * - **A pre-ticked box** is not consent. `defaultChecked` is absent here deliberately, and a reviewer
 *   should treat its appearance as a defect rather than a convenience.
 * - **A disabled submit button** is a courtesy, not a gate. The server refuses a submission with a box
 *   unticked whatever this renders, which is why the button is not disabled at all: a form that cannot be
 *   submitted cannot be refused, and a person who ticked nothing deserves a sentence rather than a dead
 *   button they have to guess about.
 *
 * Each label wraps its own input, which is also what the accessibility gate requires: a `htmlFor` built
 * from an id would be dynamic, and `semantics.test.ts` matches only a double-quoted literal.
 *
 * The version and the language are rendered beside every link because they are the evidence. "You
 * accepted the Public Offer" is not a record of anything; "Public Offer v3, in English" is.
 */
import type { LegalDocumentOffer } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export function TermsAcceptance({
  t,
  required,
  linked,
  viewerLocale,
  providerIsSeller,
  sellerLegalName,
}: {
  readonly t: Translator;
  readonly required: readonly LegalDocumentOffer[];
  readonly linked: readonly LegalDocumentOffer[];
  readonly viewerLocale: string;
  readonly providerIsSeller: boolean;
  readonly sellerLegalName: string;
}) {
  return (
    <section className="card" data-checkout="terms">
      <h2>{t.t("checkout.termsTitle")}</h2>
      <p className="muted">{t.t("checkout.termsExplains")}</p>

      {providerIsSeller ? (
        // A Merchant of Record is the seller to the customer: its invoice, its tax, and its own terms
        // additionally apply at its hosted checkout. Said here rather than left to be discovered there.
        <p className="notice" data-checkout="provider-terms">
          {t.t("checkout.providerAlsoApplies", { seller: sellerLegalName })}
        </p>
      ) : undefined}

      {required.length === 0 ? (
        // Not a blank space. "Nothing to accept" and "the acceptance control failed to render" look
        // identical to a reader, and only one of them is a product state.
        <p className="muted" data-accept="none">
          {t.t("checkout.noTermsRequired")}
        </p>
      ) : (
        <ul className="checkout-terms">
          {required.map((document) => (
            <li key={document.legalDocumentId} data-accept={document.kind}>
              <label className="checkbox">
                <input type="checkbox" name="accept" value={document.legalDocumentId} />
                {t.t("checkout.acceptDocument", {
                  document: t.t(`legalDocument.${document.kind}` as MessageKey),
                  version: t.number(document.version),
                })}
              </label>
              <a href={document.contentRef} target="_blank" rel="noreferrer noopener" data-document-link={document.kind}>
                {t.t("checkout.readDocument")}
              </a>
              {document.inViewerLanguage ? undefined : (
                // The product has no translation. Worth saying out loud: somebody is about to agree to
                // something in a language they may not read, and the acceptance records that too.
                <p className="muted" data-document-language="fallback">
                  {t.t("checkout.documentNotTranslated", { locale: document.locale })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {linked.length === 0 ? undefined : (
        <>
          <h3>{t.t("checkout.policiesTitle")}</h3>
          <ul className="checkout-policies">
            {linked.map((document) => (
              <li key={document.legalDocumentId} data-policy={document.kind}>
                <a href={document.contentRef} target="_blank" rel="noreferrer noopener" data-document-link={document.kind}>
                  {t.t("checkout.policyLink", {
                    document: t.t(`legalDocument.${document.kind}` as MessageKey),
                    version: t.number(document.version),
                  })}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="muted" data-viewer-locale={viewerLocale}>
        {t.t("checkout.acceptanceRecorded")}
      </p>
    </section>
  );
}
