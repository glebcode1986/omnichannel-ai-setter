"use server";

/**
 * Saving automation settings (AI_CONFIGURATION_UX.md, Issue #30).
 *
 * The confirmation is enforced here, not offered by the form. `policyImpactsOf` is asked what this change
 * widens; if it widens anything and the request did not acknowledge **those** impacts, the save is
 * **refused** and both the impacts and the proposal travel back in the URL for the page to explain. A
 * disabled button or a client-side dialog would be a courtesy; this is the boundary, and it cannot be
 * skipped by posting the form directly.
 *
 * Three things the acknowledgement is deliberately not:
 *
 * - **not a flag.** A bare `confirm=on` is satisfied by a checkbox that was on the page before any summary
 *   existed, so the promised "effect summary before save" never had to happen. The field carries the exact
 *   impact codes instead, and a set that is not the one computed here is refused again.
 * - **not durable.** It travels with the policy version it was computed against, so it cannot be carried
 *   across somebody else's change; `savePolicy` refuses a stale version outright.
 * - **not a replacement for the proposal.** The refusal carries the proposed values too, so the page can
 *   render the summary next to the values it describes rather than next to what is stored.
 *
 * Presets are sent by name. The values they mean come from the domain, so a request cannot ask for a
 * threshold the preset does not have.
 */
import {
  isAiMode,
  isConfidencePreset,
  isInstagramAfterWindowPolicy,
  isTimingPreset,
  isWhatsAppAfterWindowPolicy,
  policyImpactsOf,
} from "@omnichannel/domain";
import { confidenceSettingsFor } from "@omnichannel/domain";
import { WorkspacePermissionError, readPolicies, savePolicy, type PolicyEdit, type PolicyView, type PolicyWriteOutcome } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { requireBusinessProfileContext } from "./request-context";
import {
  acknowledges,
  encodeProposal,
  MAX_PROPOSAL_FIELD_CHARS,
  type PolicyProposal,
} from "./settings-view";
import { expectedVersionOf, field, lines } from "./form-fields";

export interface SettingsTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

