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

/**
 * What the screen believed it was editing.
 *
 * The form carries the layer's own `updatedAt`, so the save can be refused when somebody else has written
 * the layer since the page was rendered. An empty field is a claim too — "there was no layer here" — and
 * it is checked the same way, so a stale tab cannot create a layer over a colleague's new one.
 *
 * Unparseable is treated as absent rather than as a refusal: the value is not something a person types,
 * and the only ways to get a bad one are a hand-edited form or a bug. Both are then answered by the
 * store's own conflict check against the row, which is where the decision belongs.
 */
export function expectedVoiceVersion(formData: FormData): { readonly updatedAt?: Date } {
  const raw = field(formData, "expectedUpdatedAt").trim();
  if (raw === "") {
    return {};
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? {} : { updatedAt: parsed };
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
