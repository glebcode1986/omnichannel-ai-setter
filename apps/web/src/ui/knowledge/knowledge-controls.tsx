/**
 * The lifecycle controls for one knowledge source (Issue #31).
 *
 * Two properties, and both of them were broken on the page this replaces.
 *
 * **Every version that is not the published one can be published.** The previous branch offered Archive to
 * every ACTIVE document and Publish only to DRAFTs, so a live source someone had edited showed the
 * "saved v2, customers are answered with v1" warning above a row whose only button was Archive. The store
 * could publish it; the operator could not. `knowledgeLifecycleOf` holds the rule now, so it is one
 * sentence with a test on it rather than a ternary nested in a page.
 *
 * **Every control carries the version it was rendered against.** Publishing is the only act that changes
 * what customers are told, and a button that posts "publish this document" rather than "publish version 2"
 * publishes whatever is current by the time it arrives. Two tabs on the same draft is all it takes: one
 * saves, the other clicks Publish, and content nobody reviewed is live with a success notice over it. The
 * hidden field makes the server able to refuse.
 *
 * Archive carries none, deliberately: it removes the source from retrieval whatever its current wording
 * is, so there is no newer version it could be deciding about by mistake.
 */
import type { Translator } from "@/i18n/translate";
import { knowledgeLifecycleOf } from "@/server/knowledge-view";
import type { KnowledgeTarget } from "@/server/knowledge-submission";

type DocumentAction = (target: KnowledgeTarget, documentId: string, formData: FormData) => Promise<void>;
type DocumentActionWithoutForm = (target: KnowledgeTarget, documentId: string) => Promise<void>;

export interface KnowledgeControlsProps {
  readonly t: Translator;
  readonly target: KnowledgeTarget;
  readonly documentId: string;
  readonly document: {
    readonly status: string;
    readonly version: number;
    readonly publishedVersion: number | null;
  };
  readonly actions: {
    readonly publish: DocumentAction;
    readonly restore: DocumentAction;
    readonly archive: DocumentActionWithoutForm;
  };
}

export function KnowledgeControls({ t, target, documentId, document, actions }: KnowledgeControlsProps) {
  const lifecycle = knowledgeLifecycleOf(document);
  const version = String(document.version);

  return (
    <div className="control-row">
      {lifecycle === undefined ? undefined : (
        <form action={(lifecycle === "publish" ? actions.publish : actions.restore).bind(null, target, documentId)}>
          <input type="hidden" name="expectedVersion" value={version} />
          <button className="button" type="submit" data-action={lifecycle} data-expected-version={version}>
            {lifecycle === "restore"
              ? t.t("knowledge.restore")
              : document.publishedVersion === null
                ? t.t("knowledge.publish")
                : // A source that already answers customers needs the button to name the version it would
                  // switch them to: "make it answerable" is a lie about a document that is already answerable.
                  t.t("knowledge.publishVersion", { version })}
          </button>
        </form>
      )}

      {document.status === "ACTIVE" ? (
        <form action={actions.archive.bind(null, target, documentId)}>
          <button className="button" type="submit" data-action="archive">
            {t.t("knowledge.archive")}
          </button>
        </form>
      ) : undefined}
    </div>
  );
}
