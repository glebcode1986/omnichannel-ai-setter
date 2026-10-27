"use server";

/**
 * The operator actions the console offers (#59, ADMIN_OPERATIONS.md).
 *
 * Five, and the boundary matters more than the count. Every one re-resolves the platform authorization
 * from the database, calls a typed store function, and leaves the audit row to that function so the record
 * and the change commit together. None of them takes a workspace from a session — an operator has none —
 * so the target is a parameter and the store bounds every query by it.
 *
 * **There is no resend and no generic retry.** `reexamineOperationAction` records that a person asked and
 * then enqueues exactly the job the reconciliation sweeper would have raised. It does not decide anything:
 * `reconcileOperation` does, in the worker, where the provider-evidence port actually exists. A console
 * that built its own copy of that engine would be a second implementation of "is this send settled?",
 * and the two would eventually disagree about a customer's money.
 *
 * Enqueueing rather than deciding is also what keeps the console honest about policy. The worker's
 * handler re-enters the coordinator, so takeover, staleness and the send gates are judged again, and the
 * ordered checks leave a settled send alone. An admin action that wrote a terminal state itself would be
 * the "arbitrary JSON editor" this console exists to replace, and a "retry anyway" control for an
 * ambiguous non-idempotent write is the one thing `ADMIN_OPERATIONS.md` names as forbidden.
 */
import {
  liftKillSwitch,
  openSupportAccessSession,
  PlatformPermissionError,
  pullKillSwitch,
  requestReconciliation,
  revokeSupportAccessSession,
  setRolloutAutopilot,
} from "@omnichannel/db";
import { isSuspensionScope, type SuspensionScope } from "@omnichannel/domain";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { field } from "./checkout-form";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { getQueueProducer } from "./queue";
import { requirePlatformContext } from "./request-context";

export type AdminOutcome =
  | "PAUSED"
  | "RESUMED_OUTBOUND"
  | "ALREADY_LIFTED"
  | "SESSION_OPENED"
  | "SESSION_REVOKED"
  | "ALREADY_REVOKED"
  | "REEXAMINED"
  | "ALLOWLIST_ADDED"
  | "ALLOWLIST_REMOVED"
  | "ALLOWLIST_UNCHANGED"
  | "NOT_PERMITTED"
  | "ADMIN_REFUSED";

