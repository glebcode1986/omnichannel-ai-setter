/**
 * What the worker can actually observe about its own dependencies (Issue #56).
 *
 * Each probe answers one question cheaply and without side effects, because it runs on a timer forever.
 * `SELECT 1` and a Redis `PING` are chosen for that reason: a probe that did real work would become its
 * own source of load during exactly the incident it is meant to describe.
 *
 * The summaries are fixed phrases. Nothing derived from an exception reaches them — a connection error's
 * message routinely carries the host, the user and sometimes the password, and a health surface is one of
 * the easiest places for that to end up on a screen.
 *
 * Channel accounts are probed from our own records rather than by calling Meta: whether a token has been
 * revoked is already recorded by onboarding and by every failed send, and polling the provider per
 * account per interval would be a storm of our own making.
 */
import type { HealthProbe, ProbeResult } from "@omnichannel/application";
import type { DbClient } from "@omnichannel/db";
import type { Redis } from "ioredis";

const OPERATIONAL = (summary: string): ProbeResult => ({ state: "OPERATIONAL", summary });

export function databaseProbe(db: DbClient): HealthProbe {
  return {
    kind: "DATABASE",
    id: "primary",
    async check() {
      await db.$queryRaw`SELECT 1`;
      return OPERATIONAL("connected");
    },
  };
}

export function queueProbe(connection: Redis): HealthProbe {
  return {
    kind: "QUEUE",
    id: "redis",
    async check() {
      // `status` is checked first because ioredis queues commands while reconnecting: a PING issued then
      // would sit in that queue and resolve on recovery, reporting health the system did not have.
      if (connection.status !== "ready") {
        return { state: "ACTION_REQUIRED", summary: "unreachable" };
      }
      await connection.ping();
      return OPERATIONAL("connected");
    },
  };
}

/**
 * Channel accounts, read from what onboarding and delivery already recorded.
 *
 * A disconnected or re-auth-needed account is ACTION_REQUIRED because a person can fix it in a minute by
 * reconnecting — and until they do, every reply for that account is held. That is the definition of
 * action required, and it is why this is the one component kind that blocks outbound by itself.
 */
export function channelAccountProbes(accounts: readonly { readonly id: string; readonly status: string }[]): readonly HealthProbe[] {
  return accounts.map((account) => ({
    kind: "CHANNEL_ACCOUNT" as const,
    id: account.id,
    check: () =>
      Promise.resolve(
        account.status === "CONNECTED"
          ? OPERATIONAL("connected")
          : { state: "ACTION_REQUIRED" as const, summary: account.status === "NEEDS_REAUTH" ? "reconnect needed" : "disconnected" },
      ),
  }));
}

/**
 * The model provider, judged by what it has actually done for us rather than by pinging it.
 *
 * A synthetic request would cost money on every interval and would not answer the question anyway: what
 * matters is whether real generations are succeeding. This is never action required — nobody can act on a
 * provider being slow or refusing, and paging for it is how alert fatigue starts.
 *
 * It sees only generations the provider answered badly. One that never answers leaves no row, fails its
 * job and is retried, and reaches an operator as an incident instead. Two views of one provider, and
 * neither pretends to be the other.
 */
export function aiProviderProbe(model: string, recentUnusable: () => Promise<number>, degradedAt: number): HealthProbe {
  return {
    kind: "AI_PROVIDER",
    id: model,
    async check() {
      const unusable = await recentUnusable();
      return unusable >= degradedAt
        ? { state: "DEGRADED", summary: "replies delayed" }
        : OPERATIONAL("generating");
    },
  };
}
