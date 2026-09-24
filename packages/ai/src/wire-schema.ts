/**
 * The JSON Schema handed to the provider for structured output.
 *
 * It is written by hand rather than derived from the application's Zod schema, because the provider's schema
 * subset rejects several keywords Zod would emit (numeric bounds, string lengths). The enum members come
 * from the shared constant arrays, so the two definitions cannot drift apart on the values that matter; a
 * test asserts they stay in step.
 */
import { LEAD_STAGES } from "@omnichannel/domain";
import { MODEL_EMITTABLE_REASON_CODES } from "@omnichannel/application";

export const AI_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "reply",
    "confidence",
    "should_send",
    "needs_review",
    "reason_codes",
    "intent",
    "lead_stage",
    "suggested_action",
    "factual_source_ids",
  ],
  properties: {
    reply: { type: "string", description: "The message text to send to the customer." },
    confidence: { type: "number", description: "0..1 confidence that this reply is correct and appropriate." },
    should_send: { type: "boolean", description: "Advisory only; the system decides whether anything is sent." },
    needs_review: { type: "boolean", description: "True when a human should read this before it goes out." },
    reason_codes: {
      type: "array",
      items: { type: "string", enum: [...new Set<string>(MODEL_EMITTABLE_REASON_CODES)] },
      description: "Why review may be needed, from the allowed list only.",
    },
    intent: { type: ["string", "null"], description: "Short label for what the customer wants." },
    lead_stage: { type: ["string", "null"], enum: [...LEAD_STAGES, null] },
    suggested_action: { type: ["string", "null"], description: "Optional next step for a human." },
    factual_source_ids: {
      type: "array",
      items: { type: "string" },
      description: "Knowledge chunk IDs actually relied on. Never style example IDs.",
    },
  },
} as const;
