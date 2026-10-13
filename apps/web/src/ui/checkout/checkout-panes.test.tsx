// @vitest-environment jsdom
/**
 * The acceptance control, and the three things it must never do (#47, ADR-019).
 *
 * Most of these assert an absence, because every way this surface goes wrong is something being there
 * that should not be: a pre-ticked box, a single box standing for several documents, a link to a document
 * nobody can open, a submit control for a checkout nothing could settle, and a label that tells a Russian
 * reader "PUBLIC_OFFER".
 *
 * The enforcement itself is not here and cannot be: a pane proves what is rendered, never what a
 * submission is refused for. That is `checkout-screen.integration.test.ts` and the store's own suite.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckoutOffer, LegalDocumentOffer } from "@omnichannel/db";

import { CheckoutActions } from "./checkout-actions-pane";
import { CheckoutSummary } from "./checkout-summary";
import { TermsAcceptance } from "./terms-acceptance";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const ru = createTranslator("ru");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const document_ = (overrides: Partial<LegalDocumentOffer> = {}): LegalDocumentOffer => ({
  legalDocumentId: "doc-1",
  kind: "PUBLIC_OFFER",
  version: 3,
  locale: "en",
  contentRef: "https://legal.example.test/offer/en/3",
  requiredForCheckout: true,
  inViewerLanguage: true,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const offer = (overrides: Partial<CheckoutOffer> = {}): CheckoutOffer => ({
  available: true,
  seller: { legalName: "Example SRL", displayName: "Example", jurisdiction: "RO", supportEmail: "billing@example.test" },
  settlementModel: "DIRECT_PSP",
  taxRemittedBy: "SELLER",
  arrangement: "RECURRING",
  interval: "MONTH",
  base: { amountMinor: 4_900, currency: "EUR" },
  documents: [document_()],
  viewerLocale: "en",
  checkoutReady: true,
  ...overrides,
});

describe("the acceptance control", () => {
  it("gives every required document its own tick, and ticks none of them", () => {
    render(
      <TermsAcceptance
        t={t}
        required={[document_(), document_({ legalDocumentId: "doc-2", kind: "TERMS_OF_SERVICE", version: 1 })]}
        linked={[]}
        viewerLocale="en"
        providerIsSeller={false}
        sellerLegalName="Example SRL"
      />,
    );

    const boxes = [...global.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="accept"]')];
    expect(boxes.map((box) => box.value)).toEqual(["doc-1", "doc-2"]);
    // A pre-ticked box is not consent. Its appearance here is a defect, not a convenience.
    expect(boxes.filter((box) => box.checked)).toEqual([]);
    expect(boxes.filter((box) => box.hasAttribute("checked"))).toEqual([]);
  });

  it("names the document and its version, through the catalogue in both languages", () => {
    render(<TermsAcceptance t={ru} required={[document_()]} linked={[]} viewerLocale="ru" providerIsSeller={false} sellerLegalName="Example SRL" />);

    const label = global.document.querySelector('[data-accept="PUBLIC_OFFER"]')?.textContent ?? "";
    // The i18n gate reports only string literals, so `{document.kind}` would have shipped
    // "PUBLIC_OFFER" to a Russian reader and kept the build green. The version is in the sentence
    // because "you accepted the Public Offer" is not a record of anything.
    expect(label).toContain(catalogues.ru["legalDocument.PUBLIC_OFFER"]);
    expect(label).not.toContain("PUBLIC_OFFER:");
    expect(label).toContain("3");
  });

  it("links every document at an address somebody could actually open", () => {
    render(
      <TermsAcceptance
        t={t}
        required={[document_()]}
        linked={[document_({ legalDocumentId: "doc-3", kind: "REFUND_POLICY", requiredForCheckout: false })]}
        viewerLocale="en"
        providerIsSeller={false}
        sellerLegalName="Example SRL"
      />,
    );

    const links = [...global.document.querySelectorAll<HTMLAnchorElement>("[data-document-link]")];
    expect(links.length).toBe(2);
    for (const link of links) {
      // A relative path would resolve against this route and 404 — which is a checkbox asking for
      // consent to something unreadable. The store refuses a non-URL on the way in; this is the other end.
      expect(new URL(link.getAttribute("href") ?? "").protocol).toBe("https:");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }
  });

  it("offers a policy as a link and never as a tick", () => {
    render(
      <TermsAcceptance
        t={t}
        required={[]}
        linked={[document_({ legalDocumentId: "doc-3", kind: "PRIVACY_POLICY", requiredForCheckout: false })]}
        viewerLocale="en"
        providerIsSeller={false}
        sellerLegalName="Example SRL"
      />,
    );

    expect(global.document.querySelector('[data-policy="PRIVACY_POLICY"]')).not.toBeNull();
    expect(global.document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    // And it says there is nothing to accept rather than leaving a blank space, because a blank space
    // and a broken acceptance control look identical.
    expect(global.document.querySelector('[data-accept="none"]')?.textContent).toBe(text("checkout.noTermsRequired"));
  });

  it("says when a document is only published in a language the reader may not read", () => {
    render(
      <TermsAcceptance
        t={t}
        required={[document_({ locale: "en", inViewerLanguage: false })]}
        linked={[]}
        viewerLocale="ru"
        providerIsSeller={false}
        sellerLegalName="Example SRL"
      />,
    );

    expect(global.document.querySelector('[data-document-language="fallback"]')?.textContent).toContain("en");
  });

  it("says that the provider's own terms also apply when the provider is the seller", () => {
    render(<TermsAcceptance t={t} required={[document_()]} linked={[]} viewerLocale="en" providerIsSeller sellerLegalName="Reseller Global Inc" />);

    const notice = global.document.querySelector('[data-checkout="provider-terms"]')?.textContent ?? "";
    expect(notice).toContain("Reseller Global Inc");
  });

  it("leaves that notice out on a direct processor, where we are the seller", () => {
    render(<TermsAcceptance t={t} required={[document_()]} linked={[]} viewerLocale="en" providerIsSeller={false} sellerLegalName="Example SRL" />);

    expect(global.document.querySelector('[data-checkout="provider-terms"]')).toBeNull();
  });
});

describe("the submit control", () => {
  it("is absent, not disabled, when nothing could settle the checkout", () => {
    render(<CheckoutActions t={t} checkoutReady={false} />);

    // Absent rather than disabled: there is nothing on the far side of it until a provider adapter
    // exists, and a disabled button invites somebody to keep pressing it.
    expect(global.document.querySelector('[data-action="accept-and-continue"]')).toBeNull();
    expect(global.document.querySelector('[data-checkout="not-ready"]')?.textContent).toBe(text("checkout.notReady"));
  });

  it("is offered, and enabled, when one could", () => {
    render(<CheckoutActions t={t} checkoutReady />);

    const button = global.document.querySelector<HTMLButtonElement>('[data-action="accept-and-continue"]');
    // Enabled even with every box unticked: the server's refusal names which document is missing, and a
    // disabled button is a refusal nobody can read.
    expect(button?.disabled).toBe(false);
    expect(global.document.querySelector('[data-checkout="not-ready"]')).toBeNull();
  });
});

describe("the summary", () => {
  it("names the selling legal entity and its country, not the product's brand", () => {
    render(<CheckoutSummary t={t} offer={offer()} plan={{ code: "growth", name: "Growth", version: 2 }} />);

    expect(global.document.querySelector('[data-summary="seller"]')?.textContent).toBe("Example SRL");
    // The country in the reader's language. `RO` is a code a form would recognise and a person would not.
    expect(global.document.querySelector('[data-summary="jurisdiction"]')?.textContent).toBe("Romania");
    expect(global.document.querySelector('[data-summary="plan"]')?.textContent).toBe("Growth");
  });

  it("says who remits the tax, and says something different for a Merchant of Record", () => {
    render(<CheckoutSummary t={t} offer={offer()} />);
    expect(global.document.querySelector('[data-tax-remitted-by="SELLER"]')?.textContent).toBe(text("checkout.taxBySeller"));

    cleanup();
    render(<CheckoutSummary t={t} offer={offer({ settlementModel: "MERCHANT_OF_RECORD", taxRemittedBy: "PROVIDER" })} />);
    expect(global.document.querySelector('[data-tax-remitted-by="PROVIDER"]')?.textContent).toBe(text("checkout.taxByProvider"));
  });

  it("distinguishes a subscription from a prepaid term, because one of them renews", () => {
    render(<CheckoutSummary t={t} offer={offer()} />);
    expect(global.document.querySelector('[data-arrangement="RECURRING"]')?.textContent).toBe(text("checkout.renewsAutomatically"));

    cleanup();
    render(<CheckoutSummary t={t} offer={offer({ arrangement: "PREPAID_TERM" })} />);
    expect(global.document.querySelector('[data-arrangement="PREPAID_TERM"]')?.textContent).toBe(text("checkout.prepaidTerm"));
  });

  it("renders the price as money rather than as a count of minor units", () => {
    render(<CheckoutSummary t={t} offer={offer()} />);

    const price = global.document.querySelector('[data-summary="price"]')?.textContent ?? "";
    expect(price).toContain("49");
    expect(price).not.toContain("4900");
  });

  it("gives the seller's billing address as something a customer can write to", () => {
    render(<CheckoutSummary t={t} offer={offer()} />);

    expect(global.document.querySelector('[data-summary="support"] a')?.getAttribute("href")).toBe("mailto:billing@example.test");
  });
});
