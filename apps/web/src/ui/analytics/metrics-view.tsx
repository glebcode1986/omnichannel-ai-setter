/**
 * The operational dashboard (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * Two decisions run through every panel here.
 *
 * **What we decided and what the provider reported are rendered as two separate tables, side by side and
 * never added up.** That is the task's hard invariant made visible: "handed to the provider" is our own
 * record, "delivered" is the platform's, and a single column mixing them would let somebody tell a
 * customer their message arrived on our word alone. The provider table has its own caption saying so.
 *
 * **A metric with nothing to measure says so, and never says zero.** `null` from the store becomes "not
 * measured" with an explanation, because "0s median" for a quiet week is the best-looking number on the
 * page and a complete fiction.
 *
 * **Four figures, then the detail.** This was eleven panels of identical weight in one grid, so a reader
 * asking "are we answering people" scanned all eleven to find out. The four numbers that answer it are
 * tiles across the top; everything that is read rather than glanced at — the day table, the draft
 * outcomes, the two delivery records, the leads and the token usage — sits below them. Nothing was
 * dropped and nothing new is computed: the tiles are the three single-figure panels this file already
 * had, with the response pair split so that each tile carries one number.
 *
 * **Four panels are drawn, and the rest are deliberately not.** A shape answers a question a column of
 * figures does not: whether volume is rising, which reason dominates, how much of the model's output a
 * person had to touch. Those four get a chart. The others keep their lists for stated reasons — the
 * provider's panel is not drawn *because* ours is, since two bar charts side by side are an invitation
 * to read one against the other and that reconciliation is exactly what this page refuses to perform;
 * the usage table's point is the ratio between its six columns, which one bar per model would flatten;
 * and the leads table carries two measures per stage that a single bar cannot hold. Every number stays
 * printed as text beside its bar, so nothing on this page is reachable only by looking at it.
 */
import type { OperationalSnapshot } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";
import { BarRows, hasBars, type BarRow, type BarScale } from "@/ui/charts/bar-rows";
import { DayColumns } from "@/ui/charts/day-columns";

export interface MetricsViewProps {
  readonly t: Translator;
  readonly snapshot: OperationalSnapshot;
  /** Stage labels this Workspace chose, so the table reads the way the board does. */
  readonly stageLabels: Readonly<Record<string, string>>;
}

/** A measurement that exists, or an honest statement that it does not. */
function Measured({ t, value }: { readonly t: Translator; readonly value: string | undefined }) {
  return value === undefined ? (
    <span className="muted" title={t.t("analytics.notMeasuredHint")}>
      {t.t("analytics.notMeasured")}
    </span>
  ) : (
    <>{value}</>
  );
}

const percent = (share: number | null): string | undefined => (share === null ? undefined : `${String(Math.round(share * 100))}%`);

/**
 * A headline figure: what it is, the number, and the counts it was computed from.
 *
 * The caption is required rather than optional, and that is the point of it. A percentage with nothing
 * under it cannot be checked — twenty per cent of what? — so every tile names its own denominator, which
 * is incidentally what keeps the four of them the same height.
 *
 * `h2` like the panels below, so every section of this page is one level of the heading outline and a
 * reader moving by headings reaches the figures first. `data-panel` for the reason the panels carry it:
 * a tile is addressable by what it means rather than by where it sits.
 */
function Tile({
  t,
  panel,
  label,
  value,
  caption,
}: {
  readonly t: Translator;
  readonly panel: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly caption: string;
}) {
  return (
    <section className="metric-tile" data-panel={panel}>
      <h2>{label}</h2>
      <p className="metric-figure">
        <Measured t={t} value={value} />
      </p>
      <p className="muted">{caption}</p>
    </section>
  );
}

/**
 * Bars when there is something to draw, and the page's own sentence when there is not.
 *
 * `hasBars` is asked here and inside `BarRows`, which is the same question answered in one place: a
 * panel that decided for itself would eventually disagree with the component and render a heading above
 * an empty box.
 */
