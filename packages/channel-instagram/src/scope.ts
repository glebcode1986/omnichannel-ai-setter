/**
 * Refusing work this adapter has no business doing (R2 finding on PR #63).
 *
 * An adapter instance is bound to exactly one channel account of one Business Profile of one workspace,
 * and that binding is trusted: it comes from the account the route resolved, never from a payload. Every
 * other identifier reaching a send — the command's scope, the conversation, the recipient, the policy
 * context a caller supplies — is an argument, and arguments are checked.
 *
 * Without these checks the adapter would answer two questions with one set of credentials:
 *
 * - **whose account is this?** A command naming another workspace's channel account was dispatched anyway,
 *   through *this* account's token. One tenant could send as another;
 * - **whose window is this?** Eligibility was computed from the supplied context while the message went to
 *   `command.recipientExternalId`. A caller holding participant A's still-open Human Agent window could
 *   send a tagged message to participant B — a message Meta's policy permits only as support for the
 *   person whose window it actually is.
 *
 * Both refusals happen before a credential is resolved and before anything is dispatched, and both are
 * `REJECTED` rather than `AMBIGUOUS`: nothing was sent, and nothing about a retry could change the answer.
 *
 * The refusal names the field that disagreed and never the values. The values are tenant identifiers, and
 * a rejection message is a place an operator reads and a log keeps.
 */
import type { ConversationPolicyContext, OutboundMessageCommand, SendResult } from "@omnichannel/channel-core";

import type { ResolvedInstagramConfig } from "./config";

function refuse(field: string, detail: string): SendResult {
  return { outcome: "REJECTED", retryable: false, code: "SCOPE_MISMATCH", message: `${field} ${detail}` };
}

/** An identifier that is absent or blank cannot match anything, and must not match by being equally blank. */
function present(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * The command must belong to the account this adapter is bound to.
 *
 * Checked before content, because a foreign command whose text also happens to be too long should be
 * refused for the reason that matters: it is not ours to send at all.
 */
export function checkCommandScope(config: ResolvedInstagramConfig, command: OutboundMessageCommand): SendResult | undefined {
  const { binding } = config;
  for (const [field, bound, given] of [
    ["workspaceId", binding.workspaceId, command.workspaceId],
    ["businessProfileId", binding.businessProfileId, command.businessProfileId],
    ["channelAccountId", binding.channelAccountId, command.channelAccountId],
  ] as const) {
    if (!present(bound) || !present(given)) {
      return refuse(field, "is missing on the command or on this adapter's binding");
    }
    if (bound !== given) {
      return refuse(field, "does not belong to the account this adapter is bound to");
    }
  }
  return present(command.recipientExternalId) ? undefined : refuse("recipientExternalId", "is missing on the command");
}

/**
 * The context the caller supplies must describe the very conversation and participant the command names.
 *
 * This is the check that makes "eligibility was re-checked immediately before dispatch" mean something. A
 * context is evidence about one conversation with one person; used against a different recipient it is
 * evidence about somebody else, and the human-support exception is not transferable between customers.
 */
export function checkContextMatchesCommand(command: OutboundMessageCommand, ctx: ConversationPolicyContext): SendResult | undefined {
  for (const [field, fromCommand, fromContext] of [
    ["workspaceId", command.workspaceId, ctx.workspaceId],
    ["channelAccountId", command.channelAccountId, ctx.channelAccountId],
    ["conversationId", command.conversationId, ctx.conversationId],
    ["recipientExternalId", command.recipientExternalId, ctx.participantExternalId],
  ] as const) {
    if (!present(fromCommand) || !present(fromContext)) {
      return refuse(field, "is missing on the command or on the conversation context");
    }
    if (fromCommand !== fromContext) {
      return refuse(field, "describes a different conversation than the one being replied to");
    }
  }
  return undefined;
}
