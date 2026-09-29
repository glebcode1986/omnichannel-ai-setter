/**
 * The periodic operational picture (Issue #56).
 *
 * One loop produces everything an operator sees: component health, the single line above it, the product
 * metrics, and any incident worth waking someone for. They are produced together on purpose — a health
 * line that says "all systems operational" beside a metric showing four hundred unresolved sends is worse
 * than either alone, and the only reliable way to avoid that is to compute them from one instant.
 *
 * The output is a structured log event rather than an HTTP endpoint. The dashboard reads the same numbers
 * from PostgreSQL directly, and a worker that also served traffic would be a second thing to keep alive
 * during exactly the incidents this is describing.
 */
import { collectHealth, type HealthProbe } from "@omnichannel/application";
import { overallHealth, type ComponentHealth } from "@omnichannel/domain";
import type { ReliabilitySnapshot } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import type { QueueDepth } from "@omnichannel/queue";

import type { IncidentReporter } from "./incident-reporter";
import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface HealthReporterOptions {
  readonly intervalMs: number;
  readonly probes: () => Promise<readonly HealthProbe[]>;
  readonly snapshot: (now: Date) => Promise<ReliabilitySnapshot>;
  readonly depths: () => Promise<readonly QueueDepth[]>;
  readonly incidents: IncidentReporter;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Called with each observation, so the composition root can keep the latest for anything that asks. */
  readonly onObserved?: (components: readonly ComponentHealth[]) => void;
}

export function startHealthReporter(options: HealthReporterOptions): RecoveryLoop {
  let previous: readonly ComponentHealth[] = [];

  return startRecoveryLoop({
    name: "health",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const at = options.now();
      const probes = await options.probes();
      // Health first and independently: the snapshot and the depths both need dependencies that may be
      // the very thing that is down, and a failure there must not stop health from being reported.
      const components = await collectHealth(probes, at, previous);
      previous = components;
      options.onObserved?.(components);

      const [snapshot, depths] = await Promise.all([
        options.snapshot(at).catch(() => undefined),
        options.depths().catch(() => undefined),
      ]);
      options.incidents.report(at);

      return {
        overall: overallHealth(components),
        components: components.map((component) => ({ kind: component.kind, id: component.id, state: component.state, summary: component.summary })),
        ...(snapshot === undefined ? {} : { metrics: { ...snapshot, at: snapshot.at.toISOString() } }),
        ...(depths === undefined ? {} : { queues: depths }),
      };
    },
  });
}