function finish(path: string, outcome: AdminOutcome): never {
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

/** Every refusal an operator can cause is an outcome; anything else is a fault and is rethrown. */
function outcomeOf(error: unknown): AdminOutcome {
  if (error instanceof PlatformPermissionError) {
    return "NOT_PERMITTED";
  }
  // `DbInputError` and the store's own sentences — a scope with no identifiers, an operation already
  // concluded, the system's own pause — are all the operator having asked for something impossible.
  if (error instanceof Error && error.name === "DbInputError") {
    return "ADMIN_REFUSED";
  }
  throw error;
}

export async function pullKillSwitchAction(path: string, formData: FormData): Promise<void> {
  const context = await requirePlatformContext();
  const posted = field(formData, "scope");
  if (!isSuspensionScope(posted)) {
    // A hand-edited form cannot name a scope nobody defined. Refused rather than coerced, because the
    // coercion that would read most naturally here is "treat the unknown as GLOBAL".
    finish(path, "ADMIN_REFUSED");
  }
  const scope: SuspensionScope = posted;
  try {
    await pullKillSwitch(getDb(), context, {
      scope,
      ...(field(formData, "workspaceId") === "" ? {} : { workspaceId: field(formData, "workspaceId") }),
      ...(field(formData, "businessProfileId") === "" ? {} : { businessProfileId: field(formData, "businessProfileId") }),
      ...(field(formData, "channelAccountId") === "" ? {} : { channelAccountId: field(formData, "channelAccountId") }),
      reason: field(formData, "reason"),
    });
    finish(path, "PAUSED");
  } catch (error) {
    finish(path, outcomeOf(error));
  }
}

export async function liftKillSwitchAction(path: string, formData: FormData): Promise<void> {
  const context = await requirePlatformContext();
  try {
    const result = await liftKillSwitch(getDb(), context, { suspensionId: field(formData, "suspensionId"), reason: field(formData, "reason") });
    finish(path, result.lifted ? "RESUMED_OUTBOUND" : "ALREADY_LIFTED");
  } catch (error) {
    finish(path, outcomeOf(error));
  }
}

export async function openSupportSessionAction(path: string, formData: FormData): Promise<void> {
  const context = await requirePlatformContext();
  try {
    await openSupportAccessSession(getDb(), context, {
      workspaceId: field(formData, "workspaceId"),
      ...(field(formData, "businessProfileId") === "" ? {} : { businessProfileId: field(formData, "businessProfileId") }),
      // One scope in this slice, because one read consumes it. A second scope with no reader would be a
      // checkbox that grants nothing.
      scopes: ["CONVERSATION_CONTENT"],
      reason: field(formData, "reason"),
      ...(field(formData, "ticketRef") === "" ? {} : { ticketRef: field(formData, "ticketRef") }),
      breakGlass: field(formData, "breakGlass") === "on",
    });
    finish(path, "SESSION_OPENED");
  } catch (error) {
    finish(path, outcomeOf(error));
  }
}

export async function revokeSupportSessionAction(path: string, formData: FormData): Promise<void> {
  const context = await requirePlatformContext();
  try {
    const result = await revokeSupportAccessSession(getDb(), context, { sessionId: field(formData, "sessionId"), reason: field(formData, "reason") });
    finish(path, result.revoked ? "SESSION_REVOKED" : "ALREADY_REVOKED");
  } catch (error) {
    finish(path, outcomeOf(error));
  }
}

/**
 * Asks the system to re-examine one ambiguous operation.
 *
 * Two steps, in this order and for a reason: the store records who asked and refuses an operation that is
 * already concluded, and only then does `reconcileOperation` decide. Its ordered checks are what make
 * this safe — a settled send is left alone, a claim that was never taken is resumed through the
 * coordinator, and provider evidence decides the rest. Nothing here chooses an outcome.
 */
export async function reexamineOperationAction(path: string, formData: FormData): Promise<void> {
  const context = await requirePlatformContext();
  const operationId = field(formData, "operationId");
  try {
    // The store records who asked, refuses an operation that is already concluded, and hands back the
    // identity the job needs. It deliberately decides nothing else.
    const subject = await requestReconciliation(getDb(), context, { operationId, reason: field(formData, "reason") });
    // `replaceRetained`, because the sweeper may already have examined this operation and left a
    // finished job retained under the same identity — and the whole point of an operator asking is that
    // they want it looked at again now.
    await getQueueProducer().enqueueReconciliation(
      {
        schemaVersion: 1,
        // The delivery's own correlation id, so the worker's log for this run joins the original
        // operation's rather than starting a new trace that nothing can be followed back from.
        correlationId: subject.correlationId,
        workspaceId: subject.workspaceId,
        businessProfileId: subject.businessProfileId,
        conversationId: subject.conversationId,
        deliveryJobId: subject.deliveryJobId,
        operationId,
        reason: subject.reason,
        detectedAt: subject.detectedAt.toISOString(),
        ...(subject.providerRequestId === null ? {} : { providerRequestId: subject.providerRequestId }),
        ...(subject.providerCode === null ? {} : { providerCode: subject.providerCode }),
      },
      { replaceRetained: true },
    );
    getLogger().info("admin.reconciliation_requested", { operationId });
    finish(path, "REEXAMINED");
  } catch (error) {
    finish(path, outcomeOf(error));
  }
}

/**
 * Adds a Business Profile to the limited-rollout autopilot allowlist, or removes it (#60, §18).
 *
 * The writer §18's third stage needs. Without it "limited AUTOPILOT on explicitly selected BPs" was a
 * stage nobody could enter: the column existed, the send path read it, and the only way to set it was
 * hand-written SQL against production — the practice this console exists to end.
 *
 * It decides nothing about whether the profile then sends unattended. The stage has to be there, the plan
 * has to permit autopilot, the profile has to be in AUTOPILOT, and no kill switch may cover it. This is
 * one of those conditions, which is why the pane says so beside the control rather than implying that a
 * checkbox turns sending on.
 */
export async function setRolloutAutopilotAction(path: string, formData: FormData): Promise<void> {
  const context = await requirePlatformContext();
  const enabled = field(formData, "enabled") === "on";
  try {
    const result = await setRolloutAutopilot(getDb(), context, {
      workspaceId: field(formData, "workspaceId"),
      businessProfileId: field(formData, "businessProfileId"),
      enabled,
      reason: field(formData, "reason"),
    });
    // Three outcomes rather than two: an operator who clicked twice should be told nothing happened
    // rather than shown a success for a change that was not made, because no audit row was written.
    finish(path, result.changed ? (enabled ? "ALLOWLIST_ADDED" : "ALLOWLIST_REMOVED") : "ALLOWLIST_UNCHANGED");
  } catch (error) {
    finish(path, outcomeOf(error));
  }
}
