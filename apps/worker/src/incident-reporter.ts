/**
 * One outage, one notification (Issue #56).
 *
 * The requirement is "do not generate hundreds of duplicate Review/notification items for one shared
 * provider outage", and the reason is not tidiness: an operator with four hundred identical alerts has
 * the same information as an operator with none, and less time to act on it.
 *
 * So failures accumulate in a bounded window, `aggregateIncidents` folds them by what a person would do
 * about them, and an incident is announced at most once until it stops recurring. Three decisions:
 *
 * - **failures that will be retried are still recorded.** A provider failing forty times and recovering
 *   on the retry each time is a real outage, and counting only the final failures would hide it;
 * - **the window is bounded by count, not only by time.** During a storm the useful signal is the rate,
 *   and an unbounded buffer would be the second thing to fail;
 * - **memory, not a table.** This deduplicates announcements; what is actually broken lives in the health
 *   surface and the metrics snapshot, both read from the database. Losing this on restart costs at most
 *   one repeated notification, which is the safe direction.
 */
import { aggregateIncidents, warrantsNotification, type FailureSignal, type Incident } from "@omnichannel/domain";
import type { Logger } from "@omnichannel/observability";
import type { JobFailure } from "@omnichannel/queue";

/** Which component a queue's failures belong to, for grouping. */
const COMPONENT_FOR_QUEUE: Readonly<Record<string, FailureSignal["kind"]>> = {
  "ai-draft-generation": "AI_PROVIDER",
  delivery: "CHANNEL_ACCOUNT",
  "delivery-reconciliation": "CHANNEL_ACCOUNT",
  "inbound-debounce": "QUEUE",
  // Its own component rather than AI_PROVIDER: a transcriber failing leaves voice notes unread and holds
  // those replies for a person, which is a different thing for an operator to see than a reply model
  // failing. Added with #22 after #21 left it unmapped and falling through to INTEGRATION.
  "media-transcription": "TRANSCRIPTION",
  // A read receipt or typing indicator is carried by the channel account's own credential, so a run of
  // failures here is a fact about that account rather than about the queue.
  presence: "CHANNEL_ACCOUNT",
};

export interface IncidentReporter {
  record(failure: JobFailure): void;
  /** Folds what has accumulated and announces anything newly worth waking someone for. */
  report(now: Date): readonly Incident[];
  /** Current incidents, for the health surface. Does not announce anything. */
  current(): readonly Incident[];
}

export interface IncidentReporterOptions {
  readonly logger: Logger;
  /** Failures older than this stop counting, so a recovered outage eventually stops being an incident. */
  readonly windowMs: number;
  /** Hard cap on retained signals; the oldest are dropped first. */
  readonly limit: number;
  readonly thresholds: { readonly occurrences: number; readonly conversations: number };
  readonly now: () => Date;
}

export function createIncidentReporter(options: IncidentReporterOptions): IncidentReporter {
  let signals: FailureSignal[] = [];
  const announced = new Set<string>();

  const fold = (now: Date): readonly Incident[] => {
    const cutoff = now.getTime() - options.windowMs;
    signals = signals.filter((signal) => signal.at.getTime() >= cutoff);
    return aggregateIncidents(signals);
  };

  return {
    record(failure) {
      signals.push({
        kind: COMPONENT_FOR_QUEUE[failure.queueName] ?? "INTEGRATION",
        // The queue, not the tenant: one provider outage hitting thirty workspaces is one incident, and
        // grouping by workspace would reproduce the flood the aggregation exists to prevent.
        id: failure.queueName,
        code: failure.errorName,
        at: options.now(),
        ...(failure.conversationId === undefined ? {} : { conversationId: failure.conversationId }),
      });
      if (signals.length > options.limit) {
        signals = signals.slice(signals.length - options.limit);
      }
    },

    report(now) {
      const incidents = fold(now);
      const worth = incidents.filter((incident) => warrantsNotification(incident, options.thresholds));
      const keys = new Set(worth.map((incident) => incident.key));
      for (const incident of worth) {
        if (!announced.has(incident.key)) {
          announced.add(incident.key);
          options.logger.error("worker.incident", {
            incident: incident.key,
            kind: incident.kind,
            code: incident.code,
            occurrences: incident.occurrences,
            affectedConversations: incident.affectedConversations,
            firstSeen: incident.firstSeen.toISOString(),
          });
        }
      }
      // Forgotten once it stops recurring, so the same outage next week is announced again rather than
      // silently suppressed by a memory of the last one.
      for (const key of announced) {
        if (!keys.has(key)) {
          announced.delete(key);
          options.logger.info("worker.incident_cleared", { incident: key });
        }
      }
      return worth;
    },

    current() {
      return fold(options.now());
    },
  };
}
