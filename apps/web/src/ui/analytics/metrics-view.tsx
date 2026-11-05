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
 */
import type { OperationalSnapshot } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

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
                    {/* Counted separately, because ten messages from one person and one from ten people
                        are the same number and not the same day. */}
                    <td>{point.inboundConversations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="metric-panel" data-panel="drafts">
          <h2>{t.t("analytics.drafts")}</h2>
          <dl>
            <dt>{t.t("analytics.draftsGenerated")}</dt>
            <dd>{drafts.generated}</dd>
            <dt>{t.t("analytics.draftsAutoSent")}</dt>
            <dd>{drafts.autoSent}</dd>
            <dt>{t.t("analytics.draftsHumanSent")}</dt>
            <dd>{drafts.humanApprovedSent}</dd>
            <dt>{t.t("analytics.draftsAwaiting")}</dt>
            <dd>{drafts.awaitingReview}</dd>
            <dt>{t.t("analytics.draftsAmbiguous")}</dt>
            <dd>{drafts.heldAmbiguous}</dd>
            <dt>{t.t("analytics.draftsDismissed")}</dt>
            <dd>{drafts.dismissed}</dd>
            <dt>{t.t("analytics.draftsSuperseded")}</dt>
            <dd>{drafts.superseded}</dd>
            <dt>{t.t("analytics.draftsFailed")}</dt>
            <dd>{drafts.failed}</dd>
          </dl>
        </section>

        <section className="metric-panel" data-panel="reasons">
          <h2>{t.t("analytics.reasons")}</h2>
          {snapshot.reviewReasons.length === 0 ? (
            <p className="muted">{t.t("analytics.noData")}</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t.t("analytics.reason")}</th>
                    <th scope="col">{t.t("analytics.reasonDrafts")}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.reviewReasons.map((row) => (
                    <tr key={row.reason}>
                      <th scope="row">{row.reason}</th>
                      <td>{row.drafts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Said on screen rather than left for somebody to discover by adding the column up. */}
              <p className="muted">{t.t("analytics.reasonsOverlap")}</p>
            </>
          )}
        </section>

        <section className="metric-panel" data-panel="application-state">
          <h2>{t.t("analytics.application")}</h2>
          <p className="muted">{t.t("analytics.applicationHint")}</p>
          <dl>
            <dt>{t.t("analytics.scheduled")}</dt>
            <dd>{delivery.application.scheduled}</dd>
            <dt>{t.t("analytics.heldReview")}</dt>
            <dd>{delivery.application.heldForReview}</dd>
            <dt>{t.t("analytics.heldAmbiguous")}</dt>
            <dd>{delivery.application.heldAmbiguous}</dd>
            <dt>{t.t("analytics.handedToProvider")}</dt>
            <dd>{delivery.application.handedToProvider}</dd>
            <dt>{t.t("analytics.cancelled")}</dt>
            <dd>{delivery.application.cancelled}</dd>
            <dt>{t.t("analytics.failedAfterRetries")}</dt>
            <dd>{delivery.application.failedAfterRetries}</dd>
          </dl>
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
