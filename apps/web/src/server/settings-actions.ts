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
 * - **not a flag, and not a claim.** A bare `confirm=on` is satisfied by a checkbox that was on the page
 *   before any summary existed. Carrying the exact impact codes is necessary and *not* sufficient either:
 *   the codes are public, so a first crafted POST could name them without any summary having been
 *   rendered. The acknowledgement therefore carries a **seal the refusal minted** over this exact
 *   proposal, version and impact list — see `proposal-seal.ts` — and the codes are still compared, because
 *   the seal proves provenance and the comparison proves it is about this change.
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
  isPresenceMode,
  isWhatsAppAfterWindowPolicy,
  policyImpactsOf,
} from "@omnichannel/domain";
import { confidenceSettingsFor } from "@omnichannel/domain";
import { WorkspacePermissionError, readPolicies, savePolicy, type PolicyEdit, type PolicyView, type PolicyWriteOutcome } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { getLogger } from "./logger";
import { requireBusinessProfileContext } from "./request-context";
import { loadWebEnv } from "../env";
import { proposalSealed, sealProposal } from "./proposal-seal";
import {
  acknowledges,
  customTimingProblem,
  encodeProposal,
  oversizedField,
  takeoverPauseProblem,
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

  const takeoverProblem = takeoverPauseProblem(field(formData, "takeoverPauseHours"));
  if (takeoverProblem !== undefined) {
    // The same rule as the timing ranges, three lines below the fieldset that got it right. `min` and
    // `max` on a number input are a hint to a browser and nothing at all to a crafted POST, and the
    // domain asks only for a positive integer.
    revalidatePath(path);
    redirect(`${path}?outcome=TAKEOVER_${takeoverProblem}&proposal=${encodeProposal(proposal)}`);
  }

  if (field(formData, "timingPreset") === "CUSTOM") {
    const problem = customTimingProblem(customSecondsFrom(formData));
    if (problem !== undefined) {
      // Refused, not quietly dropped. Sending `CUSTOM` with no ranges let the store keep the stored ones,
      // so an owner who cleared one field saw "Saved" over timing they had not chosen while the rest of
      // their form applied. Each problem is its own sentence, because "incomplete", "out of range" and
      // "the wrong way round" send a person to different fields.
      revalidatePath(path);
      redirect(`${path}?outcome=TIMING_${problem}&proposal=${encodeProposal(proposal)}`);
    }
  }

  if (oversizedField([proposal.businessGoal, proposal.qualificationCriteria.join("\n"), proposal.whatsappTemplateAutomationAllowlist.join("\n")])) {
    // Refused rather than truncated, and refused before anything is encoded: a goal cut in half would be
    // saved as the owner's own words without being them. All three fields, because they travel in one
    // parameter — a bound on one of them is a bound on nothing.
    revalidatePath(path);
    redirect(`${path}?outcome=TOO_LONG`);
  }

  // What this change would widen, computed against what is stored — before anything is written.
  const before = (await readPolicies(getDb(), context)).find((policy) => policy.channelAccountId === null);
  if (before !== undefined) {
    const impacts = impactsOf(before, proposal);
    const secret = loadWebEnv().AUTH_SECRET;
    // The review this acknowledgement has to be *for*: the owner's values, the version stored now, and the
    // impacts those values have against it. One triple, minted on refusal and verified here, so the
    // acknowledgement is bound to the state it was given about rather than to the state the form was
    // composed against. A seal from an earlier version therefore stops verifying the moment anybody else
    // saves — including when their change leaves the impact list identical, which is the case a seal over
    // the *posted* version could not tell apart and left for the store's version check to catch.
    const reviewed = { ...proposal, expectedVersion: before.version };
    const sealed = proposalSealed(secret, reviewed, impacts, field(formData, "proposalSeal").trim());
    if (impacts.length > 0 && !(sealed && acknowledges(acknowledged, impacts))) {
      // Refused, not saved-and-warned. The point of a confirmation is that the change has not happened —
      // and the proposal goes back with it, together with the seal, so the page can render the summary
      // next to the values it describes and the acknowledgement can prove where it came from.
      //
      // **Rebased onto the version that is stored now**, which is what makes this converge. `impacts` was
      // computed against the current policy a line above, so the summary the owner is about to read is
      // already about the current state; handing the proposal back at the version they *composed* it
      // against meant the page saw a stale proposal, withheld the acknowledgement, and re-posted the same
      // stale version for ever. The review state is therefore always (their values, the current version,
      // the impacts those values have against the current version) — one triple, and the seal covers
      // exactly it. A seal minted for the older version cannot validate against this one, because the
      // version is part of the encoded proposal the seal is taken over.
      revalidatePath(path);
      const query = new URLSearchParams({
        outcome: "CONFIRM",
        impacts: impacts.join(","),
        proposal: encodeProposal(reviewed),
        proposalSeal: sealProposal(secret, reviewed, impacts),
      });
      redirect(`${path}?${query.toString()}`);
    }
  }

  const outcome = await saveOrRefuse(context, proposal);
  if (outcome.status === "REFUSED") {
    // The domain's own message names the field it refused, and the screen cannot show it: it is English
    // prose from a layer below the translation catalogue, and putting it on a localized page would be the
    // one thing the i18n gate exists to stop. Logged instead, so the detail the store took care to
    // preserve is diagnosable rather than discarded — which is what "dropped on the floor" looked like.
    getLogger().warn("settings.save_refused", { reason: outcome.reason });
  }
  revalidatePath(path);
  if (outcome.status === "REFUSED" || outcome.status === "FORBIDDEN") {
    // These keep the proposal too. A refusal that also loses the owner's form costs more than the change
    // it prevented, and the `CONFLICT` branch below already says so about itself — three exits out of the
    // same function should not disagree about whether the owner's work survives being told no.
    revalidatePath(path);
    redirect(`${path}?outcome=${outcome.status}&proposal=${encodeProposal(proposal)}`);
  }
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
      getLogger().warn("settings.save_not_permitted", { operation: error.message });
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
  const takeoverHours = Number.parseInt(field(formData, "takeoverPauseHours").trim(), 10);
  const customSeconds = customSecondsFrom(formData);
  const custom = timingPreset === "CUSTOM" && customTimingProblem(customSeconds) === undefined ? timingFromSeconds(customSeconds) : undefined;
  const presenceMode = field(formData, "presenceMode");
  const presenceLeadSeconds = Number.parseInt(field(formData, "presenceTypingLeadSeconds"), 10);
  const allowlist = lines(formData, "allowlist");

  return {
    ...(isAiMode(mode) ? { mode } : {}),
    businessGoal: field(formData, "businessGoal"),
    qualificationCriteria: lines(formData, "criteria"),
    ...(isConfidencePreset(confidencePreset) ? { confidencePreset } : {}),
    ...(isTimingPreset(timingPreset) ? { timingPreset } : {}),
    // Only for CUSTOM: a named preset means its own ranges, and sending both is a contradiction the store
    // refuses. The inputs stay on the page whichever preset is selected, so switching to Custom does not
    // require a round trip to reveal them. When the preset is CUSTOM the ranges are always present, since
    // the action refuses an unusable set before it builds a proposal at all.
    ...(custom === undefined ? {} : { timing: custom }),
    // Always present, because the action refuses an unusable value before it builds a proposal: omitting
    // it let the store keep the stored hours and report `SAVED`, so clearing the box or posting eleven
    // years both looked like a successful change to something else.
    takeoverPauseHours: takeoverHours,
    ...(isInstagramAfterWindowPolicy(instagram) ? { instagramAfterWindowPolicy: instagram } : {}),
    ...(isWhatsAppAfterWindowPolicy(whatsapp) ? { whatsappAfterWindowPolicy: whatsapp } : {}),
    whatsappTemplateAutomationAllowlist: allowlist,
    ...(isPresenceMode(presenceMode) ? { presenceMode } : {}),
    // Seconds on the form, milliseconds in the policy: an owner thinks in seconds, and the ceiling is the
    // provider's own indicator lifetime, which the domain refuses past.
    ...(Number.isFinite(presenceLeadSeconds) && presenceLeadSeconds >= 0 ? { presenceTypingLeadMs: presenceLeadSeconds * 1_000 } : {}),
    expectedVersion,
  };
}

