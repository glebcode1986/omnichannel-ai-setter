/**
 * Turning probes into the health an operator reads (Issue #56).
 *
 * Two rules decide everything here, and both are about what a person does with the answer.
 *
 * **A probe that throws is an observation, not an error.** A database that refuses a connection has told
 * us its state plainly; treating that as a failure of the health check would leave the surface silent in
 * exactly the situation it exists for. So every probe is awaited independently and a rejection becomes
 * ACTION_REQUIRED.
 *
 * **The error's text never reaches the summary.** A connection failure's message routinely contains the
 * host, the user and sometimes the password; a provider's error body can contain an API key. The summary
 * is a short fixed phrase, and the detail belongs in a log the health surface does not render.
 *
 * `since` is carried forward from the previous observation whenever the state has not changed, because
 * "action required" and "action required for the last forty minutes" are different situations, and only
 * the second one tells someone whether their fix worked.
 */
import type { ComponentHealth, ComponentKind, ComponentState } from "@omnichannel/domain";

export interface ProbeResult {
  readonly state: ComponentState;
  /** A short phrase an owner can act on: "reconnect needed", "replies delayed". Never an exception. */
  readonly summary: string;
}

export interface HealthProbe {
  readonly kind: ComponentKind;
  /** Stable identifier for one instance — a channel account, a provider name. Never a secret. */
  readonly id: string;
  check(): Promise<ProbeResult>;
}

/** What a probe that threw is reported as. Fixed text: the thrown value is never rendered. */
const UNREACHABLE: ProbeResult = { state: "ACTION_REQUIRED", summary: "unreachable" };

export async function collectHealth(
  probes: readonly HealthProbe[],
  now: Date,
  previous: readonly ComponentHealth[] = [],
): Promise<readonly ComponentHealth[]> {
  const before = new Map(previous.map((component) => [`${component.kind}|${component.id}`, component]));
  const settled = await Promise.allSettled(probes.map((probe) => probe.check()));

  return probes.map((probe, index) => {
    const outcome = settled[index];
    const result = outcome?.status === "fulfilled" ? outcome.value : UNREACHABLE;
    const last = before.get(`${probe.kind}|${probe.id}`);
    return {
      kind: probe.kind,
      id: probe.id,
      state: result.state,
      summary: result.summary,
      // Unchanged state keeps its original moment; any change starts the clock again.
      since: last !== undefined && last.state === result.state ? last.since : now,
    } satisfies ComponentHealth;
  });
}
