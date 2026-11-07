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
import type { KnowledgeTarget } from "@/server/knowledge-submission";
import { Select } from "@/ui/select";

export interface KnowledgeEditorProps {
  readonly t: Translator;
  readonly target: KnowledgeTarget;
  /**
   * Absent when writing a new source; present when editing one.
   *
   * `version` is the one the form was rendered against, and it is submitted with the edit. Two tabs
   * opened on the same source both show v1; without it the second save overwrites the first with wording
   * composed against content it never saw, and nothing on either screen says so.
   */
  readonly document?: {
    readonly id: string;
    readonly title: string;
    readonly facts: readonly string[];
    readonly scope: string;
    readonly version: number;
  };
  readonly action: (formData: FormData) => Promise<void>;
  /** A fact suggested by a review item the assistant could not answer. */
  readonly suggestedTitle?: string;
}

export function KnowledgeEditor({ t, document, action, suggestedTitle }: KnowledgeEditorProps) {
  const isNew = document === undefined;

  return (
    <form action={action} className="form-grid">
      {/* What this form was rendered against. The store refuses an edit whose expected version is not the
          current one, so a stale tab is told rather than silently winning. */}
      {document === undefined ? undefined : <input type="hidden" name="expectedVersion" value={String(document.version)} />}

      <div className="field">
        <label htmlFor="knowledge-title">{t.t("knowledge.titleLabel")}</label>
        <input id="knowledge-title" name="title" type="text" defaultValue={document?.title ?? suggestedTitle ?? ""} required />
      </div>

      {/* Scope is fixed once a source exists: moving base knowledge into one profile, or the reverse,
          changes who it answers for, and doing that through an edit form would be a silent migration. */}
      {isNew ? (
        <div className="field">
          <label htmlFor="knowledge-scope">{t.t("knowledge.scopeLabel")}</label>
          <Select
            id="knowledge-scope"
            name="scope"
            value="BUSINESS_PROFILE"
            options={[
              { value: "BUSINESS_PROFILE", label: t.t("knowledge.scopeProfile") },
              { value: "WORKSPACE", label: t.t("knowledge.scopeWorkspace") },
            ]}
          />
        </div>
      ) : undefined}

      {/* One fact per line, so the box takes the row rather than half of it. */}
      <div className="field" data-span="full">
        <label htmlFor="knowledge-facts">{t.t("knowledge.factsLabel")}</label>
        <textarea id="knowledge-facts" name="facts" rows={8} defaultValue={document?.facts.join("\n") ?? ""} required />
        <p className="muted">{t.t("knowledge.factsHint")}</p>
      </div>

      <div className="form-actions" data-span="full">
        <button className="button" data-variant="primary" type="submit" data-action={isNew ? "create" : "save"}>
          {isNew ? t.t("knowledge.create") : t.t("knowledge.save")}
        </button>
      </div>
    </form>
  );
}
