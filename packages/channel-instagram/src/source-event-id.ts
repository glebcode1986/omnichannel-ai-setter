/**
 * Deterministic provider event identity.
 *
 * Instagram webhook items carry no event ID of their own, and Meta retries deliveries for up to 36 hours
 * while telling receivers to deduplicate. Ingestion deduplicates on
 * (workspace, business profile, channel account, sourceEventId), so the adapter synthesizes that key from
 * payload fields only — never from a clock, the receive time or randomness, or a redelivery would look new.
 *
 * The type prefix matters: an inbound message, its echo, its read receipt and a reaction to it all carry the
 * same `mid`, so a bare `mid` would make them collide on one dedupe key.
 */
import { createHash } from "node:crypto";

const MAX_LENGTH = 512;

export type InstagramEventKind = "msg" | "echo" | "read" | "reaction" | "postback";

export function sourceEventId(kind: InstagramEventKind, ...parts: readonly string[]): string {
  const id = [kind, ...parts].join(":");
  if (id.length <= MAX_LENGTH) {
    return id;
  }
  // Truncating would cut the trailing parts that make the key unique (a long postback payload would drop
  // its timestamp and collapse distinct events into one). A digest stays deterministic and collision-free.
  return `${kind}:sha256:${createHash("sha256").update(id).digest("hex")}`;
}
