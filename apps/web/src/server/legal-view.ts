/**
 * Loading a published legal document for a page (#121).
 *
 * Read from disk at render time rather than imported, for the reason `opengraph-image.tsx` reads the
 * mark the same way: the text is content, not code, and a change to it should not need the component
 * rebuilt around it. The path is resolved from `process.cwd()`, which is the application root in both
 * the dev server and the built image.
 *
 * The locale is the public one — the cookie the landing and sign-in pages already use — because nobody
 * reading this page is necessarily signed in, and a signed-in reader's stored preference is not the
 * question: they followed a link to a document and should get it in the language the site is showing
 * them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadWebEnv } from "@/env";
import type { UiLocale } from "@/i18n/locales";
import { legalDocumentPath, resolveDocument, type LegalDocumentName, type ResolvedDocument } from "@/server/legal-content";
import { parseLegalMarkdown } from "@/server/legal-markdown";

export function loadLegalDocument(name: LegalDocumentName, locale: UiLocale): ResolvedDocument {
  const source = readFileSync(path.join(process.cwd(), legalDocumentPath(name, locale)), "utf8");
  return resolveDocument(parseLegalMarkdown(source), loadWebEnv());
}
