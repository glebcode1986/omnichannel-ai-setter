/**
 * The loop that makes a scheduled follow-up actually happen (#55, Issue #82's first P1).
 *
 * `GOALS_FOLLOWUPS.md` says what this file is for in one sentence: "at execution it asks for a reply
 * through the path every automated send already uses. **There is no second send path.**" So this sweeper
 * does exactly two things — it finds the follow-ups that are due, and it hands each `READY` claim to the
 * same AI-draft job an inbound message would have enqueued. It generates nothing, decides nothing about
 * sending, and touches no provider.
 *
 * Without it, `dueFollowUps`, `claimFollowUp` and `recordFollowUpSent` had no runtime caller at all: the
 * whole feature was a correct store with nobody asking it anything, which is the defect class this
 * repository keeps producing and the one Astra blocked PR #82 for.
 *
 * **The claim decides; this loop only reports.** Every reason a follow-up should not go out — a newer
 * inbound, a human takeover, a pending review, an opt-out, a lost entitlement, an ineligible channel, a
 * terminal goal, a stale anchor, the attempt bound, the business's own hours — is re-read inside
 * `claimFollowUp`'s transaction, under a lock on the conversation. Re-asking any of it here would be a
 * second implementation of the rule, and the second one is always the one nobody checks.
 *
 * **A claim that cannot be enqueued is left claimed.** The lease is what makes that safe: the follow-up
 * becomes claimable again once it lapses, and the next claim finds no draft for the attempt that failed —
 * so it retries, spending another of the bounded attempts. A Redis outage between the claim and the
 * enqueue therefore costs one attempt out of three rather than a lost or a doubled follow-up, and the
 * bound is what stops that from becoming a loop. Deliberately not undone here: rolling the attempt back
 * would mean deciding, outside the claim's transaction and without its lock, that no message went out.
 */
import type { DueFollowUp, FollowUpClaim } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import type { QueueProducer } from "@omnichannel/queue";

import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface FollowUpSweeperOptions {
  readonly intervalMs: number;
  /** How many due follow-ups one pass takes. A bound, so one busy minute cannot starve the loop. */
  readonly limit: number;
  readonly due: (options: { readonly now: Date; readonly limit: number }) => Promise<readonly DueFollowUp[]>;
  /** Re-asks every gate and spends an attempt, or settles the follow-up. The decision, in one place. */
  readonly claim: (followUpId: string, now: Date) => Promise<FollowUpClaim>;
  readonly producer: QueueProducer;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Correlation id for one pass's jobs, so a follow-up's path is traceable end to end. */
  readonly newCorrelationId: () => string;
}

export function startFollowUpSweeper(options: FollowUpSweeperOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "follow_ups_swept",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const at = options.now();
      const due = await options.due({ now: at, limit: options.limit });
      if (due.length === 0) {
        return undefined;
      }
      let enqueued = 0;
      let settled = 0;
      let recovered = 0;
      for (const followUp of due) {
        // One claim per follow-up, each in its own transaction: a conversation locked for one claim must
        // not hold the lock while another follow-up's model call happens.
        const claim = await options.claim(followUp.id, options.now());
        if (claim.status === "READY") {
          await options.producer.enqueueAiDraftGeneration({
            schemaVersion: 1,
            workspaceId: followUp.workspaceId,
            businessProfileId: followUp.businessProfileId,
            correlationId: options.newCorrelationId(),
            conversationId: claim.conversationId,
            anchorMessageId: claim.anchorMessageId,
            // The attempt is part of the job's identity, so re-enqueueing this attempt is the same job
            // and a second allowed attempt is a different one.
            trigger: { kind: "FOLLOW_UP", followUpId: claim.followUpId, attempt: claim.attempt },
          });
          enqueued += 1;
          continue;
        }
        if (claim.status === "ALREADY_SENT") {
          // The crash window, closed by the claim rather than here: a previous attempt's operation was
          // found and recorded. Counted separately because a run of these is an outage worth seeing.
          recovered += 1;
          continue;
        }
        if (claim.status === "STOPPED") {
          settled += 1;
        }
      }
      return enqueued === 0 && settled === 0 && recovered === 0 ? undefined : { due: due.length, enqueued, settled, recovered };
    },
  });
}
