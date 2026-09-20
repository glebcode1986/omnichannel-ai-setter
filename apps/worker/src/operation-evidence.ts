/**
 * Asking a platform whether one outbound request created a message (ADR-012, ADR-013, Issue #56).
 *
 * This implementation answers `UNKNOWN`, and that is the honest answer rather than a gap.
 *
 * Meta's Send API has no "did request X create a message?" lookup: the request identifier it returns is a
 * trace id for support, not something that can be resolved to a message afterwards. So when a send times
 * out mid-flight there is nothing on the provider's side we can ask that distinguishes "delivered" from
 * "never arrived".
 *
 * Two things we could do instead are deliberately not done here:
 *
 * - **matching the reply's text against the thread.** ADR-013 rules that out in as many words — text
 *   matching alone is insufficient to identify our own message — and it would be worse than useless the
 *   moment two customers ask the same question;
 * - **treating an unattributed outbound echo in the same conversation as ours.** That is genuinely
 *   promising evidence, but ADR-013 currently reads an unattributed echo as a human replying natively,
 *   which pauses automation. Claiming those echoes for reconciliation would quietly reverse that rule, so
 *   it belongs to a decision the product owner makes, not to this file. ADR-017 records the proposal.
 *
 * Returning `UNKNOWN` sends the operation down the path that ends with a person being told, which is the
 * correct outcome for a send nobody can verify. A port that guessed would produce a confident answer that
 * is sometimes a duplicate customer message.
 */
import type { OperationEvidence, OperationEvidencePort, ReconciliationSubject } from "@omnichannel/application";

const NO_LOOKUP = "the platform offers no way to resolve a send request to a message after the fact";

export function createOperationEvidencePort(): OperationEvidencePort {
  return {
    lookup(subject: ReconciliationSubject): Promise<OperationEvidence> {
      return Promise.resolve({ kind: "UNKNOWN", detail: `${NO_LOOKUP} (${subject.reason})` });
    },
  };
}
