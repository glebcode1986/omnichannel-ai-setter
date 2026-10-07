/**
 * The ambiguous operations a person has to decide about (#59, ADR-012, ADMIN_OPERATIONS.md).
 *
 * There is no "retry anyway" here, and that absence is the design. For an ambiguous non-idempotent write
 * a blind retry is how a customer receives the same message twice, so the only control is "re-examine
 * now" — which enqueues exactly the job the sweeper raises, and lets `reconcileOperation` decide with its
 * ordered checks: a settled send is left alone, a claim that was never taken is resumed through the
 * coordinator, and provider evidence answers the rest.
 *
 * The evidence column is one short phrase by contract, never a provider response body and never a secret.
 */
import type { ReconciliationRow } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export function ReconciliationQueue({
  t,
  rows,
  canOperate,
  action,
  workspacePath,
}: {
  readonly t: Translator;
  readonly rows: readonly ReconciliationRow[];
  readonly canOperate: boolean;
  readonly action: (formData: FormData) => Promise<void>;
  /** Builds a link to the tenant a row belongs to, so an operator can get the rest of the picture. */
  readonly workspacePath: (workspaceId: string) => string;
}) {
  return (
    <section className="card" data-admin="reconciliation">
      <h2>{t.t("admin.reconciliation")}</h2>
      <p className="muted" data-admin="no-blind-retry">
        {t.t("admin.noBlindRetry")}
      </p>

      {rows.length === 0 ? (
        <p className="muted" data-reconciliations="none">
          {t.t("admin.nothingAmbiguous")}
        </p>
      ) : (
        <ul className="admin-reconciliations">
          {rows.map((row) => (
            <li key={row.operationId} data-operation={row.operationId} data-state={row.state}>
              <p>
                {t.t("admin.ambiguousLine", {
                  reason: t.t(`reconciliationReason.${row.reason}` as MessageKey),
                  state: t.t(`reconciliationState.${row.state}` as MessageKey),
                  detected: t.date(row.detectedAt, { dateStyle: "short", timeStyle: "short" }),
                  attempts: t.number(row.attemptCount),
                })}
              </p>
              {row.evidence === null ? undefined : (
                <p className="muted" data-evidence="true">
                  {row.evidence}
                </p>
              )}
              <p className="muted" data-correlation-id={row.correlationId ?? ""}>
                {t.t("admin.correlation", { id: row.correlationId ?? t.t("admin.never") })}
              </p>
              <a href={workspacePath(row.workspaceId)} data-action="open-workspace">
                {t.t("admin.openWorkspace")}
              </a>
              {canOperate ? (
                <form action={action} data-admin="reexamine">
                  <input type="hidden" name="operationId" value={row.operationId} />
                  <label htmlFor={`admin-reexamine-${row.operationId}`} className="visually-hidden">
                    {t.t("admin.reexamineReason")}
                  </label>
                  <input id={`admin-reexamine-${row.operationId}`} name="reason" type="text" aria-label={t.t("admin.reexamineReason")} required />
                  <button className="button" type="submit" data-action="reexamine">
                    {t.t("admin.reexamine")}
                  </button>
                </form>
              ) : undefined}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
