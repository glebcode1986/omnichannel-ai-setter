/**
 * What the deterministic policy engine is allowed to see (POLICY_ENGINE.md, ADR-004, ADR-014).
 *
 * Every field is a *fact already established elsewhere*, never something to go and look up. The evaluator
 * takes this value and returns a decision; it has no ports, no clock of its own and no way to reach a
 * provider, a queue or a database. That is what makes the decision reproducible from an audit row: given
 * the same input, the same decision, forever.
 *
 * Two kinds of channel-specific knowledge are deliberately reduced to channel-neutral shapes here:
 *
 * - **the messaging window** arrives as `WindowDecision`, which `channel-core` already defines, so the
 *   evaluator never learns what a "24-hour window" is;
 * - **Human Agent availability** arrives as `HumanAgentAvailability`, mapped by the composition root from
 *   the Instagram adapter's own eligibility type. The adapter's type is deliberately not importable here —
 *   `application` may not depend on a channel adapter — and that boundary is what stops an
 *   Instagram-shaped exception leaking into a channel-neutral decision.
 */
import type { WindowDecision } from "@omnichannel/channel-core";
import type {
  AiMode,
  ChannelCapabilities,
  HumanTakeoverState,
  InstagramAfterWindowPolicy,
  QuietHours,
  ReasonCode,
  ReviewMode,
  SendAuthority,
  SuspensionReason,
  SuspensionScope,
  WhatsAppAfterWindowPolicy,
} from "@omnichannel/domain";

/**
 * Whether a *human* could still reply under a provider's human-support exception.
 *
 * Never merged with `WindowDecision`: an automated-send decision and a human-only exception must not be
 * substitutable for one another, or a background worker could one day schedule a send on the strength of a
 * human's eligibility. `UNAVAILABLE` carries why, because "expired" and "never approved" mean different
 * things to the person reading the review queue.
 */
export type HumanAgentAvailability =
  | { readonly state: "ELIGIBLE"; readonly expiresAt: Date }
  | { readonly state: "UNAVAILABLE"; readonly reason: "EXPIRED" | "NOT_APPROVED" | "UNKNOWN" | "NOT_SUPPORTED" };

/** Connection health as the policy layer needs it: healthy enough to send, or not. */
export type AccountHealth = "CONNECTED" | "NEEDS_REAUTH" | "DISCONNECTED";

/**
 * Whether this draft still answers the newest state of the conversation. `SUPERSEDED` means the customer
 * has spoken since, so the draft answers a question that has moved on.
 */
export type ReplyCycleState = "OWNED" | "SUPERSEDED";

/** The validated draft, reduced to what a decision may depend on. No free text: prose decides nothing. */
export interface PolicyDraft {
  /** False for a generation whose output was unusable; such a draft can never be scheduled. */
  readonly usable: boolean;
  readonly confidence: number;
  /** Codes carried by the draft, including anything the engine added deterministically. */
  readonly reasonCodes: readonly ReasonCode[];
  /** What the model said it relied on. */
  readonly citedSourceIds: readonly string[];
  /** The kind of content that would be sent; capability-gated against the account. */
  readonly contentType: "TEXT" | "TEMPLATE";
}

/** What retrieval supplied for this draft, as the policy layer needs it. */
export interface PolicyRetrieval {
  /** Chunk IDs actually put in front of the model. A citation outside this set is unsupported. */
  readonly suppliedSourceIds: readonly string[];
  /** False when the factual corpus could not be consulted at all. */
  readonly corpusReachable: boolean;
}

/** The automation settings that bear on a send, already resolved for this conversation. */
/**
 * What the business chose to happen once the channel's standard automated window closes.
 *
 * Discriminated by channel rather than a flat Instagram-only field (product-owner decision on PR #67): the
 * evaluator is channel-neutral, and WhatsApp's options (ADR-016) are not Instagram's. A flat second field
 * would let a WhatsApp conversation silently carry an Instagram policy, and the union makes that
 * unrepresentable instead of merely discouraged.
 */
export type AfterWindowPolicy =
  | { readonly channel: "INSTAGRAM"; readonly policy: InstagramAfterWindowPolicy }
  | { readonly channel: "WHATSAPP"; readonly policy: WhatsAppAfterWindowPolicy };

