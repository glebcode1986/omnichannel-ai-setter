/**
 * `pnpm release:review` — files an independent reviewer's verdict about one exact commit (#60, §20).
 *
 * The other half of §20's "reviewer status and exact reviewed SHAs", and the reason it is a separate
 * command rather than a flag on the release script: the two are done by different people, and a release
 * script that could also record its own approval would make "independent" a word in a document. A verdict
 * recorded here is attached to the SHA it names and to nothing else, so filing one for the wrong commit
 * is visible rather than silently effective — the command reports how many recorded candidates it bears
 * on, and zero is the number a forty-character typo produces.
 */
import process from "node:process";

import { createDbClient } from "../../packages/db/src/client.ts";
import { authorizePlatformAccess } from "../../packages/db/src/platform-tenancy.ts";
import { recordReleaseReview } from "../../packages/db/src/release-store.ts";
import { isReviewVerdict } from "../../packages/domain/src/release.ts";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sha = flag("sha");
const reviewer = flag("reviewer");
const verdict = flag("verdict");
if ((sha ?? "").length !== 40 || (reviewer ?? "").trim() === "" || verdict === undefined || !isReviewVerdict(verdict)) {
  console.error("usage: pnpm release:review --sha <40 hex> --reviewer <name> --verdict PASS|CHANGES_REQUESTED [--reference <url>]");
  console.error("the SHA must be the full forty characters: an abbreviation is how a verdict moves to the wrong commit");
  process.exit(2);
}

const actorUserId = flag("actor") ?? process.env["RELEASE_ACTOR_USER_ID"];
const connectionString = process.env["DATABASE_URL"];
if ((actorUserId ?? "").trim() === "" || (connectionString ?? "").trim() === "") {
  console.error("--actor or RELEASE_ACTOR_USER_ID and DATABASE_URL are both required");
  process.exit(2);
}

const db = createDbClient({ connectionString: connectionString ?? "" });
try {
  const context = await authorizePlatformAccess(db, actorUserId ?? "");
  const reference = flag("reference");
  const filed = await recordReleaseReview(db, context, {
    reviewer: (reviewer ?? "").trim(),
    verdict,
    reviewedSha: sha ?? "",
    ...(reference === undefined ? {} : { reference }),
    submittedAt: new Date(),
  });
  process.stdout.write(`filed ${verdict} from ${(reviewer ?? "").trim()} about ${sha}\n`);
  process.stdout.write(
    filed.candidates === 0
      ? "no release candidate has been recorded at that commit, so this verdict counts for nothing yet — check the SHA\n"
      : `it bears on ${filed.candidates} recorded candidate(s)\n`,
  );
} finally {
  await db.$disconnect();
}
