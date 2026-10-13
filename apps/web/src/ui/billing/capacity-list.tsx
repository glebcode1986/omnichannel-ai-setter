/**
 * What the workspace is using, beside what it is allowed (#42).
 *
 * Both numbers, always. A ceiling on its own says what is permitted and a count on its own says what
 * exists; the two differ exactly when somebody needs to be told about it, and an "8 of 10" is the only
 * form that answers "can I add another?" without arithmetic.
 */
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { ActiveAddOn, CapacityUse } from "@omnichannel/db";

export function CapacityList({
  t,
  capacity,
  addOns,
}: {
  readonly t: Translator;
  readonly capacity: readonly CapacityUse[];
  readonly addOns: readonly ActiveAddOn[];
}) {
  return (
    <section className="card" data-billing="capacity">
      <h2>{t.t("billing.capacityTitle")}</h2>
      <dl className="billing-capacity">
        {capacity.map((entry) => (
          <div key={entry.limit} data-limit={entry.limit} data-over={entry.ceiling !== undefined && entry.inUse > entry.ceiling}>
            <dt>{t.t(`planLimit.${entry.limit}` as MessageKey)}</dt>
            <dd>
              {/* An absent ceiling is a real answer rather than a missing one, and showing a zero would
                  read as "you may have none of these". */}
              {entry.ceiling === undefined
                ? t.t("billing.capacityUncapped", { inUse: t.number(entry.inUse) })
                : t.t("billing.capacityOf", { inUse: t.number(entry.inUse), ceiling: t.number(entry.ceiling) })}
            </dd>
          </div>
        ))}
      </dl>

      {addOns.length === 0 ? undefined : (
        <>
          <h3>{t.t("billing.addOnsTitle")}</h3>
          <ul className="billing-addons">
            {addOns.map((addOn) => (
              <li key={addOn.code} data-addon={addOn.code}>
                {t.t("billing.addOnQuantity", { name: addOn.name, quantity: addOn.quantity })}
                {addOn.activeUntil === undefined ? undefined : (
                  <>
                    {" "}
                    <time dateTime={addOn.activeUntil.toISOString()}>
                      {t.t("billing.addOnEnds", { when: t.date(addOn.activeUntil, { dateStyle: "medium" }) })}
                    </time>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
