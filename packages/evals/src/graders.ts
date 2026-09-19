/**
 * Text graders: the subjective half, kept firmly out of the assertions.
 *
 * These are heuristics, and they are honest about being heuristics. They exist to notice a *drift* — a
 * reply that stopped mentioning the fact it used to mention, or started answering German questions in
 * English — not to decide whether a sentence is good. A score never gates a merge on its own; it reports.
 *
 * The interface is pluggable so a model-based grader can be substituted later. Nothing else in the harness
 * knows how a score was produced, which is what keeps a grader swap from rewriting the goldens.
 */
export interface Grader {
  readonly name: string;
  /** 0-1, or undefined when this grader has nothing to say about the case. */
  grade(reply: string, expectations: GraderExpectations): number | undefined;
}

export interface GraderExpectations {
  readonly expectedTerms?: readonly string[];
  readonly expectedLanguage?: string;
}

/** How much of what a good answer should mention actually appears. */
export const termCoverageGrader: Grader = {
  name: "term-coverage",
  grade(reply, expectations) {
    const terms = expectations.expectedTerms ?? [];
    if (terms.length === 0) {
      return undefined;
    }
    const haystack = reply.toLowerCase();
    const found = terms.filter((term) => haystack.includes(term.toLowerCase())).length;
    return found / terms.length;
  },
};

/**
 * Whether the reply is written in the language the customer used.
 *
 * Script detection rather than a language model: it distinguishes Cyrillic from Latin reliably and cheaply,
 * and it is honest about the rest — for two languages sharing a script it returns `undefined` rather than
 * guessing, because a grader that answers confidently when it cannot tell is worse than one that abstains.
 */
export const languageGrader: Grader = {
  name: "language",
  grade(reply, expectations) {
    const expected = expectations.expectedLanguage;
    if (expected === undefined) {
      return undefined;
    }
    const script = dominantScript(reply);
    const expectedScript = SCRIPT_BY_LANGUAGE[expected.split("-")[0]?.toLowerCase() ?? ""];
    if (script === undefined || expectedScript === undefined) {
      return undefined;
    }
    return script === expectedScript ? 1 : 0;
  },
};

const SCRIPT_BY_LANGUAGE: Readonly<Record<string, "CYRILLIC" | "LATIN">> = {
  ru: "CYRILLIC",
  uk: "CYRILLIC",
  en: "LATIN",
  de: "LATIN",
  fr: "LATIN",
  es: "LATIN",
};

function dominantScript(text: string): "CYRILLIC" | "LATIN" | undefined {
  let cyrillic = 0;
  let latin = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x0400 && code <= 0x04ff) {
      cyrillic += 1;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1;
    }
  }
  if (cyrillic + latin === 0) {
    return undefined;
  }
  return cyrillic > latin ? "CYRILLIC" : "LATIN";
}

export const DEFAULT_GRADERS: readonly Grader[] = [termCoverageGrader, languageGrader];
