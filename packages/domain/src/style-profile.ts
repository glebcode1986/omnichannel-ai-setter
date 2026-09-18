/**
 * How a business sounds (KNOWLEDGE_STYLE_UX.md; product-owner decision on PR #65).
 *
 * This is customer-owned configuration, not platform configuration. A persona baked into an environment
 * variable belongs to the deployment, so every tenant on it sounds the same and no business can change its
 * own voice without a release — which is why the runtime consumes a *resolved* profile even though the
 * editing UI is still Phase 5.
 *
 * Style says how to speak. It never says what is true: nothing here can establish a business fact, and the
 * retrieval boundary (ADR-011) keeps that separation structural.
 */
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";

export const REPLY_LENGTHS = ["SHORT", "MEDIUM", "LONG"] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];
export const isReplyLength = literalGuard(REPLY_LENGTHS);

export const EMOJI_USAGES = ["NONE", "SPARING", "FREELY"] as const;
export type EmojiUsage = (typeof EMOJI_USAGES)[number];
export const isEmojiUsage = literalGuard(EMOJI_USAGES);

/** A fully resolved voice: every field decided, nothing left for a caller to guess. */
export interface StyleProfile {
  /** Trusted instructions written by the business about who the assistant is and how it behaves. */
  readonly persona: string;
  readonly tone?: string;
  readonly replyLength: ReplyLength;
  readonly emoji: EmojiUsage;
  readonly greeting?: string;
  readonly signOff?: string;
  readonly preferredPhrases: readonly string[];
  readonly avoidedPhrases: readonly string[];
  /** BCP-47 language tag; absent means the business has no fixed language. */
  readonly language?: string;
}

/** One layer of the resolution chain. Absent fields defer to the layer beneath. */
export type StyleProfileLayer = Partial<StyleProfile>;

/**
 * The platform's voice of last resort. Deliberately bland: it exists so a business that has configured
 * nothing still gets a safe reply, not so it can stand in for a business that has.
 */
export const PLATFORM_STYLE_FALLBACK: StyleProfile = {
  persona: "You are the business's own assistant. Be warm, brief and concrete, and never invent facts.",
  replyLength: "SHORT",
  emoji: "SPARING",
  preferredPhrases: [],
  avoidedPhrases: [],
};

const MAX_PERSONA_CHARS = 2_000;
const MAX_PHRASES = 50;
const MAX_PHRASE_CHARS = 120;

/**
 * Resolves the layers into one profile, later layers winning field by field.
 *
 * Callers pass layers in increasing precedence: Workspace base, then the Business Profile's override, then
 * any conversation-level override. Field-by-field rather than whole-object, so a Business Profile that
 * only wants a different sign-off does not have to restate the persona it is happy with — and forgetting
 * to restate it cannot silently reset a business to the platform default.
 */
export function resolveStyleProfile(layers: readonly StyleProfileLayer[], fallback: StyleProfile = PLATFORM_STYLE_FALLBACK): StyleProfile {
  let resolved: StyleProfile = fallback;
  for (const layer of layers) {
    resolved = {
      persona: layer.persona ?? resolved.persona,
      ...optional("tone", layer.tone ?? resolved.tone),
      replyLength: layer.replyLength ?? resolved.replyLength,
      emoji: layer.emoji ?? resolved.emoji,
      ...optional("greeting", layer.greeting ?? resolved.greeting),
      ...optional("signOff", layer.signOff ?? resolved.signOff),
      preferredPhrases: layer.preferredPhrases ?? resolved.preferredPhrases,
      avoidedPhrases: layer.avoidedPhrases ?? resolved.avoidedPhrases,
      ...optional("language", layer.language ?? resolved.language),
    };
  }
  return validateStyleProfile(resolved);
}

/**
 * Rebuilt and bounded rather than trusted. The values arrive from storage or from an API, and they are
 * rendered into the model's system instructions, so an unbounded persona is a way to push everything else
 * out of the prompt.
 */
export function validateStyleProfile(profile: StyleProfile): StyleProfile {
  const persona = profile.persona.trim();
  if (persona === "") {
    throw new DomainValidationError("persona", "must not be empty");
  }
  if (persona.length > MAX_PERSONA_CHARS) {
    throw new DomainValidationError("persona", `must be at most ${String(MAX_PERSONA_CHARS)} characters`);
  }
  if (!isReplyLength(profile.replyLength)) {
    throw new DomainValidationError("replyLength", "must be SHORT, MEDIUM or LONG");
  }
  if (!isEmojiUsage(profile.emoji)) {
    throw new DomainValidationError("emoji", "must be NONE, SPARING or FREELY");
  }
  return {
    persona,
    ...optional("tone", trimmed(profile.tone)),
    replyLength: profile.replyLength,
    emoji: profile.emoji,
    ...optional("greeting", trimmed(profile.greeting)),
    ...optional("signOff", trimmed(profile.signOff)),
    preferredPhrases: phrases(profile.preferredPhrases, "preferredPhrases"),
    avoidedPhrases: phrases(profile.avoidedPhrases, "avoidedPhrases"),
    ...optional("language", trimmed(profile.language)),
  };
}

function phrases(values: readonly string[], field: string): readonly string[] {
  const cleaned = [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
  if (cleaned.length > MAX_PHRASES) {
    throw new DomainValidationError(field, `must contain at most ${String(MAX_PHRASES)} entries`);
  }
  if (cleaned.some((value) => value.length > MAX_PHRASE_CHARS)) {
    throw new DomainValidationError(field, `entries must be at most ${String(MAX_PHRASE_CHARS)} characters`);
  }
  return cleaned;
}

function trimmed(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned === "" ? undefined : cleaned;
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
