/**
 * Preparation of untrusted text before it is handed to a model.
 *
 * This is deliberately *not* filtering. Nothing is rewritten, classified or dropped because it looks like an
 * attack: customer text is evidence, and silently editing it would make the conversation history a lie. What
 * it does do is remove the characters that let text escape its own frame — direction overrides, zero-width
 * joiners and other invisibles — normalize the encoding so two spellings of the same string cannot fence
 * differently, and bound the length so one message cannot crowd out the instructions.
 *
 * The defence against instruction injection is structural and lives in `packages/ai`: untrusted text is
 * fenced with a per-request nonce and never enters the system role. If the nonce appears in the data itself,
 * the caller must regenerate it; `containsNonce` reports that without revealing the text.
 *
 * Characters are matched by code point rather than by regular expression, so the ranges are readable and
 * nothing depends on how a regex literal treats invisible characters.
 */

/** Invisible or direction-changing characters that let text pretend to be a different block. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space .. right-to-left mark
  [0x202a, 0x202e], // embedding and override controls
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x206f], // isolates and deprecated formatting
  [0xfeff, 0xfeff], // byte-order mark
];

/** C0/C1 controls, except tab (0x09) and newline (0x0a), which are ordinary in a message. */
function isControl(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a) {
    return false;
  }
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export const MAX_SEGMENT_CHARS = 4_000;

export function sanitizeUntrustedText(text: string, maxChars: number = MAX_SEGMENT_CHARS): string {
  let normalized = "";
  for (const character of text.normalize("NFKC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isInvisible(codePoint)) {
      continue;
    }
    normalized += isControl(codePoint) ? " " : character;
  }
  // A cut is marked, so the model cannot mistake a truncated message for the whole of it.
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)} [truncated]`;
}

/** True when the fence marker occurs inside data, which would let the data close its own fence. */
export function containsNonce(text: string, nonce: string): boolean {
  return nonce.length > 0 && text.includes(nonce);
}
