/**
 * What a business signals back to a customer while a reply is being prepared (#22, P4-05).
 *
 * Three values rather than two booleans, because the provider does not offer the two independently: the
 * documented request that raises a typing indicator carries the read status as a required field. A pair of
 * booleans would let an owner ask for a combination no channel can actually perform.
 */
export const PRESENCE_MODES = ["OFF", "READ_ON_RECEIPT", "READ_AND_TYPING"] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

export function isPresenceMode(value: string): value is PresenceMode {
  return (PRESENCE_MODES as readonly string[]).includes(value);
}

export const DEFAULT_PRESENCE_TYPING_LEAD_MS = 8_000;

/**
 * The longest lead any supported channel can honour.
 *
 * WhatsApp dismisses its typing indicator after 25 seconds, so asking for more would display it, drop it,
 * and leave the customer watching nothing until the reply arrived. The adapter owns the number for its own
 * calls; this is the same bound expressed where an owner's setting is validated.
 */
export const MAX_PRESENCE_TYPING_LEAD_MS = 25_000;
