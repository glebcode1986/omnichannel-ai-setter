/**
 * The style example library (KNOWLEDGE_STYLE_UX.md, ADR-011, Issue #32).
 *
 * A suggestion and a verified example look almost the same on a screen and mean very different things, so
 * this pane separates them by what it *offers*, not only by a badge: a suggestion gets approve and decline,
 * a verified example gets archive. Offering "approve" on something already in use would invite a click
 * that does nothing, and offering "archive" on a suggestion would imply it was ever in use.
 *
 * Every example says who stood behind it. A verified example with nobody's name on it cannot exist — a
 * CHECK refuses it — so the absence of a name is itself information: this one is waiting.
 *
 * And every example carries its lifecycle, because the status is the end of a story rather than the story.
 * "Archived" does not say who withdrew it, and an example rejected, restored and archived again looks
 * identical to one archived on the first day unless the decisions themselves are shown.
 *
 * The lifecycle shown with an example is a *window* on it — the most recent decisions, oldest-first
 * within the window — and when it is a window the pane says so and offers the rest. A history that was
 * silently cut was the R5 re-review's blocking finding, and the shape of the defect is worth keeping in
 * mind here: the cut used to fall at the newest end, so the events it hid were the ones that explained
 * the example's current state. Now the window is anchored there and the cut falls where a reader can ask.
 */
import Link from "next/link";
import type { StyleLifecyclePage, StyleExampleView } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { StyleTarget } from "@/server/style-actions";

export interface StyleExampleListProps {
  readonly t: Translator;
  readonly examples: readonly StyleExampleView[];
  readonly target: StyleTarget;
  /** Which library this is: the verified one, or the queue of suggestions. */
  readonly kind: "VERIFIED" | "SUGGESTED" | "RETIRED";
  /**
   * Where the rest of this list is. Absent when this is all of it.
   *
   * Each list on this page pages on its own, so this is per-list rather than per-page: following one must
   * not move the other.
   */
  readonly nextHref?: string;
  /**
   * One example's lifecycle, opened at a point in the past. Absent unless the URL named an example.
   *
   * Replaces that one example's window while it is open; every other example keeps its own. Reading back
   * through one argument must not disturb the rest of the page.
   */
  readonly lifecycle?: StyleLifecyclePage;
  /**
   * Where the events before what is shown are, per example id.
   *
   * A map rather than a field on the example, because the href depends on the whole request — the other
   * lists' cursors travel with it — and that is the server's to build, not a component's.
   */
  readonly earlierHistoryHrefs?: Readonly<Record<string, string>>;
  /** Back to the most recent events, when a lifecycle is open. */
  readonly latestHistoryHref?: string;
  readonly actions: {
    readonly approve: (target: StyleTarget, exampleId: string) => Promise<void>;
    readonly reject: (target: StyleTarget, exampleId: string) => Promise<void>;
    readonly archive: (target: StyleTarget, exampleId: string) => Promise<void>;
    readonly restore: (target: StyleTarget, exampleId: string) => Promise<void>;
  };
}

/**
 * Which decisions to draw for this example: the open lifecycle page if it is this example's, else its own
 * window.
 *
 * One function so the list, the "earlier" count and the link cannot disagree about which set is on
 * screen — three readings of the same question is how a count comes to describe a different page from the
 * one under it.
 */
function lifecycleOf(
  example: StyleExampleView,
  lifecycle: StyleLifecyclePage | undefined,
): {
  readonly decisions: StyleExampleView["decisions"];
  readonly earlierDecisions: number;
  readonly laterDecisions: number;
} {
  return lifecycle !== undefined && lifecycle.styleExampleId === example.id
    ? { decisions: lifecycle.decisions, earlierDecisions: lifecycle.earlierDecisions, laterDecisions: lifecycle.laterDecisions }
    : { decisions: example.decisions, earlierDecisions: example.earlierDecisions, laterDecisions: example.laterDecisions };
}

const KNOWN_STATUSES = new Set(["ACTIVE", "SUGGESTED", "REJECTED", "ARCHIVED"]);
const KNOWN_DECISIONS = new Set(["APPROVED", "REJECTED", "ARCHIVED", "RESTORED"]);
const KNOWN_PROVENANCE = new Set(["HUMAN_TYPED", "HUMAN_EDITED_DRAFT"]);

