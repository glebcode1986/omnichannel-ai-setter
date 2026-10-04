/**
 * One knowledge source, with its version history (Issue #31).
 *
 * The history is the point. Every version's wording is readable, and only the current one is marked as
 * the one retrieval can reach — so "what did we used to tell customers?" has an answer, and "what are we
 * telling them now?" has exactly one.
 */
import { notFound } from "next/navigation";
import { readKnowledge } from "@omnichannel/db";

import { KnowledgeEditor } from "@/ui/knowledge/knowledge-editor";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { archiveKnowledgeAction, editKnowledgeAction, publishKnowledgeAction, restoreKnowledgeAction } from "@/server/knowledge-actions";
import type { RawSearchParams } from "@/server/inbox-view";

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

export default async function KnowledgeDocumentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string; readonly documentId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId, documentId } = await params;
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const document = await readKnowledge(getDb(), context, documentId);
  if (document === undefined) {
    notFound();
  }

  const target = { workspaceId, businessProfileId };
  const current = document.versions.find((version) => version.current);

  return (
    <>
      <div className="page-header">
        <h1>{document.title}</h1>
        <span className="conversation-badges">
          <span className="badge" data-tone={document.status === "ACTIVE" ? "ok" : "muted"} data-status={document.status}>
            {t.t(`knowledgeStatus.${document.status as "DRAFT"}`)}
          </span>
          <span
            className="badge"
            data-tone={document.indexingState === "FAILED" ? "stop" : document.indexingState === "INDEXED" ? "ok" : "warn"}
            data-indexing={document.indexingState}
          >
            {t.t(`indexing.${document.indexingState as "PENDING"}`)}
          </span>
        </span>
      </div>

      <OutcomeNotice t={t} outcome={one((await searchParams)["outcome"])} />

      {document.indexingState === "FAILED" ? (
        <div className="notice" data-tone="stop" data-indexing-failed="true">
          <p>{t.t("indexing.failedDetail")}</p>
          {document.indexingError === null ? undefined : <p className="muted">{document.indexingError}</p>}
        </div>
      ) : undefined}

      <div className="control-row">
        {document.status === "ACTIVE" ? (
          <form action={archiveKnowledgeAction.bind(null, target, documentId)}>
            <button className="button" type="submit" data-action="archive">
              {t.t("knowledge.archive")}
            </button>
          </form>
        ) : (
          <form action={(document.status === "DRAFT" ? publishKnowledgeAction : restoreKnowledgeAction).bind(null, target, documentId)}>
            <button className="button" type="submit" data-action={document.status === "DRAFT" ? "publish" : "restore"}>
              {document.status === "DRAFT" ? t.t("knowledge.publish") : t.t("knowledge.restore")}
            </button>
          </form>
        )}
      </div>

      <section>
        <KnowledgeEditor
          t={t}
          target={target}
          document={{ id: documentId, title: document.title, facts: (current?.chunks ?? []).map((chunk) => chunk.content), scope: document.scope }}
          action={editKnowledgeAction.bind(null, target, documentId)}
        />
      </section>

      {document.publishedVersion !== null && document.publishedVersion !== document.version ? (
        <p className="notice" data-tone="warn" data-unpublished="true">
          {t.t("knowledge.unpublishedEdit", { saved: String(document.version), published: String(document.publishedVersion) })}
        </p>
      ) : undefined}

      <section className="knowledge-history">
        <h2>{t.t("knowledge.versionHistory")}</h2>
        <ol>
          {document.versions.map((version) => (
            <li key={version.version} data-version={version.version} data-current={String(version.current)} data-published={String(version.published)}>
              <h3>{versionLabel(t, version)}</h3>
              <ul>
                {version.chunks.map((chunk) => (
                  <li key={chunk.id}>{chunk.content}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/**
 * Three states, because an edit to a live source creates a real difference between them: the version
 * customers are answered with, the version somebody has saved on top of it, and the ones replaced before
 * either. Labelling the latest save "in use now" is what made Save look like a publish.
 */
function versionLabel(t: Translator, version: { readonly version: number; readonly current: boolean; readonly published: boolean }): string {
  if (version.published) {
    return t.t(version.current ? "knowledge.versionCurrent" : "knowledge.versionPublished", { version: String(version.version) });
  }
  return t.t(version.current ? "knowledge.versionSaved" : "knowledge.versionOld", { version: String(version.version) });
}
