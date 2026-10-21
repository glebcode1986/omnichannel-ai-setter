/**
 * How much of a metered allowance is left (#42).
 *
 * Shows the included half, the bought half and what remains, because they answer different questions: the
 * included amount resets with the cycle and a purchase expires on its own date, so a single "remaining"
 * would hide which of the two is about to disappear.
 *
 * `PRICING_PACKAGING.md` is explicit that provider token counts and internal AI-generation counters are
 * never presented as a billable allowance. Only metrics a plan actually sells reach this component, and
 * the read model drops the rest before they get here.
 */
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { AllowanceSummary } from "@omnichannel/db";

export function AllowanceMeter({ t, allowance }: { readonly t: Translator; readonly allowance: AllowanceSummary }) {
  const total = allowance.included + allowance.purchased;
  // Guarded, because a plan may include nothing and a percentage of nothing is not a number anybody can
  // render. The health already says what that case means.
  const usedShare = total === 0 ? 1 : Math.min(1, allowance.used / total);

  return (
    <li className="billing-allowance" data-metric={allowance.metric} data-health={allowance.health}>
      <h3>{t.t(`usageMetric.${allowance.metric}` as MessageKey)}</h3>

      <p>
        <span className="badge" data-tone={allowance.health === "OK" ? "ok" : allowance.health === "WARNING" ? "warn" : "stop"}>
          {t.t(`allowanceHealth.${allowance.health}` as MessageKey)}
        </span>{" "}
        {t.t("billing.allowanceRemaining", { remaining: t.number(allowance.remaining), total: t.number(total) })}
      </p>

      {/* A real progress element rather than a styled div: it carries its own value and label, so a
          screen reader is told the number rather than shown a bar. */}
      <progress value={usedShare} max={1} aria-label={t.t(`usageMetric.${allowance.metric}` as MessageKey)} />

      <p className="muted">{t.t("billing.allowanceIncluded", { included: t.number(allowance.included) })}</p>
      {allowance.purchased === 0 ? undefined : (
        <p className="muted" data-purchased="true">
          {t.t("billing.allowancePurchased", { purchased: t.number(allowance.purchased) })}
        </p>
      )}

      <p className="muted" data-resets="true">
        <time dateTime={allowance.resetsAt.toISOString()}>
          {t.t("billing.allowanceResets", { when: t.date(allowance.resetsAt, { dateStyle: "medium" }) })}
        </time>
      </p>
      {allowance.purchaseExpiresAt === undefined ? undefined : (
        <p className="muted" data-purchase-expires="true">
          <time dateTime={allowance.purchaseExpiresAt.toISOString()}>
            {t.t("billing.purchaseExpires", { when: t.date(allowance.purchaseExpiresAt, { dateStyle: "medium" }) })}
          </time>
        </p>
      )}
    </li>
  );
}