export function StyleExampleList({
  t,
  examples,
  target,
  kind,
  actions,
  nextHref,
  lifecycle,
  earlierHistoryHrefs,
  latestHistoryHref,
}: StyleExampleListProps) {
  if (examples.length === 0) {
    return (
      <p className="muted" data-empty={kind}>
        {kind === "SUGGESTED" ? t.t("style.noSuggestions") : kind === "RETIRED" ? t.t("style.noRetired") : t.t("style.noExamples")}
      </p>
    );
  }

  return (
    <ul className="style-examples">
      {examples.map((example) => {
        // Derived once. Several call sites of the same pure function is how a count comes to describe a
        // different page from the one rendered under it.
        const shown = lifecycleOf(example, lifecycle);
        const earlierHref = earlierHistoryHrefs?.[example.id];
        const openHere = lifecycle?.styleExampleId === example.id;
        return (
          <li key={example.id} data-example={example.id} data-status={example.status}>
          <p className="muted">{t.t("style.exampleInbound")}</p>
          <p className="message-text" data-inbound="true">
            {example.inboundContext}
          </p>
          <p className="muted">{t.t("style.exampleOutbound")}</p>
          <p className="message-text" data-outbound="true">
            {example.outboundText}
          </p>

          <span className="conversation-badges">
            <span className="badge" data-tone={example.status === "ACTIVE" ? "ok" : "muted"} data-status-badge={example.status}>
              {statusLabel(t, example.status)}
            </span>
            <span className="badge" data-tone="muted" data-provenance={example.provenance}>
              {provenanceLabel(t, example.provenance)}
            </span>
            <span className="badge" data-tone="muted" data-scope={example.scope}>
              {example.scope === "WORKSPACE" ? t.t("style.layerWorkspace") : t.t("style.layerProfile")}
            </span>
          </span>

          {/* The absence of a name is information: a verified example cannot lack one, so this is waiting. */}
          <p className="muted" data-approved-by={example.approvedByName ?? ""}>
            {example.approvedByName === null ? t.t("style.notApproved") : t.t("style.approvedBy", { name: example.approvedByName })}
          </p>

          {shown.decisions.length === 0 && !openHere ? undefined : (
            <>
              <p className="muted">{t.t("style.historyTitle")}</p>
              <ol className="style-history" data-history={example.id} data-earlier={shown.earlierDecisions} data-later={shown.laterDecisions}>
                {shown.decisions.map((entry) => (
                  // Keyed by the row's own id. Decision-and-instant collides for two identical decisions
                  // in one millisecond, which is a pair this history can now legitimately contain.
                  <li key={entry.id} data-decision={entry.decision}>
                    <time className="muted" dateTime={entry.decidedAt.toISOString()}>
                      {t.t("style.historyEntry", {
                        decision: decisionLabel(t, entry.decision),
                        // A decision whose author is gone still happened. Naming nobody is better than
                        // implying it was nobody's.
                        name: entry.decidedByName ?? t.t("style.historyUnknownActor"),
                        when: t.date(entry.decidedAt, { dateStyle: "medium", timeStyle: "short" }),
                      })}
                    </time>
                  </li>
                ))}
              </ol>
              {/* The two things a window owes a reader: that it is one, and the way to the rest. Without
                  the first the history reads as complete; without the second it is unreachable, and the
                  reviewer was right that those are different failures with the same appearance. */}
              {shown.earlierDecisions === 0 ? undefined : (
                <p className="muted" data-earlier-count={example.id}>
                  {t.plural("style.historyEarlier", shown.earlierDecisions, { count: t.number(shown.earlierDecisions) })}
                </p>
              )}
              {/* And the other direction, which is the one worth being careful about. A page read back
                  into the past necessarily hides what came after it, and without this the pane would show
                  a history ending in "Restored" under a badge reading "Archived" — the same truncation
                  that was blocked, one click later rather than on the first screen. */}
              {shown.laterDecisions === 0 ? undefined : (
                <p className="muted" data-later-count={example.id}>
                  {t.plural("style.historyLater", shown.laterDecisions, { count: t.number(shown.laterDecisions) })}
                </p>
              )}
              {/* How long the whole argument is, for a reader who has paged into the middle of it.
                  Without it they can follow links backwards with no idea where they are in it. */}
              {openHere && lifecycle !== undefined ? (
                <p className="muted" data-history-total={example.id}>
                  {t.t("style.historyTotal", { count: t.number(lifecycle.totalDecisions) })}
                </p>
              ) : undefined}
              {earlierHref === undefined ? undefined : (
                <Link className="button" href={earlierHref} data-action="history-earlier" data-example-history={example.id}>
                  {t.t("style.historyEarlierLink")}
                </Link>
              )}
              {/* Rendered whenever a history is open, including when the page it opened is empty — a
                  hand-edited cursor can land past the oldest decision, and the way back must not
                  disappear along with the rows. */}
              {openHere && latestHistoryHref !== undefined ? (
                <Link className="button" href={latestHistoryHref} data-action="history-latest">
                  {t.t("style.historyLatestLink")}
                </Link>
              ) : undefined}
            </>
          )}

          {example.status === "SUGGESTED" ? (
            <>
              <p className="muted">{t.t("style.suggestionExplain")}</p>
              <div className="control-row">
                <form action={actions.approve.bind(null, target, example.id)}>
                  <button className="button primary" type="submit" data-action="approve-example">
                    {t.t("style.approve")}
                  </button>
                </form>
                <form action={actions.reject.bind(null, target, example.id)}>
                  <button className="button" type="submit" data-action="reject-example">
                    {t.t("style.reject")}
                  </button>
                </form>
              </div>
            </>
          ) : example.status === "ACTIVE" ? (
            <form action={actions.archive.bind(null, target, example.id)}>
              <button className="button" type="submit" data-action="archive-example">
                {t.t("style.archive")}
              </button>
            </form>
          ) : (
            <form action={actions.restore.bind(null, target, example.id)}>
              <button className="button" type="submit" data-action="restore-example">
                {t.t("style.restore")}
              </button>
            </form>
          )}
          </li>
        );
      })}
      {nextHref === undefined ? undefined : (
        <li data-load-more={kind}>
          <Link className="button" href={nextHref}>
            {t.t("style.loadMore")}
          </Link>
        </li>
      )}
    </ul>
  );
}

function statusLabel(t: Translator, status: string): string {
  return KNOWN_STATUSES.has(status) ? t.t(`styleStatus.${status}` as MessageKey) : status;
}

function decisionLabel(t: Translator, decision: string): string {
  return KNOWN_DECISIONS.has(decision) ? t.t(`styleDecision.${decision}` as MessageKey) : decision;
}

function provenanceLabel(t: Translator, provenance: string): string {
  return KNOWN_PROVENANCE.has(provenance) ? t.t(`provenance.${provenance}` as MessageKey) : provenance;
}
