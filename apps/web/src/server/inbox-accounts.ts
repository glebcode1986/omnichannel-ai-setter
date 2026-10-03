/**
 * What the Inbox is allowed to know about a channel account (Issue #28).
 *
 * The stored record carries a capabilities blob shaped by whichever platform wrote it and that platform's
 * own account id. Passing it whole to a filter control is how a provider payload ends up in generic UI —
 * so this narrows it to an id, a channel and a label, and lives in its own module so it can be tested
 * without dragging the authenticated request path in behind it.
 */
import type { ChannelAccountOption } from "@/ui/inbox/conversation-list";

/** Only the fields the narrowing reads. Accepting the whole record here would defeat the point. */
export interface NarrowableAccount {
  readonly id: string;
  readonly channel: string;
  readonly displayName: string | null;
  readonly externalAccountId: string;
}

export function channelAccountOptions(accounts: readonly NarrowableAccount[]): readonly ChannelAccountOption[] {
  return accounts.map((account) => ({
    id: account.id,
    channel: account.channel,
    // The display name is what an operator recognises; the platform id is a fallback, not a label.
    label: account.displayName ?? account.externalAccountId,
  }));
}