/**
 * What the outside-window template route can offer, as deterministic facts (ADR-016, Issue #20).
 *
 * Two booleans rather than a template, deliberately. The engine must not choose which template a customer
 * receives — ADR-016 says deterministic policy, not model preference, decides eligibility, and a *policy
 * engine* holding a catalogue would be the place a model's ranking quietly became a send. Selection and
 * validation happen before this: by the time the engine sees it, the question is only whether this send
 * may go out unattended, may go to a person, or has nowhere to go.
 *
 * The distinction between the two is the difference between a review item and a dead end.
 */
export interface TemplateRoute {
  /**
   * Whether any approved template exists that a person could send.
   *
   * False is terminal: Meta pauses, disables and eventually archives templates on its own, so an account
   * can be left with none — and a review item nobody can resolve is worse than an empty queue.
   */
  readonly approvedTemplateAvailable: boolean;
  /**
   * True when *this* send's template is approved right now, its values match the approved shape, and the
   * business allowlisted it for unattended automation.
   *
   * All three, because any one of them failing is a different conversation with the operator and none of
   * them may be assumed from the other two.
   */
  readonly automatable: boolean;
}

export interface PolicyLimits {
  readonly confidenceThreshold: number;
  readonly mandatoryReviewReasons: readonly ReasonCode[];
  readonly quietHours?: QuietHours;
  readonly afterWindow: AfterWindowPolicy;
}

export interface PolicyInput {
  /** The effective mode for this conversation: override, then channel account, then profile default. */
  readonly mode: AiMode;
  readonly aiEnabled: boolean;
  readonly takeover: HumanTakeoverState;
  readonly draft: PolicyDraft;
  readonly retrieval: PolicyRetrieval;
  readonly limits: PolicyLimits;
  readonly account: AccountHealth;
  readonly capabilities: ChannelCapabilities;
  readonly window: WindowDecision;
  readonly humanAgent: HumanAgentAvailability;
  /**
   * The outside-window template route, when the channel has one. Absent on a channel whose policy
   * vocabulary has no templates, and absent is not a weaker form of "available".
   */
  readonly templateRoute?: TemplateRoute;
  /**
   * The latest instant an automated reply may still be dispatched — the provider's own budget, not our
   * preference (Issue #13). Absent means the channel imposes no deadline. Quiet hours may defer only
   * within it, and never past it.
   */
  readonly dispatchDeadline?: Date;
  readonly replyCycle: ReplyCycleState;
  /**
   * Set when a kill switch covers this send. A fact like any other, so the one place that decides whether
   * a reply may go out also decides this — rather than a second check somewhere closer to the wire, which
   * is how a switch ends up with a path around it.
   */
  readonly outboundSuspended?: { readonly scope: SuspensionScope; readonly reason: SuspensionReason };
  /**
   * On whose authority this reply would be sent.
   *
   * Omitted means automation, which is the strict case — a caller that forgets to say gets the gate that
   * asks for a human rather than the one that assumes one already spoke. The delivery path never omits it:
   * it reads the authority from the row the approval was recorded on.
   */
  readonly authority?: SendAuthority;
  readonly now: Date;
}

/**
 * `SKIP` — nothing to send and no human action expected.
 * `HOLD_REVIEW` — a person must look at this before anything leaves.
 * `SCHEDULE` — hand to delayed delivery; this layer never calls a channel itself.
 *
 * `reviewMode` is required on a hold rather than optional: an absent mode would be a second spelling of
 * `NORMAL`, and the difference between the two modes decides whether a send may carry `HUMAN_AGENT`.
 */
export type PolicyDecision =
  | { readonly action: "SKIP"; readonly reasons: readonly ReasonCode[] }
  | { readonly action: "HOLD_REVIEW"; readonly reasons: readonly ReasonCode[]; readonly reviewMode: ReviewMode }
  | {
      readonly action: "SCHEDULE";
      readonly reasons: readonly ReasonCode[];
      /**
       * Earliest permitted dispatch. Present only when quiet hours moved it: a deferral the coordinator
       * must honour, and one this layer only ever produces when the deferred time still sits inside the
       * channel's eligibility and timing budget.
       */
      readonly notBefore?: Date;
    };
