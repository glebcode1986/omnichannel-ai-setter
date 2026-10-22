/**
 * The submit control, or the reason there is not one (#47).
 *
 * Its own pane so the rule can be tested rather than read. The rule is this app's existing one — a
 * control that cannot work is **absent**, not disabled — and here it is also the honest one: until a
 * provider adapter exists (#41) there is nothing on the far side of this button, so offering it would be
 * offering something that cannot happen.
 *
 * What is deliberately *not* conditional is the button when a checkout could complete. It is enabled even
 * with every box unticked, because the server refuses that submission with a sentence that says which
 * document is missing — and a disabled button is a refusal nobody can read.
 */
import type { Translator } from "@/i18n/translate";

export function CheckoutActions({ t, checkoutReady }: { readonly t: Translator; readonly checkoutReady: boolean }) {
  if (!checkoutReady) {
    return (
      <p className="notice" data-tone="stop" data-checkout="not-ready">
        {t.t("checkout.notReady")}
      </p>
    );
  }

  return (
    <button className="button primary" type="submit" data-action="accept-and-continue">
      {t.t("checkout.acceptAndContinue")}
    </button>
  );
}
