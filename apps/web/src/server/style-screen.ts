/**
 * Which rows the Style Training screen shows (Issue #32).
 *
 * Deliberately free of the authenticated request path, so a test can drive it against a real database.
 * `style-page.ts` adds the authorization and the translator; it cannot be imported under Vitest, because
 * Auth.js reaches for Next's server runtime — which is how this assembly came to be untested in the first
 * place, and why the screen's own integration test used to reissue its queries by hand.
 *
 * It is the half of the screen that has been wrong twice: once by paging in the store and not on screen,
 * and once by loading only the two statuses that had a list, leaving archived and rejected examples
 * unreachable. Both times the mistake was in code no test could call.
 */
import {
  listStyleExamples,
  readStyleProfiles,
  type BusinessProfileContext,
  type DbClient,
  type StyleExamplePage,
  type StyleProfileLayerView,
} from "@omnichannel/db";

import type { RawSearchParams } from "@/server/inbox-view";
import type { StyleTestResult } from "@/server/style-test";
import { one, styleCursorOf, styleNextHref } from "@/server/style-view";

export interface StyleScreenLists {
  readonly layers: readonly StyleProfileLayerView[];
  readonly verified: StyleExamplePage;
  readonly suggestions: StyleExamplePage;
  /**
   * Examples somebody withdrew or declined.
   *
   * Rendered because otherwise they are unreachable: archiving an example or rejecting a suggestion made
   * the row vanish from both lists, and the restore control had nothing to render against. The store
   * could restore, the component could draw the button, and no user could ever get to either.
   */
  readonly retired: StyleExamplePage;
  /** The style test: the effective voice, the examples retrieval would pick, and a candidate reply. */
  readonly test: StyleTestResult;
  /** What the operator asked, so the form can show it back and the screen can tell "empty" from "nothing". */
  readonly ask?: string;
  readonly basePath: string;
  /** Where the rest of each list is, or `undefined` when this is all of it. */
  readonly verifiedNextHref?: string;
  readonly suggestionsNextHref?: string;
  readonly retiredNextHref?: string;
}

/**
 * Every list this screen renders, and the links to the rest of each one.
 *
 * The style test arrives already run, because this function is about which rows the screen shows and a
 * test of that should not need a provider key or an embedding key to run.
 */
export async function assembleStyleScreen(
  db: DbClient,
  context: BusinessProfileContext,
  searchParams: RawSearchParams,
  basePath: string,
  test: StyleTestResult,
): Promise<StyleScreenLists> {
  const ask = one(searchParams["ask"]);
  const [layers, verified, suggestions, archived, rejected] = await Promise.all([
    readStyleProfiles(db, context),
    listStyleExamples(db, context, { status: "ACTIVE" }, { cursor: styleCursorOf(searchParams, "verified") }),
    listStyleExamples(db, context, { status: "SUGGESTED" }, { cursor: styleCursorOf(searchParams, "suggested") }),
    listStyleExamples(db, context, { status: "ARCHIVED" }, { cursor: styleCursorOf(searchParams, "retired") }),
    listStyleExamples(db, context, { status: "REJECTED" }, {}),
  ]);
  // One list for both, because they are the same thing to the person looking: an example that is not in
  // use and could be. The cursor follows the archived half, which is the one that grows.
  const retired: StyleExamplePage = {
    ...archived,
    examples: [...archived.examples, ...rejected.examples],
  };

  return {
    layers,
    verified,
    suggestions,
    retired,
    test,
    ...(ask === undefined ? {} : { ask }),
    basePath,
    ...(verified.nextCursor === undefined ? {} : { verifiedNextHref: styleNextHref(basePath, searchParams, "verified", verified.nextCursor) }),
    ...(suggestions.nextCursor === undefined ? {} : { suggestionsNextHref: styleNextHref(basePath, searchParams, "suggested", suggestions.nextCursor) }),
    ...(retired.nextCursor === undefined ? {} : { retiredNextHref: styleNextHref(basePath, searchParams, "retired", retired.nextCursor) }),
  };
}
