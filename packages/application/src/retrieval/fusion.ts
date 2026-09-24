/**
 * Deterministic rank fusion (ADR-011: "combine candidates deterministically, RRF preferred for MVP").
 *
 * ## The formula
 *
 * For a candidate `d` appearing in ranked lists `L`, with 1-based position `rank_L(d)`:
 *
 *     score(d) = Σ_{L : d ∈ L}  1 / (K + rank_L(d))          with K = 60
 *
 * Reciprocal rank fusion uses only *positions*, never the underlying scores. That is the point: a
 * `ts_rank_cd` value and a cosine similarity are not on the same scale and cannot be added, averaged or
 * weighted without inventing a conversion that would quietly drift as either side changes.
 *
 * ## Why thresholds are not applied to this score
 *
 * Because the score depends only on positions, the best possible value is `2/(K+1) ≈ 0.0328` no matter how
 * good or bad the match is: a single irrelevant chunk that is the only candidate still scores `1/61`. A
 * relevance floor on a fused score would therefore filter by list length rather than by relevance. Floors
 * belong on each list's own native score, before fusion — see `RetrievalThresholds`.
 *
 * ## Why it is deterministic
 *
 * Floating-point addition is order-sensitive, so contributions are summed in a fixed list order, and equal
 * scores are broken by a stable total order (scope level, then ID). Two runs over the same candidates
 * therefore produce byte-identical output, which is what makes a retrieval result reproducible from an
 * audit row.
 */

/** Conventional RRF constant: large enough that the top few positions do not dominate outright. */
export const RRF_K = 60;

export interface RankedCandidate {
  readonly id: string;
  /** Profile-specific material sorts ahead of workspace-wide material when scores tie. */
  readonly scopeLevel: "WORKSPACE" | "BUSINESS_PROFILE";
}

export interface FusedCandidate {
  readonly id: string;
  readonly score: number;
  /** 1-based positions in the lists that contained this candidate, in the order the lists were given. */
  readonly ranks: readonly (number | undefined)[];
}

/**
 * Fuses ranked lists into one ordered result. Each list must already be in its own best-first order and
 * must not repeat an ID; a repeated ID would give one candidate two positions in the same list.
 */
export function fuseByReciprocalRank(
  lists: readonly (readonly RankedCandidate[])[],
  options: { readonly limit: number; readonly k?: number } = { limit: Number.MAX_SAFE_INTEGER },
): readonly FusedCandidate[] {
  const k = options.k ?? RRF_K;
  const scores = new Map<string, { score: number; scopeLevel: RankedCandidate["scopeLevel"]; ranks: (number | undefined)[] }>();

  lists.forEach((list, listIndex) => {
    const seen = new Set<string>();
    list.forEach((candidate, position) => {
      if (seen.has(candidate.id)) {
        // A duplicate inside one list would count the same candidate twice; the first position wins.
        return;
      }
      seen.add(candidate.id);
      const rank = position + 1;
      const existing = scores.get(candidate.id) ?? {
        score: 0,
        scopeLevel: candidate.scopeLevel,
        ranks: Array.from<undefined, number | undefined>({ length: lists.length }, () => undefined),
      };
      existing.score += 1 / (k + rank);
      existing.ranks[listIndex] = rank;
      scores.set(candidate.id, existing);
    });
  });

  return [...scores.entries()]
    .sort(([leftId, left], [rightId, right]) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      // Ties are real: two candidates at the same position in different lists score identically. Break them
      // by a fixed rule so the order never depends on Map iteration or on which query returned first.
      if (left.scopeLevel !== right.scopeLevel) {
        return left.scopeLevel === "BUSINESS_PROFILE" ? -1 : 1;
      }
      return leftId < rightId ? -1 : 1;
    })
    .slice(0, Math.max(0, Math.trunc(options.limit)))
    .map(([id, entry]) => ({ id, score: entry.score, ranks: entry.ranks }));
}
