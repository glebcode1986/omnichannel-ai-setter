/**
 * What a Knowledge form actually submitted, decided before anything is written (Issue #31).
 *
 * This lives beside the actions rather than inside them because it *is* the guard. A server action is a
 * public HTTP endpoint: the form the screen renders is one caller, and a constructed request with
 * whichever fields its author felt like sending is another. The two must get the same answer, and the
 * only way to know they do is to be able to run the decision on a `FormData` nobody's browser built.
 *
 * The decision that matters here is the expected version. A submission that does not carry a usable one
 * is refused rather than completed against whatever is current — which is the difference between telling
 * an operator their colleague got there first and silently overwriting their colleague's wording with
 * text composed against content this submission never saw. That rule lives in `form-fields.ts`, because
 * the Style and AI-settings forms ask it too and it must have one answer.
 */
import { expectedVersionOf, field } from "./form-fields";

export { expectedVersionOf, field };
export interface KnowledgeTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

export type KnowledgeOutcome =
  | "CREATED"
  | "VERSIONED"
  | "UNCHANGED"
  | "PUBLISHED"
  | "ARCHIVED"
  | "RESTORED"
  | "CONFLICT"
  | "GONE"
  | "REJECTED";

/** An accepted edit: the wording, and the version it was composed against. */
export interface KnowledgeEdit {
  readonly title: string;
  readonly chunks: readonly string[];
  readonly expectedVersion: number;
}


/**
 * One fact per line.
 *
 * Splitting is the operator's decision made visible, not a hidden heuristic: they can see exactly which
 * lines became which facts, and a retrieval hit later points at one of them. A silent splitter would make
 * provenance unexplainable — "which sentence did it cite?" would have no answer on screen.
 */
export function factsOf(formData: FormData): readonly string[] {
  return field(formData, "facts")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}


/** An edit, or `undefined` when it cannot be accepted without guessing at a version. */
export function knowledgeEditOf(formData: FormData): KnowledgeEdit | undefined {
  const expectedVersion = expectedVersionOf(formData);
  if (expectedVersion === undefined) {
    return undefined;
  }
  return { title: field(formData, "title"), chunks: factsOf(formData), expectedVersion };
}

const OUTCOMES: Readonly<Record<string, KnowledgeOutcome>> = {
  CREATED: "CREATED",
  VERSIONED: "VERSIONED",
  UNCHANGED: "UNCHANGED",
  ARCHIVED: "ARCHIVED",
  CONFLICT: "CONFLICT",
  // The same sentence as a conflict, because it is the same instruction: reload and look at what the
  // other person did. The store keeps them apart so the reason it refused is precise in an audit.
  STALE_STATE: "CONFLICT",
  GONE: "GONE",
  REJECTED: "REJECTED",
};

/**
 * The store's answer, as the word the next screen explains.
 *
 * `restoredMeans` exists because one store function serves two buttons: publishing a draft and using an
 * archived source again are the same write and different sentences.
 *
 * An unrecognised status becomes `REJECTED`, never a success. A store outcome added later should surface
 * as something an operator has to look at rather than as a quiet "published" for a write that may not
 * have happened.
 */
export function knowledgeOutcomeOf(status: string, restoredMeans: KnowledgeOutcome = "RESTORED"): KnowledgeOutcome {
  if (status === "RESTORED") {
    return restoredMeans;
  }
  return OUTCOMES[status] ?? "REJECTED";
}
