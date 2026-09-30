/**
 * The filters both analytics screens share (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * A GET form rather than a server action, because narrowing a report is navigation: the result belongs in
 * the URL so a reader can bookmark it or send it to somebody, and the back button should undo it.
 *
 * The timezone is a control here and not a hidden default. That is the spec's "timezone definitions must
 * be explicit" taken literally — the reader chooses which days they mean, and the page says which it used.
 */
import type { AuditEventKind } from "@omnichannel/domain";

import type { Translator } from "@/i18n/translate";
import { AI_MODES, OFFERED_TIME_ZONES, RANGE_PRESETS, type AnalyticsView } from "@/server/analytics-view";

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterBarProps {
  readonly t: Translator;
  readonly view: AnalyticsView;
  readonly action: string;
  readonly accounts: readonly FilterOption[];
  readonly members: readonly FilterOption[];
  readonly stages: readonly FilterOption[];
  /** Audit only. Absent on the analytics screen, which has no kinds to narrow by. */
  readonly kinds?: readonly AuditEventKind[];
  readonly showSearch?: boolean;
}

export function FilterBar({ t, view, action, accounts, members, stages, kinds, showSearch }: FilterBarProps) {
  return (
    <form className="filter-bar" method="get" action={action} data-filter-bar="true">
      <label>
        {t.t("analytics.range")}
        <select name="range" defaultValue={view.range}>
          {RANGE_PRESETS.map((range) => (
            <option key={range} value={range}>
              {t.t(`analytics.range.${range}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.t("analytics.timeZone")}
        <select name="tz" defaultValue={view.timeZone}>
          {/* The reader's own zone if they typed one into the URL, so choosing again does not lose it. */}
          {[...new Set([view.timeZone, ...OFFERED_TIME_ZONES])].map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.t("analytics.account")}
        <select name="account" defaultValue={view.channelAccountId ?? ""}>
          <option value="">{t.t("analytics.allAccounts")}</option>
          {accounts.map((account) => (
            <option key={account.value} value={account.value}>
              {account.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.t("analytics.mode")}
        <select name="mode" defaultValue={view.mode ?? ""}>
          <option value="">{t.t("analytics.allModes")}</option>
          {AI_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t.t(`aiMode.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.t("analytics.stage")}
        <select name="stage" defaultValue={view.leadStage ?? ""}>
          <option value="">{t.t("analytics.allStages")}</option>
          {stages.map((stage) => (
            <option key={stage.value} value={stage.value}>
              {stage.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.t("analytics.owner")}
        <select name="owner" defaultValue={view.assignedUserId ?? ""}>
          <option value="">{t.t("analytics.allOwners")}</option>
          {members.map((member) => (
            <option key={member.value} value={member.value}>
              {member.label}
            </option>
          ))}
        </select>
      </label>
      {kinds === undefined ? undefined : (
        <label>
          {t.t("audit.kind")}
          {/* Only the kinds this reader may see. Offering one that would return nothing would tell an
              Agent that admin-only rows exist, which is what withholding them is for. */}
          <select name="kind" defaultValue={view.kinds[0] ?? ""}>
            <option value="">{t.t("audit.allKinds")}</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {t.t(`audit.kind.${kind}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {showSearch === true ? (
        <label>
          {t.t("audit.search")}
          <input type="search" name="q" defaultValue={view.term ?? ""} />
        </label>
      ) : undefined}
      <button type="submit">{t.t("analytics.apply")}</button>
    </form>
  );
}
