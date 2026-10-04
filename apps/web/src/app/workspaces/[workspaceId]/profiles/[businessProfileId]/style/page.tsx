/**
 * Style Training (KNOWLEDGE_STYLE_UX.md, ADR-011, Issue #32).
 *
 * Two halves. The voice is instructions a person wrote; the library is examples of replies a person
 * actually sent. Neither is a fact, and the page says so once, plainly — a tone instruction that read as
 * permission to assert a price would make the whole knowledge/style separation pointless.
 *
 * Suggestions are listed apart from verified examples, because the difference is what is *in use*. A
 * suggestion is inert until somebody approves it, and mixing the two lists would make "in use" a badge
 * somebody has to read rather than a place they are looking.
 */
import { StyleExampleList } from "@/ui/style/style-example-list";
import { VoiceEditor } from "@/ui/style/voice-editor";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { loadStyleScreen } from "@/server/style-page";
import { one } from "@/server/style-view";
import { runStyleTrial } from "@/server/retrieval-tester";
import {
  addStyleExampleAction,
  approveStyleExampleAction,
  archiveStyleExampleAction,
  rejectStyleExampleAction,
  restoreStyleExampleAction,
  saveVoiceAction,
} from "@/server/style-actions";
import type { RawSearchParams } from "@/server/inbox-view";

export default async function StylePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const query = await searchParams;
  const target = { workspaceId, businessProfileId };
  // Every read this screen needs, assembled where a test can call it. Each list carries its own cursor,
  // so paging the suggestions cannot move the verified library underneath the operator.
  const { t, layers, verified, suggestions, basePath, verifiedNextHref, suggestionsNextHref, context } = await loadStyleScreen(
    workspaceId,
    businessProfileId,
    query,
  );

  const ask = one(query["ask"]);
  const trial = await runStyleTrial(context, ask ?? "");
  const actions = {
    approve: approveStyleExampleAction,
    reject: rejectStyleExampleAction,
    archive: archiveStyleExampleAction,
    restore: restoreStyleExampleAction,
  };

  return (
    <>
      <div className="page-header">
        <h1>{t.t("style.title")}</h1>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      {/* Said once, at the top, because it is the one thing about this screen somebody could get badly
          wrong. Facts live in Knowledge; this page decides only how a reply sounds. */}
      <p className="notice" data-not-factual="true">
        {t.t("style.notFactual")}
      </p>

      <section>
        <h2>{t.t("style.voiceTitle")}</h2>
        <div className="voice-layers">
          {layers.map((layer) => (
            <VoiceEditor key={layer.scope} t={t} layer={layer} target={target} action={saveVoiceAction.bind(null, target)} />
          ))}
        </div>
      </section>

      <section className="knowledge-tester">
        <h2>{t.t("styleTest.title")}</h2>
        <form action={basePath} method="get" role="search" className="inbox-search">
          <label htmlFor="style-ask">{t.t("styleTest.queryLabel")}</label>
          <input id="style-ask" name="ask" type="search" defaultValue={ask ?? ""} />
          <button className="button" type="submit">
            {t.t("styleTest.run")}
          </button>
        </form>
        <p className="muted">{t.t("styleTest.explain")}</p>
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

      <section>
        <h2>{t.t("style.suggestionsTitle")}</h2>
        <StyleExampleList
          t={t}
          examples={suggestions.examples}
          target={target}
          kind="SUGGESTED"
          actions={actions}
          {...(suggestionsNextHref === undefined ? {} : { nextHref: suggestionsNextHref })}
        />
      </section>

      <section>
        <h2>{t.t("style.examplesTitle")}</h2>
        <form action={addStyleExampleAction.bind(null, target)} className="knowledge-editor">
          <label htmlFor="style-inbound">{t.t("style.exampleInbound")}</label>
          <textarea id="style-inbound" name="inbound" rows={2} required />
          <label htmlFor="style-outbound">{t.t("style.exampleOutbound")}</label>
          <textarea id="style-outbound" name="outbound" rows={3} required />
          <button className="button primary" type="submit" data-action="add-example">
            {t.t("style.addExample")}
          </button>
        </form>
        <StyleExampleList
          t={t}
          examples={verified.examples}
          target={target}
          kind="VERIFIED"
          actions={actions}
          {...(verifiedNextHref === undefined ? {} : { nextHref: verifiedNextHref })}
        />
      </section>
    </>
  );
}
