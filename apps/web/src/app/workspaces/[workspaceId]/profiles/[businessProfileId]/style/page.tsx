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
import { StyleTestPanel } from "@/ui/style/style-test-panel";
import { AddExampleForm } from "@/ui/style/add-example-form";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { loadStyleScreen } from "@/server/style-page";
import { one } from "@/server/style-view";
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
  const { t, layers, verified, suggestions, retired, test, ask, basePath, verifiedNextHref, suggestionsNextHref, retiredNextHref } =
    await loadStyleScreen(workspaceId, businessProfileId, query);
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

      <StyleTestPanel t={t} test={test} basePath={basePath} {...(ask === undefined ? {} : { ask })} />

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
        <AddExampleForm t={t} target={target} action={addStyleExampleAction.bind(null, target)} />
        <StyleExampleList
          t={t}
          examples={verified.examples}
          target={target}
          kind="VERIFIED"
          actions={actions}
          {...(verifiedNextHref === undefined ? {} : { nextHref: verifiedNextHref })}
        />
      </section>

      {/*
        Withdrawn and declined examples. Without this section the restore control was unreachable: the
        row left both rendered lists the moment somebody archived or rejected it, and nothing ever passed
        an ARCHIVED or REJECTED example to the component that knows how to bring one back.
      */}
      <section>
        <h2>{t.t("style.retiredTitle")}</h2>
        <p className="muted">{t.t("style.retiredExplain")}</p>
        <StyleExampleList
          t={t}
          examples={retired.examples}
          target={target}
          kind="RETIRED"
          actions={actions}
          {...(retiredNextHref === undefined ? {} : { nextHref: retiredNextHref })}
        />
      </section>
    </>
  );
}
