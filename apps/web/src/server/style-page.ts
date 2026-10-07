/**
 * What the Style Training route needs before it can render anything (Issue #32).
 *
 * Authorization and the translator, around the assembly in `style-screen.ts`. The split is not cosmetic:
 * this module imports the authenticated request path, which cannot be loaded under Vitest, so everything a
 * test needs to drive lives on the other side of it.
 */
import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { requireBusinessProfileContext } from "@/server/request-context";
import { assembleStyleScreen, type StyleScreenLists } from "@/server/style-screen";
import { runStyleTest } from "@/server/style-test";
import { one } from "@/server/style-view";

export interface StyleScreenData extends StyleScreenLists {
  readonly t: Translator;
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
  const ask = one(searchParams["ask"]);

  // The test runs against the same scope the lists are read in, and it writes nothing: it resolves the
  // voice, retrieves examples and asks a model for one candidate reply.
  const test = await runStyleTest(context, ask ?? "");
  return { t, context, ...(await assembleStyleScreen(getDb(), context, searchParams, basePath, test)) };
}
