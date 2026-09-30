/**
 * Reading a voice out of a form (Issue #32).
 *
 * Its own module so it can be tested without the authenticated request path behind it, and because the one
 * thing it does that matters is *refusing* input: `replyLength` and `emoji` are enum columns, and a
 * hand-edited form must not be able to write a member nobody defined. An unrecognised value becomes "no
 * preference", which is the same thing an empty select means and the only reading that cannot surprise.
 */
import { isEmojiUsage, isReplyLength } from "@omnichannel/domain";
import type { StyleProfileDraft, StyleScope } from "@omnichannel/db";

export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** One phrase per line, the same visible convention the Knowledge Library uses for facts. */
export function lines(formData: FormData, name: string): readonly string[] {
  return field(formData, name)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** `WORKSPACE` only when the form said so; anything else is this profile's own layer. */
export function scopeFrom(formData: FormData): StyleScope {
  return field(formData, "scope") === "WORKSPACE" ? "WORKSPACE" : "BUSINESS_PROFILE";
}

export function voiceDraftFrom(formData: FormData): StyleProfileDraft {
  const replyLength = field(formData, "replyLength");
  const emoji = field(formData, "emoji");
  return {
    persona: field(formData, "persona"),
    tone: field(formData, "tone"),
    replyLength: isReplyLength(replyLength) ? replyLength : null,
    emoji: isEmojiUsage(emoji) ? emoji : null,
    greeting: field(formData, "greeting"),
    signOff: field(formData, "signOff"),
    preferredPhrases: lines(formData, "preferred"),
    avoidedPhrases: lines(formData, "avoided"),
    language: field(formData, "language"),
  };
}
