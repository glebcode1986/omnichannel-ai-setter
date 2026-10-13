/**
 * The release record, on a screen (#60, LAUNCH_READINESS.md §20).
 *
 * §20 asks for a release record to be stored *or attached*; storing one nobody can read is half the job,
 * and the unread half is the one that matters during an incident — "which stage are we in, and what did
 * that release say was switched off" is a question asked at speed and answered badly from memory.
 *
 * What the pane states rather than implies:
 *
 * - **The stage in force has three answers, not two.** A window full of unreviewed proposals is
 *   `INDETERMINATE`, and the send path treats that as a refusal. A screen that showed "no release" there
 *   would be describing the permissive state while the product was in the restrictive one.
 * - **Nothing shown here is stored.** The decision, the reviewer status and the capabilities a `HIGH`
 *   switched off are recomputed from the gate rows every time this renders, so the page cannot disagree
 *   with the record the way a cached verdict column would.
 * - **A verdict belongs to a commit.** Each candidate shows its own SHA and the reviewer status *for that
 *   SHA*, because the mistake this exists to prevent is reading a PASS given to an earlier commit.
 */
import type { ReleaseInForce, ReleaseView } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

function short(sha: string): string {
  return sha.slice(0, 12);
}

export function ReleaseHistory({ t, inForce, candidates }: { readonly t: Translator; readonly inForce: ReleaseInForce; readonly candidates: readonly ReleaseView[] }) {
  return (
    <section className="card" data-admin="releases">
      <h2>{t.t("admin.releasesTitle")}</h2>

      <p data-in-force={inForce.kind}>
        {inForce.kind === "IN_FORCE"
          ? t.t("admin.releaseInForce", { stage: t.t(`admin.rolloutStage.${inForce.stage}`), sha: short(inForce.sha) })
          : inForce.kind === "NONE"
            ? t.t("admin.releaseNoneInForce")
            : t.t("admin.releaseIndeterminate", { examined: String(inForce.examined) })}
      </p>
      {inForce.kind === "IN_FORCE" && inForce.disabledCapabilities.length > 0 ? (
        // `data-switched-off` rather than naming the word: `no-provider-payloads.test.ts` forbids a bare
        // lowercase `capabilities` in a pane because that is a channel's provider-shaped blob, and a
        // release capability is an unrelated sense of the word. Renaming here keeps that guard strict
        // rather than teaching it an exception it would then have to be trusted about.
        <p className="muted" data-switched-off={inForce.disabledCapabilities.join(",")}>
          {t.t("admin.releaseDisabledCapabilities", { list: inForce.disabledCapabilities.join(", ") })}
        </p>
      ) : undefined}

      {candidates.length === 0 ? (
        <p className="muted" data-candidates="none">
          {t.t("admin.releaseNoCandidates")}
        </p>
      ) : (
        <ul className="admin-releases">
          {candidates.map((candidate) => (
            <li
              key={candidate.releaseId}
              data-candidate={candidate.releaseId}
              data-approved={candidate.approved}
              data-reviewer={candidate.reviewer}
              data-stage={candidate.stage}
            >
              <p>
                {t.t("admin.releaseLine", {
                  sha: short(candidate.sha),
                  stage: t.t(`admin.rolloutStage.${candidate.stage}`),
                  reviewer: t.t(`admin.reviewerStatus.${candidate.reviewer}`),
                })}
              </p>
              <p className="muted">{candidate.summary}</p>
              {candidate.decision.releasable ? undefined : (
                <ul data-blockers={candidate.decision.blockers.length}>
                  {candidate.decision.blockers.map((blocker) => (
                    <li key={`${blocker.gateId}-${blocker.refusal}`}>
                      {t.t("admin.releaseBlocker", { gate: blocker.gateId, refusal: t.t(`admin.releaseRefusal.${blocker.refusal}`) })}
                    </li>
                  ))}
                </ul>
              )}
              {candidate.decision.knownLimitations.length === 0 ? undefined : (
                <p className="muted" data-limitations={candidate.decision.knownLimitations.length}>
                  {t.t("admin.releaseLimitations", { count: String(candidate.decision.knownLimitations.length) })}
                </p>
              )}
              <p className="muted">{t.t("admin.releaseRollback", { plan: candidate.rollbackPlan })}</p>
              {/* The migrations and the flags, shown because a rollback decision needs them: "can we
                  redeploy the previous tag" is a different question when this release carried schema
                  changes. They were recorded and displayed nowhere, which made them a column rather than
                  evidence. */}
              {candidate.migrations.length === 0 ? undefined : (
                <p className="muted" data-migrations={candidate.migrations.length}>
                  {t.t("admin.releaseMigrations", { count: String(candidate.migrations.length), newest: candidate.migrations.at(-1) ?? "" })}
                </p>
              )}
              {candidate.enabledFlags.length === 0 ? undefined : (
                <p className="muted" data-flags={candidate.enabledFlags.length}>
                  {t.t("admin.releaseFlags", { flags: candidate.enabledFlags.join(", ") })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