function Bars({ t, rows, scale }: { readonly t: Translator; readonly rows: readonly BarRow[]; readonly scale: BarScale }) {
  return hasBars(rows, scale) ? <BarRows rows={rows} scale={scale} /> : <p className="muted">{t.t("analytics.noData")}</p>;
}

/**
 * The seven outcomes a draft can reach, plus the drafts that have reached none of them.
 *
 * The store counts outcomes by the draft's status, and those statuses do not cover every draft it
 * counted: one waiting to send unattended is `PENDING` without needing review and falls in none of the
 * seven. So the seven sum to at most `generated` and the difference is a real group of drafts. Bars drawn
 * as shares of `generated` without that row would leave the same gap in every track with nothing on
 * screen to explain it, which is the shape of a bug rather than of a fact.
 *
 * Clamped at zero. The seven cannot exceed the whole — each counted row falls in at most one of them —
 * and if that ever stopped being true, a bar drawn backwards is not the way to find out.
 */
function draftRows(t: Translator, drafts: OperationalSnapshot["drafts"]): readonly BarRow[] {
  const outcomes: readonly BarRow[] = [
    { key: "autoSent", label: t.t("analytics.draftsAutoSent"), value: drafts.autoSent },
    { key: "humanSent", label: t.t("analytics.draftsHumanSent"), value: drafts.humanApprovedSent },
    { key: "awaiting", label: t.t("analytics.draftsAwaiting"), value: drafts.awaitingReview },
    { key: "ambiguous", label: t.t("analytics.draftsAmbiguous"), value: drafts.heldAmbiguous },
    { key: "dismissed", label: t.t("analytics.draftsDismissed"), value: drafts.dismissed },
    { key: "superseded", label: t.t("analytics.draftsSuperseded"), value: drafts.superseded },
    { key: "failed", label: t.t("analytics.draftsFailed"), value: drafts.failed },
  ];
  const open = Math.max(0, drafts.generated - outcomes.reduce((total, row) => total + row.value, 0));
  return open === 0 ? outcomes : [...outcomes, { key: "open", label: t.t("analytics.draftsNoOutcome"), value: open }];
}

