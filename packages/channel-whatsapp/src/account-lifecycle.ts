/**
 * Coexistence offboarding and reconnection (#23, P4-06).
 *
 * When a business on coexistence changes device, re-registers the WhatsApp Business App or presses
 * Disconnect inside it, Meta withdraws this app's access to the number and says so on the `account_update`
 * field. Meta's own instruction to integrators is explicit — "Pause any pending Cloud API message sends
 * for this client" — so this is not telemetry: a scheduled reply that goes out after an offboard is a
 * message sent on an authorization that no longer exists.
 *
 * Reconnection is automatic and "typically completes within a few minutes" once the client opts in during
 * re-registration, and arrives the same way.
 *
 * These belong to the messaging account rather than to a conversation: they name no customer, produce no
 * message, and nothing in them can be attributed to a contact. So they are read here and applied by the
 * account-event port, never by the normalizer.
 *
 * Re-verified against Meta's live documentation on 2026-10-05.
 */
import { z } from "zod";

import type { WhatsAppWebhook } from "./payload";

/** The field Meta delivers account lifecycle changes under. */
export const ACCOUNT_UPDATE_FIELD = "account_update";

/**
 * What this product acts on, which is deliberately a subset.
 *
 * `PARTNER_REMOVED` is the explicit Disconnect inside the Business App; `ACCOUNT_OFFBOARDED` is the
 * automatic withdrawal after a device change or re-registration. They differ in cause and not in
 * consequence — in both the number has stopped being ours to send on — so both map to the same answer.
 */
export const ACCOUNT_LIFECYCLE_EVENTS = ["OFFBOARDED", "RECONNECTED"] as const;
export type AccountLifecycleEvent = (typeof ACCOUNT_LIFECYCLE_EVENTS)[number];

export interface AccountLifecycleChange {
  /** The messaging account the event names. A number is never named, because the event is not about one. */
  readonly wabaId: string;
  readonly event: AccountLifecycleEvent;
  /** The provider's own reason code when it supplies one. Never its prose. */
  readonly reason?: string;
}

const accountUpdateValue = z.looseObject({
  event: z.string().optional(),
  disconnection_info: z.looseObject({ reason: z.string().optional() }).optional(),
});

/**
 * Meta's own spellings, mapped to the two answers this product has.
 *
 * Listed rather than pattern-matched: Meta documents these three strings, and an event nobody has
 * classified must not be guessed into one of them — an unrecognised lifecycle event that was read as
 * "reconnected" would resume sending on a number that is gone.
 */
const EVENTS: Readonly<Record<string, AccountLifecycleEvent>> = {
  ACCOUNT_OFFBOARDED: "OFFBOARDED",
  PARTNER_REMOVED: "OFFBOARDED",
  ACCOUNT_RECONNECTED: "RECONNECTED",
};

/**
 * Every account lifecycle change in this webhook.
 *
 * A list, because one delivery may carry several, and anything unrecognised is dropped rather than
 * interpreted. Meta's own documentation is inconsistent about whether these are separate webhook fields or
 * `event` values on `account_update`; reading the field and matching on `value.event` satisfies both
 * spellings, and a payload that matches neither produces nothing.
 */
export function readAccountLifecycleChanges(webhook: WhatsAppWebhook): readonly AccountLifecycleChange[] {
  const changes: AccountLifecycleChange[] = [];
  for (const entry of webhook.entry ?? []) {
    const wabaId = entry.id;
    if (wabaId === undefined || wabaId === "") {
      continue;
    }
    for (const change of entry.changes ?? []) {
      if (change.field !== ACCOUNT_UPDATE_FIELD) {
        continue;
      }
      const parsed = accountUpdateValue.safeParse(change.value);
      if (!parsed.success || parsed.data.event === undefined) {
        continue;
      }
      const event = EVENTS[parsed.data.event];
      if (event === undefined) {
        continue;
      }
      const reason = parsed.data.disconnection_info?.reason;
      changes.push({ wabaId, event, ...(reason === undefined || reason === "" ? {} : { reason }) });
    }
  }
  return changes;
}
