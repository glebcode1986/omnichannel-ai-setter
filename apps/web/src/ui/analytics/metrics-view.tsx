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

export function MetricsView({ t, snapshot, stageLabels }: MetricsViewProps) {
  const { volume, responseTimes, drafts, delivery, leads, usage } = snapshot;

  return (
    <div className="metrics" data-metrics="true">
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

      <section className="metric-panel" data-panel="response">
        <h2>{t.t("analytics.responseTimes")}</h2>
        <dl>
          <dt>{t.t("analytics.median")}</dt>
          <dd>
            <Measured t={t} value={responseTimes.medianSeconds === null ? undefined : t.t("analytics.seconds", { value: responseTimes.medianSeconds })} />
          </dd>
          <dt>{t.t("analytics.p90")}</dt>
          <dd>
            <Measured t={t} value={responseTimes.p90Seconds === null ? undefined : t.t("analytics.seconds", { value: responseTimes.p90Seconds })} />
          </dd>
        </dl>
        <p className="muted">{t.t("analytics.samples", { count: responseTimes.samples })}</p>
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

      <section className="metric-panel" data-panel="takeover">
        <h2>{t.t("analytics.takeover")}</h2>
        <p className="metric-figure">
          <Measured t={t} value={percent(snapshot.takeover.rate)} />
        </p>
        <p className="muted">
          {t.t("analytics.takeoverRate", { taken: snapshot.takeover.takenOver, active: snapshot.takeover.conversationsWithInbound })}
        </p>
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

      <section className="metric-panel" data-panel="missing-facts">
        <h2>{t.t("analytics.missingFacts")}</h2>
        <p className="metric-figure">
          <Measured t={t} value={percent(snapshot.missingFacts.share)} />
        </p>
        <p className="muted">{t.t("analytics.missingFactsShare", { share: percent(snapshot.missingFacts.share) ?? t.t("analytics.notMeasured") })}</p>
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
  );
}
