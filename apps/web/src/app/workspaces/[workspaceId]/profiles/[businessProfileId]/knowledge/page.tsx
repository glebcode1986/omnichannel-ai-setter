/**
 * The Knowledge Library (KNOWLEDGE_STYLE_UX.md, ADR-011, Issue #31).
 *
 * Facts are stated, never learned. Nothing on this page can turn a customer's message, an AI draft or a
 * style example into knowledge: the only route into the factual corpus is a person typing into the form
 * below, which is ADR-011's separation made physical.
 */
import { listKnowledge, type KnowledgeFilter } from "@omnichannel/db";

import { KnowledgeList } from "@/ui/knowledge/knowledge-list";
import { KnowledgeEditor } from "@/ui/knowledge/knowledge-editor";
import { RetrievalResults } from "@/ui/knowledge/retrieval-results";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { createKnowledgeAction } from "@/server/knowledge-actions";
import { runRetrievalTrial } from "@/server/retrieval-tester";
import type { RawSearchParams } from "@/server/inbox-view";

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

const STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
const INDEXING = ["PENDING", "INDEXED", "FAILED"] as const;
const SCOPES = ["WORKSPACE", "BUSINESS_PROFILE"] as const;

export default async function KnowledgePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const query = await searchParams;

  const status = one(query["status"]);
  const indexing = one(query["indexing"]);
  const scope = one(query["scope"]);
  const search = one(query["q"]);
  const filter: KnowledgeFilter = {
    ...((STATUSES as readonly string[]).includes(status ?? "") ? { status: status as KnowledgeFilter["status"] } : {}),
    ...((INDEXING as readonly string[]).includes(indexing ?? "") ? { indexingState: indexing as KnowledgeFilter["indexingState"] } : {}),
    ...((SCOPES as readonly string[]).includes(scope ?? "") ? { scope: scope as KnowledgeFilter["scope"] } : {}),
    ...(search === undefined ? {} : { search }),
  };

  const page = await listKnowledge(getDb(), context, filter);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}/knowledge`;

  // The tester runs the real retriever. Asking with no question is not asking, which is why the empty
  // query returns a trial that says nothing was searched rather than "nothing was found".
  const testQuery = one(query["ask"]);
  const trial = await runRetrievalTrial(context, testQuery ?? "");

  return (
    <>
      <div className="page-header">
        <h1>{t.t("knowledge.title")}</h1>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      <section className="knowledge-tester">
        <h2>{t.t("tester.title")}</h2>
        <form action={basePath} method="get" role="search" className="inbox-search">
          <label htmlFor="knowledge-ask">{t.t("tester.queryLabel")}</label>
          <input id="knowledge-ask" name="ask" type="search" defaultValue={testQuery ?? ""} />
          <button className="button" type="submit">
            {t.t("tester.run")}
          </button>
        </form>
        <RetrievalResults t={t} mode={trial.mode} hits={trial.hits} unavailable={trial.unavailable} asked={testQuery !== undefined} />
      </section>

      <section>
        <h2>{t.t("knowledge.newTitle")}</h2>
        <KnowledgeEditor
          t={t}
          target={{ workspaceId, businessProfileId }}
          action={createKnowledgeAction.bind(null, { workspaceId, businessProfileId })}
          {...(one(query["suggest"]) === undefined ? {} : { suggestedTitle: one(query["suggest"]) ?? "" })}
        />
      </section>

      <section>
        <h2>{t.t("knowledge.listLabel")}</h2>
        <form action={basePath} method="get" role="search" className="inbox-search">
          <label htmlFor="knowledge-q">{t.t("knowledge.searchLabel")}</label>
          <input id="knowledge-q" name="q" type="search" defaultValue={search ?? ""} />

          <label htmlFor="knowledge-status">{t.t("knowledge.filterStatus")}</label>
          <select id="knowledge-status" name="status" defaultValue={filter.status ?? ""}>
            <option value="">{t.t("knowledge.allStatuses")}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t.t(`knowledgeStatus.${value}`)}
              </option>
            ))}
          </select>

          <label htmlFor="knowledge-indexing">{t.t("knowledge.filterIndexing")}</label>
          <select id="knowledge-indexing" name="indexing" defaultValue={filter.indexingState ?? ""}>
            <option value="">{t.t("knowledge.allIndexing")}</option>
            {INDEXING.map((value) => (
              <option key={value} value={value}>
                {t.t(`indexing.${value}`)}
              </option>
            ))}
          </select>

          <label htmlFor="knowledge-scope-filter">{t.t("knowledge.filterScope")}</label>
          <select id="knowledge-scope-filter" name="scope" defaultValue={filter.scope ?? ""}>
            <option value="">{t.t("knowledge.allScopes")}</option>
            <option value="WORKSPACE">{t.t("knowledge.scopeWorkspace")}</option>
            <option value="BUSINESS_PROFILE">{t.t("knowledge.scopeProfile")}</option>
          </select>

          <button className="button" type="submit">
            {t.t("inbox.applyFilters")}
          </button>
        </form>
        <p className="muted">{t.t("knowledge.searchHint")}</p>

        <KnowledgeList
          t={t}
          documents={page.documents}
          basePath={basePath}
          filtered={Object.keys(filter).length > 0}
        />
      </section>
    </>
  );
}