export function MetricsView({ t, snapshot, stageLabels }: MetricsViewProps) {
  const { volume, responseTimes, drafts, delivery, leads, usage } = snapshot;

  return (
    <div className="metrics" data-metrics="true">
      {/* The four numbers somebody opens this page to read. */}
      <div className="metric-tiles">
        <Tile
          t={t}
          panel="response"
          label={t.t("analytics.responseMedian")}
          value={responseTimes.medianSeconds === null ? undefined : t.t("analytics.seconds", { value: responseTimes.medianSeconds })}
          caption={t.t("analytics.samples", { count: responseTimes.samples })}
        />
        {/* The same sample set as the median, so the same caption: both figures are drawn from the
            waits this window actually contains, and a tile that did not say so would read as a
            measurement of everything. */}
        <Tile
          t={t}
          panel="response-p90"
          label={t.t("analytics.responseP90")}
          value={responseTimes.p90Seconds === null ? undefined : t.t("analytics.seconds", { value: responseTimes.p90Seconds })}
          caption={t.t("analytics.samples", { count: responseTimes.samples })}
        />
        <Tile
          t={t}
          panel="takeover"
          label={t.t("analytics.takeover")}
          value={percent(snapshot.takeover.rate)}
          caption={t.t("analytics.takeoverRate", { taken: snapshot.takeover.takenOver, active: snapshot.takeover.conversationsWithInbound })}
        />
        {/* The caption carries the counts, not the share a second time. It used to interpolate the
            percentage again — and with no percentage to interpolate it put the words "not measured"
            into the number's slot, which read as a sentence with its subject swapped out: "Not
            measured of drafts were missing a fact". Counts are always numbers, so this stays a
            sentence whether or not there was anything to measure. */}
        <Tile
          t={t}
          panel="missing-facts"
          label={t.t("analytics.missingFacts")}
          value={percent(snapshot.missingFacts.share)}
          caption={t.t("analytics.missingFactsShare", { drafts: snapshot.missingFacts.drafts, generated: drafts.generated })}
        />
      </div>

      <div className="metric-grid">
        <section className="metric-panel" data-panel="volume">
          <h2>{t.t("analytics.volume")}</h2>
          {volume.length === 0 ? (
            <p className="muted">{t.t("analytics.noData")}</p>
          ) : (
            <>
              {/* The axis is the window the page says it measured, not the rows the store returned: a
                  day with no inbound has no row and would otherwise be missing from the chart rather
                  than empty in it. The table below carries every date and both numbers, which is why
                  the drawing can stay a drawing. */}
              <DayColumns
                window={snapshot.window}
                points={volume.map((point) => ({ day: point.day, primary: point.inboundMessages, secondary: point.inboundConversations }))}
                primaryLabel={t.t("analytics.volumeMessages")}
                secondaryLabel={t.t("analytics.volumeConversations")}
                titleFor={(day, messages, conversations) => t.t("analytics.volumeOnDay", { day, messages, conversations })}
              />
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t.t("analytics.day")}</th>
                    <th scope="col">{t.t("analytics.volumeMessages")}</th>
                    <th scope="col">{t.t("analytics.volumeConversations")}</th>
                  </tr>
                </thead>
                <tbody>
                  {volume.map((point) => (
                    <tr key={point.day}>
                      <th scope="row">{point.day}</th>
                      <td>{point.inboundMessages}</td>
                      {/* Counted separately, because ten messages from one person and one from ten
                          people are the same number and not the same day. */}
                      <td>{point.inboundConversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className="metric-panel" data-panel="drafts">
          <h2>{t.t("analytics.drafts")}</h2>
          {drafts.generated === 0 ? (
            <p className="muted">{t.t("analytics.noData")}</p>
          ) : (
            <>
              {/* The denominator in words, because every bar below is a share of it and a share whose
                  whole is not stated cannot be checked. It also keeps "Generated" out of the chart: a
                  row that is full width by definition is a bar nobody can read anything from. */}
              <p className="muted">{t.t("analytics.draftsOfGenerated", { generated: drafts.generated })}</p>
              <Bars t={t} rows={draftRows(t, drafts)} scale={{ kind: "whole", of: drafts.generated }} />
            </>
          )}
        </section>

        <section className="metric-panel" data-panel="reasons">
          <h2>{t.t("analytics.reasons")}</h2>
          {snapshot.reviewReasons.length === 0 ? (
            <p className="muted">{t.t("analytics.noData")}</p>
          ) : (
            <>
              {/* Scaled to the largest reason and never to the draft count, which is this panel's own
                  invariant turned into geometry: a draft that waited for three reasons is counted under
                  all three, so bars drawn as shares of the drafts would add up past the whole and read
                  as broken data. The longest bar means "the most common reason" and nothing else. */}
              <Bars
                t={t}
                rows={snapshot.reviewReasons.map((row) => ({ key: row.reason, label: row.reason, value: row.drafts }))}
                scale={{ kind: "largest" }}
              />
              {/* Said on screen rather than left for somebody to discover by adding the column up. */}
              <p className="muted">{t.t("analytics.reasonsOverlap")}</p>
            </>
          )}
        </section>

        <section className="metric-panel" data-panel="application-state">
          <h2>{t.t("analytics.application")}</h2>
          <p className="muted">{t.t("analytics.applicationHint")}</p>
          {/* Scaled to the largest of our own states rather than to a total, because the page does not
              claim these partition anything: a job can be counted in more than one of them over a
              window in which it moved. The provider's panel below is deliberately left as a list — two
              bar charts side by side would invite exactly the reconciliation this page refuses. */}
          <Bars
            t={t}
            rows={[
              { key: "scheduled", label: t.t("analytics.scheduled"), value: delivery.application.scheduled },
              { key: "heldReview", label: t.t("analytics.heldReview"), value: delivery.application.heldForReview },
              { key: "heldAmbiguous", label: t.t("analytics.heldAmbiguous"), value: delivery.application.heldAmbiguous },
              { key: "handedToProvider", label: t.t("analytics.handedToProvider"), value: delivery.application.handedToProvider },
              { key: "cancelled", label: t.t("analytics.cancelled"), value: delivery.application.cancelled },
              { key: "failedAfterRetries", label: t.t("analytics.failedAfterRetries"), value: delivery.application.failedAfterRetries },
            ]}
            scale={{ kind: "largest" }}
          />
        </section>

        {/* Its own panel, never a column beside ours. The caption is the point. */}
        <section className="metric-panel" data-panel="provider-state">
          <h2>{t.t("analytics.provider")}</h2>
          <p className="muted">{t.t("analytics.providerHint")}</p>
          <dl>
            <dt>{t.t("analytics.awaitingReport")}</dt>
            <dd>{delivery.provider.awaitingReport}</dd>
            <dt>{t.t("analytics.reportedSent")}</dt>
            <dd>{delivery.provider.reportedSent}</dd>
            <dt>{t.t("analytics.reportedDelivered")}</dt>
            <dd>{delivery.provider.reportedDelivered}</dd>
            <dt>{t.t("analytics.reportedRead")}</dt>
            <dd>{delivery.provider.reportedRead}</dd>
            <dt>{t.t("analytics.reportedFailed")}</dt>
            <dd>{delivery.provider.reportedFailed}</dd>
          </dl>
        </section>

        <section className="metric-panel" data-panel="ambiguous">
          <h2>{t.t("analytics.ambiguous")}</h2>
          <dl>
            <dt>{t.t("analytics.ambiguousOpen")}</dt>
            <dd>{delivery.ambiguous.open}</dd>
            <dt>{t.t("analytics.ambiguousResolved")}</dt>
            <dd>{delivery.ambiguous.resolved}</dd>
          </dl>
        </section>

        <section className="metric-panel" data-panel="leads">
          <h2>{t.t("analytics.leads")}</h2>
          {leads.movements.length === 0 ? (
            <p className="muted">{t.t("analytics.noData")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">{t.t("analytics.leadStage")}</th>
                  <th scope="col">{t.t("analytics.leadTransitions")}</th>
                  <th scope="col">{t.t("analytics.leadConversations")}</th>
                </tr>
              </thead>
              <tbody>
                {leads.movements.map((row) => (
                  <tr key={row.toStage}>
                    {/* The Workspace's own label, so this table and the board agree. */}
                    <th scope="row">{stageLabels[row.toStage] ?? row.toStage}</th>
                    <td>{row.transitions}</td>
                    <td>{row.conversations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">{t.t("analytics.qualificationRate", { qualified: leads.qualified, engaged: leads.engaged })}</p>
        </section>

        <section className="metric-panel" data-panel="usage">
          <h2>{t.t("analytics.usage")}</h2>
          {usage.length === 0 ? (
            <p className="muted">{t.t("analytics.noData")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">{t.t("analytics.usageModel")}</th>
                  <th scope="col">{t.t("analytics.usageGenerations")}</th>
                  <th scope="col">{t.t("analytics.usageInput")}</th>
                  <th scope="col">{t.t("analytics.usageOutput")}</th>
                  <th scope="col">{t.t("analytics.usageCache")}</th>
                  <th scope="col">{t.t("analytics.usageLatency")}</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={`${row.provider}/${row.model}`}>
                    <th scope="row">{`${row.provider} ${row.model}`}</th>
                    <td>{row.generations}</td>
                    <td>{row.inputTokens}</td>
                    <td>{row.outputTokens}</td>
                    <td>{row.cacheReadTokens + row.cacheWriteTokens}</td>
                    <td>
                      <Measured t={t} value={row.medianLatencyMs === null ? undefined : t.t("analytics.milliseconds", { value: row.medianLatencyMs })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* No money anywhere on this page, and the page says why rather than leaving a gap. */}
          <p className="muted">{t.t("analytics.usageNoCost")}</p>
        </section>
      </div>
    </div>
  );
}
