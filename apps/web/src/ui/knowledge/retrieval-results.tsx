/**
 * What the assistant would actually find (RETRIEVAL.md, Issue #31).
 *
 * The tester's value is that it is the real retriever, so this pane's job is to be honest about three
 * things a simulation would blur:
 *
 * - **which mode ran.** Lexical-only and hybrid give different answers, and an operator told "nothing
 *   found" needs to know which search produced it. The deployment's own configuration decides, and the
 *   worker is in the same mode, so the sentence is about the product rather than about this screen.
 * - **not-found versus could-not-look.** A retrieval outage rendered as an empty result would tell someone
 *   their knowledge base is empty at the moment it is merely unreachable.
 * - **where each hit came from.** The document, its version and whether it is shared across profiles,
 *   because "the assistant found *something*" is not the same as "it found the right source".
 */
import type { KnowledgeHit } from "@omnichannel/application";

import type { Translator } from "@/i18n/translate";

export interface RetrievalResultsProps {
  readonly t: Translator;
  readonly mode: "HYBRID" | "LEXICAL_ONLY";
  readonly hits: readonly KnowledgeHit[];
  readonly unavailable: boolean;
  /** Absent until a question has been asked, which is different from asking and finding nothing. */
  readonly asked: boolean;
}

export function RetrievalResults({ t, mode, hits, unavailable, asked }: RetrievalResultsProps) {
  return (
    <section className="retrieval-results" aria-live="polite">
      <p className="muted" data-mode={mode}>
        {mode === "HYBRID" ? t.t("tester.modeHybrid") : t.t("tester.modeLexical")}
      </p>

      {unavailable ? (
        <p className="notice" data-tone="stop" data-unavailable="true">
          {t.t("tester.unavailable")}
        </p>
      ) : asked && hits.length === 0 ? (
        <p className="muted" data-no-results="true">
          {t.t("tester.noResults")}
        </p>
      ) : undefined}

      {hits.length === 0 ? undefined : (
        <ol className="retrieval-hits">
          {hits.map((hit) => (
            <li key={hit.chunkId} data-chunk={hit.chunkId}>
              <p className="message-text">{hit.text}</p>
              <p className="muted">
                {hit.documentTitle} · {t.t("tester.fromVersion", { version: hit.documentVersion })} ·{" "}
                {hit.scopeLevel === "WORKSPACE" ? t.t("tester.scopeWorkspace") : t.t("tester.scopeProfile")} · {t.t("tester.score")}{" "}
                {t.number(hit.score, { maximumFractionDigits: 3 })}
              </p>
            </li>
          ))}
        </ol>
      )}

      <p className="muted" data-read-only="true">
        {t.t("tester.readOnly")}
      </p>
    </section>
  );
}
