/**
 * The style test as the spec describes it (Issue #32, KNOWLEDGE_STYLE_UX.md).
 *
 * Three things, not one: a candidate reply, the instructions that shaped it, and the examples that shaped
 * it. The first version rendered only the examples, which made this a retrieval browser — it showed what
 * the assistant would read and never what it would say, and a voice cannot be judged from its inputs.
 *
 * A component rather than markup in the route, so that the three parts are something a test can assert
 * the presence of. The route is the one place in this app a test cannot reach, and it is where the missing
 * parts were missing.
 */
import type { StyleTestResult } from "@/server/style-test";
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

import { EffectiveVoice } from "./effective-voice";

/**
 * Why there is no candidate, in the operator's language.
 *
 * Three different absences with three different answers: nothing was asked, nothing can be asked in this
 * deployment, or something was asked and did not come back. Collapsing them into one "no result" would
 * tell an operator their voice produces nothing when the truth is that no model is wired in here.
 */
const CANDIDATE_MESSAGE: Readonly<Record<string, MessageKey>> = {
  NO_PROMPT: "styleTest.candidateNoPrompt",
  NOT_CONFIGURED: "styleTest.candidateNotConfigured",
  UNAVAILABLE: "styleTest.candidateUnavailable",
};

export interface StyleTestPanelProps {
  readonly t: Translator;
  readonly test: StyleTestResult;
  /** Where the form submits, which is this screen itself: the test is a GET so it survives a reload. */
  readonly basePath: string;
  /** What was asked, or nothing. Absent distinguishes "not asked yet" from "asked and found nothing". */
  readonly ask?: string;
}

export function StyleTestPanel({ t, test, basePath, ask }: StyleTestPanelProps) {
  const { trial, candidate, effective } = test;

  return (
    <section className="knowledge-tester">
      <h2>{t.t("styleTest.title")}</h2>
      <form action={basePath} method="get" role="search" className="inbox-search">
        <div className="field">
          <label htmlFor="style-ask">{t.t("styleTest.queryLabel")}</label>
          <input id="style-ask" name="ask" type="search" defaultValue={ask ?? ""} />
        </div>
        <button className="button" type="submit">
          {t.t("styleTest.run")}
        </button>
      </form>
      <p className="muted">{t.t("styleTest.explain")}</p>

      <h3>{t.t("styleTest.candidateTitle")}</h3>
      {candidate.status === "WRITTEN" ? (
        <p className="message-text" data-candidate="WRITTEN">
          {candidate.text}
        </p>
      ) : (
        <p className="muted" data-candidate={candidate.status}>
          {t.t(CANDIDATE_MESSAGE[candidate.status] ?? "styleTest.candidateUnavailable")}
        </p>
      )}
      {/* Beside the candidate, not only at the top of the page: a reply that reads like an answer is
          exactly where somebody would forget that no fact was consulted to write it. */}
      <p className="notice" data-candidate-not-factual="true">
        {t.t("styleTest.candidateNotFactual")}
      </p>

      {/* The first of the two influences. After the candidate, because it is the explanation and the
          candidate is the thing being explained. */}
      <h3>{t.t("styleTest.effectiveTitle")}</h3>
      <p className="muted">{t.t("styleTest.effectiveExplain")}</p>
      <EffectiveVoice t={t} voice={effective} />

      <h3>{t.t("styleTest.examplesTitle")}</h3>
      <p className="muted" data-mode={trial.mode}>
        {trial.mode === "HYBRID" ? t.t("tester.modeHybrid") : t.t("tester.modeLexical")}
      </p>
      {trial.unavailable ? (
        <p className="notice" data-tone="stop" data-unavailable="true">
          {t.t("tester.unavailable")}
        </p>
      ) : ask !== undefined && trial.hits.length === 0 ? (
        <p className="muted" data-no-results="true">
          {t.t("styleTest.noResults")}
        </p>
      ) : undefined}
      {trial.hits.length === 0 ? undefined : (
        <ol className="retrieval-hits">
          {trial.hits.map((hit) => (
            <li key={hit.exampleId} data-example={hit.exampleId}>
              <p className="muted">{hit.inboundContext}</p>
              <p className="message-text">{hit.outboundText}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
