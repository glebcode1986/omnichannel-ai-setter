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
import { Select, type SelectOption } from "@/ui/select";

/**
 * An option in one of these filters, which is an option in any of the product's selects.
 *
 * An alias rather than a second declaration of the same two fields: the row's controls are the product's
 * own `Select` now, and two names for one shape is how the two drift apart.
 */
export type FilterOption = SelectOption;

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
        <Select name="range" value={view.range} options={RANGE_PRESETS.map((range) => ({ value: range, label: t.t(`analytics.range.${range}`) }))} />
      </label>
      <label>
        {t.t("analytics.timeZone")}
        {/* The reader's own zone if they typed one into the URL, so choosing again does not lose it. */}
        <Select
          name="tz"
          value={view.timeZone}
          options={[...new Set([view.timeZone, ...OFFERED_TIME_ZONES])].map((zone) => ({ value: zone, label: zone }))}
        />
      </label>
      <label>
        {t.t("analytics.account")}
        <Select name="account" value={view.channelAccountId ?? ""} options={[{ value: "", label: t.t("analytics.allAccounts") }, ...accounts]} />
      </label>
      <label>
        {t.t("analytics.mode")}
        <Select
          name="mode"
          value={view.mode ?? ""}
          options={[{ value: "", label: t.t("analytics.allModes") }, ...AI_MODES.map((mode) => ({ value: mode, label: t.t(`aiMode.${mode}`) }))]}
        />
      </label>
      <label>
        {t.t("analytics.stage")}
        <Select name="stage" value={view.leadStage ?? ""} options={[{ value: "", label: t.t("analytics.allStages") }, ...stages]} />
      </label>
      <label>
        {t.t("analytics.owner")}
        <Select name="owner" value={view.assignedUserId ?? ""} options={[{ value: "", label: t.t("analytics.allOwners") }, ...members]} />
      </label>
      {kinds === undefined ? undefined : (
        <label>
          {t.t("audit.kind")}
          {/* Only the kinds this reader may see. Offering one that would return nothing would tell an
              Agent that admin-only rows exist, which is what withholding them is for. */}
          <Select
            name="kind"
            value={view.kinds[0] ?? ""}
            options={[{ value: "", label: t.t("audit.allKinds") }, ...kinds.map((kind) => ({ value: kind, label: t.t(`audit.kind.${kind}`) }))]}
          />
        </label>
      )}
      {showSearch === true ? (
        <label>
          {t.t("audit.search")}
          <input type="search" name="q" defaultValue={view.term ?? ""} />
        </label>
      ) : undefined}
      {/* `.button`, like every other submit in the product. Unclassed, it was drawn by the browser:
          a native grey control at the end of a row of designed fields. */}
      <button className="button" data-variant="primary" type="submit">
        {t.t("analytics.apply")}
      </button>
    </form>
  );
}
