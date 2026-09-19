/**
 * Folding many failures into one incident (RELIABILITY_INCIDENTS.md, Issue #56).
 *
 * "Do not generate hundreds of duplicate Review/notification items for one shared provider outage." The
 * reason that matters is not tidiness: an operator with four hundred identical alerts has the same
 * information as an operator with none, and less time to act on it.
 *
 * So failures are grouped by what a person would actually do about them — the dependency and the thing
 * that broke — not by the conversation they happened in. One outage becomes one incident with a count,
 * and the count is the part that says how bad it is.
 */
import type { ComponentKind } from "./health";

export interface FailureSignal {
  readonly kind: ComponentKind;
  /** The failing instance: a provider name, a channel account. Never a secret. */
  readonly id: string;
  /** Class of failure, not its message. Two timeouts are one incident; a timeout and an auth error are not. */
  readonly code: string;
  readonly at: Date;
  /** What the failure affected, so an operator can see the blast radius without listing every one. */
  readonly conversationId?: string;
}

export interface Incident {
  readonly key: string;
  readonly kind: ComponentKind;
  readonly id: string;
  readonly code: string;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly occurrences: number;
  /** How many distinct conversations were affected — the number that says how bad this is. */
  readonly affectedConversations: number;
}

/** What makes two failures the same incident. */
export function incidentKey(signal: FailureSignal): string {
  return [signal.kind, signal.id, signal.code].join("|");
}

/**
 * Groups failures into incidents, newest activity last.
 *
 * Pure and order-independent in its result: the same signals in any order produce the same incidents, so a
 * report is reproducible and two workers observing the same outage do not disagree about it.
 */
export function aggregateIncidents(signals: readonly FailureSignal[]): readonly Incident[] {
  const byKey = new Map<string, { incident: Incident; conversations: Set<string> }>();

  for (const signal of signals) {
    const key = incidentKey(signal);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        incident: {
          key,
          kind: signal.kind,
          id: signal.id,
          code: signal.code,
          firstSeen: signal.at,
          lastSeen: signal.at,
          occurrences: 1,
          affectedConversations: signal.conversationId === undefined ? 0 : 1,
        },
        conversations: new Set(signal.conversationId === undefined ? [] : [signal.conversationId]),
      });
      continue;
    }
    if (signal.conversationId !== undefined) {
      existing.conversations.add(signal.conversationId);
    }
    existing.incident = {
      ...existing.incident,
      firstSeen: signal.at < existing.incident.firstSeen ? signal.at : existing.incident.firstSeen,
      lastSeen: signal.at > existing.incident.lastSeen ? signal.at : existing.incident.lastSeen,
      occurrences: existing.incident.occurrences + 1,
      affectedConversations: existing.conversations.size,
    };
  }

  // Sorted by key so two runs over the same signals produce identical output.
  return [...byKey.values()].map((entry) => entry.incident).sort((left, right) => (left.key < right.key ? -1 : 1));
}

/**
 * Whether an incident is worth waking someone for.
 *
 * A single retryable blip is not: it will very likely resolve itself, and an alert for it trains people to
 * ignore alerts. Sustained or widespread failure is, because by then it will not resolve itself.
 */
export function warrantsNotification(incident: Incident, thresholds: { readonly occurrences: number; readonly conversations: number }): boolean {
  return incident.occurrences >= thresholds.occurrences || incident.affectedConversations >= thresholds.conversations;
}