const settingsPath = (target: SettingsTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/settings`;

/** Milliseconds per second, spelled out where seconds come off a form and milliseconds go to the store. */
const MS_PER_SECOND = 1_000;

export async function saveSettingsAction(target: SettingsTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const path = settingsPath(target);

  const version = expectedVersionOf(formData);
  if (version === undefined) {
    // Refused without reaching the store, which is the same answer the Knowledge forms give and for the
    // same reason: a submission that does not say which settings it was composed against must not be
    // completed against whatever happens to be current. Sending one fewer field is not a way around a
    // conflict check.
    revalidatePath(path);
    redirect(`${path}?outcome=REJECTED`);
  }
  const proposal = proposalFrom(formData, version);
  const acknowledged = lines(formData, "acknowledged").flatMap((line) => line.split(",").map((entry) => entry.trim()));

  if (proposal.businessGoal.length > MAX_PROPOSAL_FIELD_CHARS) {
    // Refused rather than truncated, and refused before anything is encoded: a goal cut in half would be
    // saved as the owner's own words without being them.
    revalidatePath(path);
    redirect(`${path}?outcome=TOO_LONG`);
  }

  // What this change would widen, computed against what is stored — before anything is written.
  const before = (await readPolicies(getDb(), context)).find((policy) => policy.channelAccountId === null);
  if (before !== undefined) {
    const impacts = impactsOf(before, proposal);
    if (impacts.length > 0 && !acknowledges(acknowledged, impacts)) {
      // Refused, not saved-and-warned. The point of a confirmation is that the change has not happened —
      // and the proposal goes back with it, so the summary the page renders describes the values still in
      // the form rather than the ones in the database.
      revalidatePath(path);
      redirect(`${path}?outcome=CONFIRM&impacts=${encodeURIComponent(impacts.join(","))}&proposal=${encodeProposal(proposal)}`);
    }
  }

  const outcome = await saveOrRefuse(context, proposal);
  revalidatePath(path);
  if (outcome.status === "CONFLICT") {
    // The proposal comes back, because the owner's answer to "somebody else changed this" is to decide
    // between the two, and losing their edit would cost more than the refusal prevented. It comes back
    // **re-stamped to the version that is now stored**: carried at its original version it would conflict
    // for ever, and a form that can only be refused is a trap, not a safeguard. So the next submit is a
    // deliberate act against the current settings — and the change history below the form now shows both
    // sides of what the other person did, which is how "look at their version first" is actually possible
    // on this screen rather than merely advised.
    redirect(`${path}?outcome=CONFLICT&proposal=${encodeProposal({ ...proposal, expectedVersion: outcome.current.version })}`);
  }
  redirect(`${path}?outcome=${outcome.status}`);
}

/** The save, with a role refusal reported as an outcome rather than as a crashed page. */
async function saveOrRefuse(
  context: Awaited<ReturnType<typeof requireBusinessProfileContext>>,
  proposal: PolicyProposal,
): Promise<PolicyWriteOutcome | { readonly status: "FORBIDDEN" }> {
  try {
    return await savePolicy(getDb(), context, null, editFrom(proposal));
  } catch (error) {
    if (error instanceof WorkspacePermissionError) {
      // The store is the authority on who may change settings, and it refuses an AGENT. The screen hides
      // the form from one, so reaching here means a direct post — answered, not crashed.
      return { status: "FORBIDDEN" };
    }
    throw error;
  }
}

/** The form, as the values a save would write. Unrecognised enum values are simply not sent. */
function proposalFrom(formData: FormData, expectedVersion: number): PolicyProposal {
  const mode = field(formData, "mode");
  const confidencePreset = field(formData, "confidencePreset");
  const timingPreset = field(formData, "timingPreset");
  const instagram = field(formData, "instagramAfterWindowPolicy");
  const whatsapp = field(formData, "whatsappAfterWindowPolicy");
  const takeoverHours = Number.parseInt(field(formData, "takeoverPauseHours"), 10);
  const custom = customTimingFrom(formData);

  return {
    ...(isAiMode(mode) ? { mode } : {}),
    businessGoal: field(formData, "businessGoal"),
    qualificationCriteria: lines(formData, "criteria"),
    ...(isConfidencePreset(confidencePreset) ? { confidencePreset } : {}),
    ...(isTimingPreset(timingPreset) ? { timingPreset } : {}),
    // Only for CUSTOM: a named preset means its own ranges, and sending both is a contradiction the store
    // refuses. The inputs stay on the page whichever preset is selected, so switching to Custom does not
    // require a round trip to reveal them.
    ...(timingPreset === "CUSTOM" && custom !== undefined ? { timing: custom } : {}),
    ...(Number.isFinite(takeoverHours) && takeoverHours > 0 ? { takeoverPauseHours: takeoverHours } : {}),
    ...(isInstagramAfterWindowPolicy(instagram) ? { instagramAfterWindowPolicy: instagram } : {}),
    ...(isWhatsAppAfterWindowPolicy(whatsapp) ? { whatsappAfterWindowPolicy: whatsapp } : {}),
    whatsappTemplateAutomationAllowlist: lines(formData, "allowlist"),
    expectedVersion,
  };
}

/**
 * The four numbers behind "Custom" timing, in seconds on the form and milliseconds in the store.
 *
 * Seconds because that is the unit an owner thinks in for "wait before replying"; milliseconds because
 * that is what the policy stores and the scheduler uses. `undefined` when any of the four is missing or
 * not a number: a partial range would be completed from stored values, and a half-typed custom range
 * silently mixed with the previous one is the least explicable outcome available.
 */
function customTimingFrom(formData: FormData): PolicyProposal["timing"] | undefined {
  const parts = ["debounceMinSeconds", "debounceMaxSeconds", "deliveryDelayMinSeconds", "deliveryDelayMaxSeconds"].map((name) =>
    Number.parseInt(field(formData, name), 10),
  );
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }
  const [debounceMin, debounceMax, delayMin, delayMax] = parts as [number, number, number, number];
  return {
    debounceWindowMs: { minMs: debounceMin * MS_PER_SECOND, maxMs: debounceMax * MS_PER_SECOND },
    deliveryDelayMs: { minMs: delayMin * MS_PER_SECOND, maxMs: delayMax * MS_PER_SECOND },
  };
}

/** The proposal as the store's edit. One place, so the impacts and the save see the same change. */
function editFrom(proposal: PolicyProposal): PolicyEdit {
  return {
    expectedVersion: proposal.expectedVersion,
    ...(proposal.mode === undefined ? {} : { mode: proposal.mode }),
    businessGoal: proposal.businessGoal,
    qualificationCriteria: proposal.qualificationCriteria,
    ...(proposal.confidencePreset === undefined ? {} : { confidencePreset: proposal.confidencePreset }),
    ...(proposal.timingPreset === undefined ? {} : { timingPreset: proposal.timingPreset }),
    ...(proposal.timing === undefined ? {} : { timing: proposal.timing }),
    ...(proposal.takeoverPauseHours === undefined ? {} : { takeoverPauseMs: proposal.takeoverPauseHours * 3_600_000 }),
    ...(proposal.instagramAfterWindowPolicy === undefined ? {} : { instagramAfterWindowPolicy: proposal.instagramAfterWindowPolicy }),
    ...(proposal.whatsappAfterWindowPolicy === undefined ? {} : { whatsappAfterWindowPolicy: proposal.whatsappAfterWindowPolicy }),
    whatsappTemplateAutomationAllowlist: proposal.whatsappTemplateAutomationAllowlist,
  };
}

/** What the proposal would widen, against the stored policy. The domain decides; this only supplies both sides. */
function impactsOf(before: PolicyView, proposal: PolicyProposal) {
  const confidence =
    proposal.confidencePreset === undefined
      ? { confidenceThreshold: before.confidenceThreshold, mandatoryReviewReasons: before.mandatoryReviewReasons }
      : confidenceSettingsFor(proposal.confidencePreset);
  return policyImpactsOf(
    {
      mode: before.mode,
      confidenceThreshold: before.confidenceThreshold,
      mandatoryReviewReasons: before.mandatoryReviewReasons,
      instagramAfterWindowPolicy: before.instagramAfterWindowPolicy,
      whatsappAfterWindowPolicy: before.whatsappAfterWindowPolicy,
      whatsappTemplateAutomationAllowlist: before.whatsappTemplateAutomationAllowlist,
    },
    {
      mode: proposal.mode ?? before.mode,
      confidenceThreshold: confidence.confidenceThreshold,
      mandatoryReviewReasons: confidence.mandatoryReviewReasons,
      instagramAfterWindowPolicy: proposal.instagramAfterWindowPolicy ?? before.instagramAfterWindowPolicy,
      whatsappAfterWindowPolicy: proposal.whatsappAfterWindowPolicy ?? before.whatsappAfterWindowPolicy,
      whatsappTemplateAutomationAllowlist: proposal.whatsappTemplateAutomationAllowlist,
    },
  );
}
