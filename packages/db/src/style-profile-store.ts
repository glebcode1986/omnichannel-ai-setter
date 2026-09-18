/**
 * Loads the layers that make up a Business Profile's voice (product-owner decision on PR #65).
 *
 * Two rows at most: the Workspace base and the Business Profile's override. They are returned in
 * increasing precedence for `resolveStyleProfile`, which merges them field by field — so a profile that
 * only wants a different sign-off does not have to restate a persona it is happy with.
 *
 * Draft generation is a system flow driven by a queue job, so the scope comes from the job's Workspace +
 * Business Profile rather than from a member context, exactly as for ingestion and draft context.
 */
import type { StyleProfileLayer } from "@omnichannel/domain";

import type { DbClient } from "./client";

export interface StyleProfileQuery {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

export interface StyleProfileStore {
  /** Layers in increasing precedence: Workspace base first, Business Profile override last. */
  load(query: StyleProfileQuery): Promise<readonly StyleProfileLayer[]>;
}

export function createStyleProfileStore(db: DbClient): StyleProfileStore {
  return {
    async load(query) {
      const rows = await db.styleProfile.findMany({
        where: { workspaceId: query.workspaceId, OR: [{ businessProfileId: null }, { businessProfileId: query.businessProfileId }] },
        select: {
          businessProfileId: true,
          persona: true,
          tone: true,
          replyLength: true,
          emoji: true,
          greeting: true,
          signOff: true,
          preferredPhrases: true,
          avoidedPhrases: true,
          language: true,
        },
      });

      // Base first, override second. Sorting here rather than in SQL keeps the precedence visible next to
      // the comment that explains it.
      const ordered = [...rows].sort((left, right) => Number(left.businessProfileId !== null) - Number(right.businessProfileId !== null));
      return ordered.map((row) => ({
        // A NULL column means "no opinion at this layer", which is not the same as an empty string: the
        // first would defer to the layer beneath and the second would blank it out.
        ...(row.persona === null ? {} : { persona: row.persona }),
        ...(row.tone === null ? {} : { tone: row.tone }),
        ...(row.replyLength === null ? {} : { replyLength: row.replyLength }),
        ...(row.emoji === null ? {} : { emoji: row.emoji }),
        ...(row.greeting === null ? {} : { greeting: row.greeting }),
        ...(row.signOff === null ? {} : { signOff: row.signOff }),
        preferredPhrases: row.preferredPhrases,
        avoidedPhrases: row.avoidedPhrases,
        ...(row.language === null ? {} : { language: row.language }),
      }));
    },
  };
}
