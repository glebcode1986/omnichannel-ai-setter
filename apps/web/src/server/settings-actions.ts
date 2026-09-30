"use server";

/**
 * Saving automation settings (AI_CONFIGURATION_UX.md, Issue #30).
 *
 * The confirmation is enforced here, not offered by the form. `policyImpactsOf` is asked what this change
 * widens; if it widens anything and the request did not acknowledge it, the save is **refused** and the
 * impacts travel back in the URL for the page to explain. A disabled button or a client-side dialog would
 * be a courtesy; this is the boundary, and it cannot be skipped by posting the form directly.
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
import { readPolicies, savePolicy } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { requireBusinessProfileContext } from "./request-context";
import { field, lines } from "./style-form";

export interface SettingsTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

const settingsPath = (target: SettingsTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/settings`;

export async function saveSettingsAction(target: SettingsTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const path = settingsPath(target);

  const mode = field(formData, "mode");
  const confidencePreset = field(formData, "confidencePreset");
  const timingPreset = field(formData, "timingPreset");
  const instagram = field(formData, "instagramAfterWindowPolicy");
  const whatsapp = field(formData, "whatsappAfterWindowPolicy");
  const takeoverHours = Number.parseInt(field(formData, "takeoverPauseHours"), 10);
  const allowlist = lines(formData, "allowlist");

  const edit = {
    ...(isAiMode(mode) ? { mode } : {}),
    businessGoal: field(formData, "businessGoal"),
    qualificationCriteria: lines(formData, "criteria"),
    ...(isConfidencePreset(confidencePreset) ? { confidencePreset } : {}),
    ...(isTimingPreset(timingPreset) ? { timingPreset } : {}),
    ...(Number.isFinite(takeoverHours) && takeoverHours > 0 ? { takeoverPauseMs: takeoverHours * 3_600_000 } : {}),
    ...(isInstagramAfterWindowPolicy(instagram) ? { instagramAfterWindowPolicy: instagram } : {}),
    ...(isWhatsAppAfterWindowPolicy(whatsapp) ? { whatsappAfterWindowPolicy: whatsapp } : {}),
    whatsappTemplateAutomationAllowlist: allowlist,
  };

  // What this change would widen, computed against what is stored — before anything is written.
  const before = (await readPolicies(getDb(), context)).find((policy) => policy.channelAccountId === null);
  if (before !== undefined) {
    const confidence = isConfidencePreset(confidencePreset)
      ? confidenceSettingsFor(confidencePreset)
      : { confidenceThreshold: before.confidenceThreshold, mandatoryReviewReasons: before.mandatoryReviewReasons };
    const impacts = policyImpactsOf(
      {
        mode: before.mode,
        confidenceThreshold: before.confidenceThreshold,
        mandatoryReviewReasons: before.mandatoryReviewReasons,
        instagramAfterWindowPolicy: before.instagramAfterWindowPolicy,
        whatsappAfterWindowPolicy: before.whatsappAfterWindowPolicy,
        whatsappTemplateAutomationAllowlist: before.whatsappTemplateAutomationAllowlist,
      },
      {
        mode: isAiMode(mode) ? mode : before.mode,
        confidenceThreshold: confidence.confidenceThreshold,
        mandatoryReviewReasons: confidence.mandatoryReviewReasons,
        instagramAfterWindowPolicy: isInstagramAfterWindowPolicy(instagram) ? instagram : before.instagramAfterWindowPolicy,
        whatsappAfterWindowPolicy: isWhatsAppAfterWindowPolicy(whatsapp) ? whatsapp : before.whatsappAfterWindowPolicy,
        whatsappTemplateAutomationAllowlist: allowlist,
      },
    );
    if (impacts.length > 0 && field(formData, "confirm") !== "on") {
      // Refused, not saved-and-warned. The point of a confirmation is that the change has not happened.
      revalidatePath(path);
      redirect(`${path}?outcome=CONFIRM&impacts=${encodeURIComponent(impacts.join(","))}`);
    }
  }

  const outcome = await savePolicy(getDb(), context, null, edit);
  revalidatePath(path);
  redirect(
    `${path}?outcome=${outcome.status === "SAVED" ? "SAVED" : outcome.status === "UNCHANGED" ? "UNCHANGED" : outcome.status === "REFUSED" ? "REFUSED" : "GONE"}`,
  );
}

