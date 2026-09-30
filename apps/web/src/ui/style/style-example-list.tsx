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
 */
import type { StyleExampleView } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { StyleTarget } from "@/server/style-actions";

export interface StyleExampleListProps {
  readonly t: Translator;
  readonly examples: readonly StyleExampleView[];
  readonly target: StyleTarget;
  /** Which library this is: the verified one, or the queue of suggestions. */
  readonly kind: "VERIFIED" | "SUGGESTED";
  readonly actions: {
    readonly approve: (target: StyleTarget, exampleId: string) => Promise<void>;
    readonly reject: (target: StyleTarget, exampleId: string) => Promise<void>;
    readonly archive: (target: StyleTarget, exampleId: string) => Promise<void>;
    readonly restore: (target: StyleTarget, exampleId: string) => Promise<void>;
  };
}

const KNOWN_STATUSES = new Set(["ACTIVE", "SUGGESTED", "REJECTED", "ARCHIVED"]);
const KNOWN_PROVENANCE = new Set(["HUMAN_TYPED", "HUMAN_EDITED_DRAFT"]);

export function StyleExampleList({ t, examples, target, kind, actions }: StyleExampleListProps) {
  if (examples.length === 0) {
    return (
      <p className="muted" data-empty={kind}>
        {kind === "SUGGESTED" ? t.t("style.noSuggestions") : t.t("style.noExamples")}
      </p>
    );
  }

  return (
    <ul className="style-examples">
      {examples.map((example) => (
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
      ))}
    </ul>
  );
}

function statusLabel(t: Translator, status: string): string {
  return KNOWN_STATUSES.has(status) ? t.t(`styleStatus.${status}` as MessageKey) : status;
}

function provenanceLabel(t: Translator, provenance: string): string {
  return KNOWN_PROVENANCE.has(provenance) ? t.t(`provenance.${provenance}` as MessageKey) : provenance;
}
