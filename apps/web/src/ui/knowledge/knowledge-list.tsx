/**
 * The Knowledge Library's list (KNOWLEDGE_STYLE_UX.md, Issue #31).
 *
 * Two states an operator has to be able to tell apart at a glance, because they look identical in a naive
 * list and mean opposite things: a source that is **in use** and a source that *says* it is in use but
 * never indexed. The second one is the dangerous one — the business believes it has told the assistant
 * something it has not — so indexing state is its own badge next to status rather than folded into it.
 *
 * Search here matches titles. The hint says so, and points at the tester, because an operator who searched
 * the library for a fact and found nothing would reasonably conclude the fact is missing — when what
 * happened is that a different matcher looked.
 */
import Link from "next/link";
import type { KnowledgeSummary } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export interface KnowledgeListProps {
  readonly t: Translator;
  readonly documents: readonly KnowledgeSummary[];
  readonly basePath: string;
  readonly filtered: boolean;
  readonly nextHref?: string;
}

const KNOWN_STATUSES = new Set(["DRAFT", "ACTIVE", "ARCHIVED"]);
const KNOWN_INDEXING = new Set(["PENDING", "INDEXED", "FAILED"]);

export function KnowledgeList({ t, documents, basePath, filtered, nextHref }: KnowledgeListProps) {
  if (documents.length === 0) {
    return (
      <p className="muted" data-empty="true">
        {filtered ? t.t("knowledge.emptyFiltered") : t.t("knowledge.empty")}
      </p>
    );
  }

  return (
    <>
      <ul className="knowledge-rows" aria-label={t.t("knowledge.listLabel")}>
        {documents.map((document) => (
          <li key={document.id}>
            <Link className="knowledge-row" href={`${basePath}/${document.id}`} data-document={document.id}>
              <span className="knowledge-name">{document.title}</span>
              <span className="conversation-badges">
                <span className="badge" data-tone={document.status === "ACTIVE" ? "ok" : "muted"} data-status={document.status}>
                  {statusLabel(t, document.status)}
                </span>
                {/* Separate from status on purpose: "in use" and "actually searchable" are different
                    claims, and a source that fails to index while looking live is the worst of them. */}
                <span
                  className="badge"
                  data-tone={document.indexingState === "FAILED" ? "stop" : document.indexingState === "INDEXED" ? "ok" : "warn"}
                  data-indexing={document.indexingState}
                >
                  {indexingLabel(t, document.indexingState)}
                </span>
                <span className="badge" data-tone="muted" data-scope={document.scope}>
                  {document.scope === "WORKSPACE" ? t.t("knowledge.scopeWorkspace") : t.t("knowledge.scopeProfile")}
                </span>
                <span className="badge" data-tone="muted" data-version={document.version}>
                  {t.t("knowledge.versionCurrent", { version: document.version })}
                </span>
              </span>
              <span className="muted">
                {t.t("knowledge.chunkCount", { count: document.chunkCount })} ·{" "}
                {t.t("knowledge.writtenBy", { name: document.createdByName ?? t.t("knowledge.unknownAuthor") })}
              </span>
              <time className="muted" dateTime={document.updatedAt.toISOString()}>
                {t.t("knowledge.updatedAt", { time: t.date(document.updatedAt, { dateStyle: "short", timeStyle: "short" }) })}
              </time>
              {document.indexingError === null ? undefined : (
                <span className="muted" data-indexing-error="true">
                  {document.indexingError}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {nextHref === undefined ? undefined : (
        <Link className="button" href={nextHref} data-load-more="true">
          {t.t("knowledge.loadMore")}
        </Link>
      )}
    </>
  );
}

function statusLabel(t: Translator, status: string): string {
  return KNOWN_STATUSES.has(status) ? t.t(`knowledgeStatus.${status}` as MessageKey) : status;
}

function indexingLabel(t: Translator, state: string): string {
  return KNOWN_INDEXING.has(state) ? t.t(`indexing.${state}` as MessageKey) : state;
}
