"use client";

/**
 * When reading the Inbox fails (Issue #28).
 *
 * A client component, because an error boundary has to be one. It says the one thing an operator needs to
 * know before deciding what to do — that a failure to *read* sent nothing to a customer — and offers the
 * retry React gives us rather than a reload, so the filters in the URL survive it.
 *
 * The error's own message is deliberately not rendered: it comes from a query layer and can carry
 * identifiers and structure that belong in a log rather than on a screen someone may screenshot.
 *
 * The locale comes from the document, because React owns this component's props and cannot be asked to
 * pass a translator. The root layout sets `lang` from the reader's preference, so this is the same
 * answer the server gave and not a second source of truth.
 *
 * Nothing is reported from here. The failure happened in a Server Component, so it was already logged on
 * the server with the context this side does not have; logging it again from the browser would add a
 * second, thinner record of the same event.
 */
import { resolveUiLocale } from "@/i18n/locales";
import { createTranslator } from "@/i18n/translate";

export default function InboxError({ reset }: { readonly error: Error; readonly reset: () => void }) {
  const t = createTranslator(resolveUiLocale(typeof document === "undefined" ? undefined : document.documentElement.lang));

  return (
    <div className="notice" data-tone="stop" role="alert">
      <h2>{t.t("inbox.errorTitle")}</h2>
      <p>{t.t("inbox.errorBody")}</p>
      <button className="button" type="button" onClick={reset}>
        {t.t("inbox.retry")}
      </button>
    </div>
  );
}
