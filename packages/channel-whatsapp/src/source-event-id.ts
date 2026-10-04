/**
 * Deterministic provider event identity.
 *
 * WhatsApp webhook items carry no event ID of their own, and Meta retries deliveries while telling
 * receivers to deduplicate. Ingestion deduplicates on
 * (workspace, business profile, channel account, sourceEventId), so the adapter synthesizes that key from
 * payload fields only — never from a clock, the receive time or randomness, or a redelivery would look new.
 *
 * The kind prefix matters more here than on Instagram: one `wamid` produces an inbound message, then a
 * `sent`, `delivered` and `read` status, and possibly a reaction. A bare `wamid` would collapse all five
 * onto one dedupe key, and the first one to arrive would silence the rest.
 */
import { createHash } from "node:crypto";

const MAX_LENGTH = 512;

export type WhatsAppEventKind = "msg" | "echo" | "status" | "read" | "reaction" | "button";

export function sourceEventId(kind: WhatsAppEventKind, ...parts: readonly string[]): string {
  const id = [kind, ...parts].join(":");
  if (id.length <= MAX_LENGTH) {
    return id;
  }
  // Truncating would cut the trailing parts that make the key unique. A digest stays deterministic.
  return `${kind}:sha256:${createHash("sha256").update(id).digest("hex")}`;
}
