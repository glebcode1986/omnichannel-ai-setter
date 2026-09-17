/**
 * The Human Agent path (ADR-014, INSTAGRAM_ADAPTER.md).
 *
 * Meta allows a reply outside the standard 24-hour window, up to 7 days, only as human support; its policy
 * names "automated messages" as a disallowed usage. So this function is not reachable from `send`: it is a
 * separate member that demands a human actor identity, re-checks eligibility immediately before dispatch and
 * refuses — without dispatching — whenever anything is missing or unknown. A refusal is REJECTED, never
 * AMBIGUOUS, because nothing was sent.
 */
import type { ConversationPolicyContext, OutboundMessageCommand, SendResult } from "@omnichannel/channel-core";

import type { ResolvedInstagramConfig } from "./config";
import { checkSendableText, dispatch } from "./send";
import { evaluateHumanAgentEligibility } from "./window";

/** Who is sending. A background worker has no actor, and without one nothing is sent. */
export interface HumanActor {
  /** Workspace member who pressed send. */
  readonly userId: string;
  /** When the human action happened; recorded for audit by the caller. */
  readonly actedAt: Date;
}

export async function sendAsHumanAgent(
  config: ResolvedInstagramConfig,
  command: OutboundMessageCommand,
  actor: HumanActor,
  ctx: ConversationPolicyContext,
): Promise<SendResult> {
  if (actor.userId.trim().length === 0) {
    return { outcome: "REJECTED", retryable: false, code: "NO_HUMAN_ACTOR", message: "a human agent send requires an acting user" };
  }
  const checked = checkSendableText(command);
  if ("outcome" in checked) {
    return checked;
  }
  if (config.connectionState !== "CONNECTED") {
    return { outcome: "REJECTED", retryable: true, code: "ACCOUNT_NOT_CONNECTED", message: "channel account is not connected" };
  }
  // Re-checked here, not trusted from an earlier decision: approval or the window may have lapsed since.
  const eligibility = evaluateHumanAgentEligibility(ctx, config);
  if (eligibility.state !== "ELIGIBLE") {
    return { outcome: "REJECTED", retryable: false, code: `HUMAN_AGENT_${eligibility.state}`, message: eligibility.reason };
  }
  return dispatch(
    config,
    { recipient: { id: command.recipientExternalId }, message: { text: checked.text }, tag: "HUMAN_AGENT" },
    command.operationId,
  );
}
