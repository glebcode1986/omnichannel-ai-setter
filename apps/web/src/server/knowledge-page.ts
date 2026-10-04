/**
 * What the Knowledge Library route needs before it can render anything (Issue #31).
 *
 * It exists for the same reason `inbox-page.ts` does, and for one more. The route used to assemble this
 * itself, and the assembly is where the library lost its second page: the store paged at 25 and returned a
 * cursor, and the route simply never read one. Nothing failed — the first 25 rows were correct — so no test
 * of the store, the list or the cursor codec could have noticed. Only a test of the assembly can, and a
 * route component is the one thing in this app a test cannot call.
 *
 * So the assembly lives here, where `knowledge-screen.integration.test.ts` drives it against a real
 * database and follows the next link it produces.
 */
import { listKnowledge, type KnowledgeFilter, type KnowledgeLibraryPage } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { decodeKnowledgeCursor, knowledgeFilterOf, knowledgeNextHref, one } from "@/server/knowledge-view";
import { requireBusinessProfileContext } from "@/server/request-context";

export interface KnowledgeScreenData {
  readonly t: Translator;
  readonly filter: KnowledgeFilter;
  readonly page: KnowledgeLibraryPage;
  readonly basePath: string;
  /** Where the rest of the library is, or `undefined` when this is all of it. */
  readonly nextHref?: string;
  readonly context: Awaited<ReturnType<typeof requireBusinessProfileContext>>;
}

export async function loadKnowledgeScreen(
  workspaceId: string,
  businessProfileId: string,
  searchParams: RawSearchParams,
): Promise<KnowledgeScreenData> {
  // Authorization first, and before any of the business's facts are read.
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const filter = knowledgeFilterOf(searchParams);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}/knowledge`;

  const page = await listKnowledge(getDb(), context, filter, { cursor: decodeKnowledgeCursor(one(searchParams["cursor"])) });

  return {
    t,
    filter,
    page,
    basePath,
    ...(page.nextCursor === undefined ? {} : { nextHref: knowledgeNextHref(basePath, searchParams, page.nextCursor) }),
    context,
  };
}
