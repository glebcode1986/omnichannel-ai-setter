-- Who decided what about a style example, and when (#32, R5 review).
--
-- The status alone could not answer the questions this screen is actually asked. "Archived" does not say
-- who withdrew it; an example rejected, restored and archived again looked identical to one archived on
-- the first day; and restoring overwrote `approved_by_user_id`, destroying the identity of whoever
-- originally vouched for it.
CREATE TYPE "StyleDecision" AS ENUM ('APPROVED', 'REJECTED', 'ARCHIVED', 'RESTORED');

ALTER TABLE "style_examples"
  ADD COLUMN "decision" "StyleDecision",
  ADD COLUMN "decided_by_user_id" TEXT,
  ADD COLUMN "decided_at" TIMESTAMP(3);

ALTER TABLE "style_examples"
  ADD CONSTRAINT "style_examples_decider_fkey"
  FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A decision names somebody and happens at a moment. All three columns together or none of them: a
-- decision with no actor is one nobody can be asked about, and one with no time cannot be ordered
-- against the next.
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_decision_check" CHECK (
  ("decision" IS NULL AND "decided_by_user_id" IS NULL AND "decided_at" IS NULL)
  OR ("decision" IS NOT NULL AND "decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)
);

CREATE INDEX "style_examples_decided_idx" ON "style_examples" ("workspace_id", "business_profile_id", "decided_at" DESC);

-- Every decision anybody ever made, not only the last one.
--
-- The columns above answer "who withdrew this?". They cannot answer "what happened to it?", because each
-- decision overwrites the last — and an example rejected, restored and archived again is a different thing
-- from one archived on the first day, which is precisely what this screen is asked to tell apart.
CREATE TABLE "style_example_decisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "style_example_id" TEXT NOT NULL,
    "decision" "StyleDecision" NOT NULL,
    -- NOT NULL, unlike the example's own column: a decision nobody made is not a decision.
    "decided_by_user_id" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_example_decisions_pkey" PRIMARY KEY ("id")
);

-- RESTRICT throughout, like every other reference in this schema. A history that disappeared with the row
-- it describes could not answer a question about an example somebody had already removed, and these rows
-- are the audit trail the P5-06 archive/restore requirement asks for.
ALTER TABLE "style_example_decisions"
  ADD CONSTRAINT "style_example_decisions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "style_example_decisions"
  ADD CONSTRAINT "style_example_decisions_style_example_id_fkey"
  FOREIGN KEY ("style_example_id") REFERENCES "style_examples"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "style_example_decisions"
  ADD CONSTRAINT "style_example_decisions_decided_by_user_id_fkey"
  FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "style_example_decisions_workspace_id_style_example_id_decid_idx"
  ON "style_example_decisions" ("workspace_id", "style_example_id", "decided_at");
