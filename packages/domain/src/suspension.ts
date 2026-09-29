/**
 * Stopping automated outbound, deliberately and at a chosen scope (RELIABILITY_INCIDENTS.md, Issue #56).
 *
 * A kill switch is the control someone reaches for when something is going wrong and they do not yet know
 * what. Three properties follow from that, and all three are in the types:
 *
 * - **it stops outbound only.** Inbound messages keep arriving and keep being stored. A switch that also
 *   dropped customer messages would turn a precaution into data loss, and the person pulling it is trying
 *   to *prevent* harm;
 * - **it is scoped.** One expired credential should not silence a whole platform, and one bad deployment
 *   should not require pausing each Business Profile by hand. Scopes nest, and the widest active one wins;
 * - **it is a record, not a flag.** Who, when, and why — because the question after an incident is always
 *   "who turned this off and did anyone turn it back on".
 *
 * Nothing here decides *whether* to suspend. This is the vocabulary; the decision is an operator's.
 */
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";
import type { BusinessProfileId, ChannelAccountId, UserId, WorkspaceId } from "./ids";

export const SUSPENSION_SCOPES = ["GLOBAL", "WORKSPACE", "BUSINESS_PROFILE", "CHANNEL_ACCOUNT"] as const;
export type SuspensionScope = (typeof SUSPENSION_SCOPES)[number];
export const isSuspensionScope = literalGuard(SUSPENSION_SCOPES);

/** Why automated outbound was stopped. Free text is kept separately; this is the part software reads. */
export const SUSPENSION_REASONS = [
  /** A person decided to stop it. The most important one, and the one with no further explanation needed. */
  "OPERATOR",
  /** A dependency the system relies on is failing in a way that makes sending unsafe. */
  "DEPENDENCY_FAILURE",
  /** Provider credentials or capabilities are no longer usable. */
  "CHANNEL_UNHEALTHY",
  /** Too much unfinished work; sending more would make recovery harder. */
  "BACKLOG",
] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
export const isSuspensionReason = literalGuard(SUSPENSION_REASONS);

export interface AutomationSuspension {
  readonly scope: SuspensionScope;
  /** Absent for GLOBAL; present for everything narrower. */
  readonly workspaceId?: WorkspaceId;
  readonly businessProfileId?: BusinessProfileId;
  readonly channelAccountId?: ChannelAccountId;
  readonly reason: SuspensionReason;
  /** Operator-written context. Never rendered to a customer and never a place for secrets. */
  readonly note?: string;
  readonly since: Date;
  /** Who pulled the switch. Absent when the system did it in response to a dependency. */
  readonly byUserId?: UserId;
  /** Absent means it stays until someone lifts it, which is the safe default for a precaution. */
  readonly until?: Date;
}

/** The conversation a send belongs to, as the switch sees it. */
export interface SuspensionTarget {
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly channelAccountId: ChannelAccountId;
}

/**
 * The active suspension that applies to this send, if any.
 *
 * Widest first: a global stop is the answer even when a narrower one also exists, because that is what an
 * operator means by pulling the widest switch. Returning *which* one applies rather than a boolean is what
 * lets the caller explain itself — "paused for this account" and "paused everywhere" are different things
 * to the person reading the Inbox.
 */
export function activeSuspension(
  target: SuspensionTarget,
  suspensions: readonly AutomationSuspension[],
  now: Date,
): AutomationSuspension | undefined {
  const live = suspensions.filter((suspension) => suspension.since.getTime() <= now.getTime() && !hasExpired(suspension, now));
  for (const scope of SUSPENSION_SCOPES) {
    const match = live.find((suspension) => suspension.scope === scope && covers(suspension, target));
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

/** Whether automated outbound may proceed. Inbound is never consulted, because it is never suspended. */
export function automatedOutboundAllowed(target: SuspensionTarget, suspensions: readonly AutomationSuspension[], now: Date): boolean {
  return activeSuspension(target, suspensions, now) === undefined;
}

function hasExpired(suspension: AutomationSuspension, now: Date): boolean {
  return suspension.until !== undefined && suspension.until.getTime() <= now.getTime();
}

function covers(suspension: AutomationSuspension, target: SuspensionTarget): boolean {
  switch (suspension.scope) {
    case "GLOBAL":
      return true;
    case "WORKSPACE":
      return suspension.workspaceId === target.workspaceId;
    case "BUSINESS_PROFILE":
      return suspension.workspaceId === target.workspaceId && suspension.businessProfileId === target.businessProfileId;
    case "CHANNEL_ACCOUNT":
      return suspension.workspaceId === target.workspaceId && suspension.channelAccountId === target.channelAccountId;
  }
}

/**
 * Builds a validated suspension, refusing one whose scope and identifiers disagree.
 *
 * A `BUSINESS_PROFILE` suspension with no profile named would be a global stop wearing a narrow label —
 * the most dangerous shape this type can take, because it looks contained and is not.
 */
export function createAutomationSuspension(input: AutomationSuspension): AutomationSuspension {
  if (!isSuspensionScope(input.scope)) {
    throw new DomainValidationError("scope", "must be GLOBAL, WORKSPACE, BUSINESS_PROFILE or CHANNEL_ACCOUNT");
  }
  if (!isSuspensionReason(input.reason)) {
    throw new DomainValidationError("reason", "is not a known suspension reason");
  }
  const required: Readonly<Record<SuspensionScope, readonly (keyof AutomationSuspension)[]>> = {
    GLOBAL: [],
    WORKSPACE: ["workspaceId"],
    BUSINESS_PROFILE: ["workspaceId", "businessProfileId"],
    CHANNEL_ACCOUNT: ["workspaceId", "channelAccountId"],
  };
  for (const field of required[input.scope]) {
    if (input[field] === undefined) {
      throw new DomainValidationError(String(field), `is required for a ${input.scope} suspension`);
    }
  }
  if (input.until !== undefined && input.until.getTime() <= input.since.getTime()) {
    throw new DomainValidationError("until", "must be later than the moment the suspension started");
  }
  return input;
}
