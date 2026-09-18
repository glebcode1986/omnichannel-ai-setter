-- Language of a style example (product-owner decision on PR #66).
--
-- Retrieving a Russian example to shape a German reply teaches the model the wrong rhythm, and without a
-- recorded language the only alternative is guessing from the text — a heuristic that would be wrong
-- exactly where the example matters most. A NULL is not "unknown but probably fine": it means the example
-- is language-agnostic and may back any language, which is the safe fallback.

ALTER TABLE "style_examples" ADD COLUMN "language" TEXT;

-- Matching-language examples are preferred, so the lookup filters on it; language-agnostic rows still
-- qualify, hence the NULL branch in the index predicate rather than a plain equality index.
CREATE INDEX "style_examples_language_idx" ON "style_examples"("workspace_id", "business_profile_id", "language");