/**
 * The four numbers behind "Custom" timing, in seconds on the form and milliseconds in the store.
 *
 * Seconds because that is the unit an owner thinks in for "wait before replying"; milliseconds because
 * that is what the policy stores and the scheduler uses. The numbers are returned as typed, valid or not —
 * `customTimingProblem` decides whether they may be sent, and the action **refuses** rather than sending
 * `CUSTOM` with no ranges. Sending none let the store fall back to the stored ranges, so an invalid
 * submission reported "Saved" over timing the owner had not chosen.
 */
function customSecondsFrom(formData: FormData): readonly (number | undefined)[] {
  return ["debounceMinSeconds", "debounceMaxSeconds", "deliveryDelayMinSeconds", "deliveryDelayMaxSeconds"].map((name) => {
    const raw = field(formData, name).trim();
    // The whole field has to be the number, for the reason `expectedVersionOf` gives: a guard that reads
    // `3` out of `"3 or so"` has refusals that depend on the shape of the input rather than on its value.
    return /^-?[0-9]+$/u.test(raw) ? Number.parseInt(raw, 10) : undefined;
  });
}

function timingFromSeconds(seconds: readonly (number | undefined)[]): PolicyProposal["timing"] {
  const [debounceMin, debounceMax, delayMin, delayMax] = seconds as [number, number, number, number];
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
    takeoverPauseMs: proposal.takeoverPauseHours * 3_600_000,
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
