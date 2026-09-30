/**
 * Writing a fact down (KNOWLEDGE_STYLE_UX.md, ADR-011, Issue #31).
 *
 * One fact per line, and the form says so. Splitting is the operator's decision made visible rather than
 * a hidden heuristic: they can see which lines became which facts, and a retrieval hit later points at one
 * of them. A silent splitter would make provenance unexplainable — "which sentence did it cite?" would
 * have no answer on screen.
 *
 * Saving produces a draft, or a new version. Never a live change to what customers are told: publishing is
 * a separate, deliberate act, and the button for it says what it does rather than "Save".
 */
import type { Translator } from "@/i18n/translate";
import type { KnowledgeTarget } from "@/server/knowledge-actions";

export interface KnowledgeEditorProps {
  readonly t: Translator;
  readonly target: KnowledgeTarget;
  /** Absent when writing a new source; present when editing one. */
  readonly document?: { readonly id: string; readonly title: string; readonly facts: readonly string[]; readonly scope: string };
  readonly action: (formData: FormData) => Promise<void>;
  /** A fact suggested by a review item the assistant could not answer. */
  readonly suggestedTitle?: string;
}

export function KnowledgeEditor({ t, document, action, suggestedTitle }: KnowledgeEditorProps) {
  const isNew = document === undefined;

  return (
    <form action={action} className="knowledge-editor">
      <label htmlFor="knowledge-title">{t.t("knowledge.titleLabel")}</label>
      <input id="knowledge-title" name="title" type="text" defaultValue={document?.title ?? suggestedTitle ?? ""} required />

      <label htmlFor="knowledge-facts">{t.t("knowledge.factsLabel")}</label>
      <textarea id="knowledge-facts" name="facts" rows={8} defaultValue={document?.facts.join("\n") ?? ""} required />
      <p className="muted">{t.t("knowledge.factsHint")}</p>

      {/* Scope is fixed once a source exists: moving base knowledge into one profile, or the reverse,
          changes who it answers for, and doing that through an edit form would be a silent migration. */}
      {isNew ? (
        <>
          <label htmlFor="knowledge-scope">{t.t("knowledge.scopeLabel")}</label>
          <select id="knowledge-scope" name="scope" defaultValue="BUSINESS_PROFILE">
            <option value="BUSINESS_PROFILE">{t.t("knowledge.scopeProfile")}</option>
            <option value="WORKSPACE">{t.t("knowledge.scopeWorkspace")}</option>
          </select>
        </>
      ) : undefined}

      <button className="button primary" type="submit" data-action={isNew ? "create" : "save"}>
        {isNew ? t.t("knowledge.create") : t.t("knowledge.save")}
      </button>
    </form>
  );
}
