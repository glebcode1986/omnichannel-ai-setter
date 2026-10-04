/**
 * What the Style Training route needs before it can render anything (Issue #32).
 *
 * It exists for the reason `knowledge-page.ts` and `review-page.ts` do, learned the same way three times:
 * the store paged both example lists and returned a cursor for each, and the route spent neither. Nothing
 * failed — the first 25 of each were correct — and a route component is the one thing a test in this app
 * cannot call. So the assembly lives here, where `style-screen.integration.test.ts` can drive it.
 */
import { listStyleExamples, readStyleProfiles, type StyleExamplePage, type StyleProfileLayerView } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { styleCursorOf, styleNextHref } from "@/server/style-view";
import { requireBusinessProfileContext } from "@/server/request-context";

export interface StyleScreenData {
  readonly t: Translator;
  readonly layers: readonly StyleProfileLayerView[];
  readonly verified: StyleExamplePage;
  readonly suggestions: StyleExamplePage;
  readonly basePath: string;
  /** Where the rest of each list is, or `undefined` when this is all of it. */
  readonly verifiedNextHref?: string;
  readonly suggestionsNextHref?: string;
  readonly context: Awaited<ReturnType<typeof requireBusinessProfileContext>>;
}

export async function loadStyleScreen(
  workspaceId: string,
  businessProfileId: string,
  searchParams: RawSearchParams,
): Promise<StyleScreenData> {
  // Authorization first, and before any of the business's wording is read.
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}/style`;

  const [layers, verified, suggestions] = await Promise.all([
    readStyleProfiles(getDb(), context),
    listStyleExamples(getDb(), context, { status: "ACTIVE" }, { cursor: styleCursorOf(searchParams, "verified") }),
    listStyleExamples(getDb(), context, { status: "SUGGESTED" }, { cursor: styleCursorOf(searchParams, "suggested") }),
  ]);

  return {
    t,
    layers,
    verified,
    suggestions,
    basePath,
    ...(verified.nextCursor === undefined ? {} : { verifiedNextHref: styleNextHref(basePath, searchParams, "verified", verified.nextCursor) }),
    ...(suggestions.nextCursor === undefined ? {} : { suggestionsNextHref: styleNextHref(basePath, searchParams, "suggested", suggestions.nextCursor) }),
    context,
  };
}
