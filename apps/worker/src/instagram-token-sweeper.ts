/**
 * The loop that keeps Instagram connections alive (#9).
 *
 * Without it, every part of the token lifecycle is implemented and none of it ever runs: a 60-day token
 * expires, the account still reads `CONNECTED`, the Inbox and the health probe still say the channel is
 * fine, and every reply fails with a provider error nobody asked for. That is the failure this exists to
 * make impossible — the refresh policy had no caller.
 *
 * It sweeps on expiry, not on an age: "expires within the horizon" is a question the database can answer
 * from an indexed column, and it keeps the work proportional to how many connections are actually near the
 * end of their term rather than to how many exist.
 *
 * One account's failure does not stop the batch, and one failing batch does not shout: `startRecoveryLoop`
 * reports the first failure and then stays quiet until it recovers, because a database outage must not
 * arrive as one log line per account per interval.
 */
import { createFetchHttpPort, refreshLongLivedToken, type InstagramHttpPort } from "@omnichannel/channel-instagram";
import {
  createCredentialCipher,
  findInstagramTokensDueForRefresh,
  markChannelAccountNeedsReauthorization,
  readChannelCredential,
  rotateChannelCredential,
  type DbClient,
  type InstagramTokenRefreshTarget,
} from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import type { WorkerEnv } from "./env";
import { refreshInstagramToken, type TokenRefreshDependencies, type TokenRefreshOutcome } from "./instagram-token-refresh";
import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

const CREDENTIAL_PURPOSE = "INSTAGRAM_ACCESS_TOKEN" as const;

/**
 * Six hours against a 60-day token with a 14-day horizon: around fifty attempts before expiry, so a long
 * database or Meta outage still leaves many tries. Sweeping more often would ask Meta the same question
 * for no gain — a token refreshed today is not due again for 24 hours by Meta's own rule.
 */
const TOKEN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TOKEN_REFRESH_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_SWEEP_BATCH = 100;

export interface InstagramTokenSweeperOptions {
  readonly intervalMs: number;
  /** How far ahead of expiry a token is worth refreshing. */
  readonly horizonMs: number;
  readonly limit: number;
  readonly findDue: (options: { readonly dueBefore: Date; readonly limit: number }) => Promise<readonly InstagramTokenRefreshTarget[]>;
  readonly refresh: TokenRefreshDependencies;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function startInstagramTokenSweeper(options: InstagramTokenSweeperOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "instagram_tokens_swept",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const at = options.now();
      const due = await options.findDue({
        dueBefore: new Date(at.getTime() + options.horizonMs),
        limit: options.limit,
      });
      if (due.length === 0) {
        return undefined;
      }
      const counts = new Map<TokenRefreshOutcome | "FAILED", number>();
      const count = (outcome: TokenRefreshOutcome | "FAILED"): void => {
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
      };
      for (const target of due) {
        try {
          count(await refreshInstagramToken(options.refresh, target));
        } catch (error) {
          // One unreachable provider or one undecryptable credential must not strand the rest: each of
          // them is still in the database, and the next sweep will reach it.
          count("FAILED");
          options.logger.warn("worker.instagram_token_refresh_failed", {
            workspaceId: target.workspaceId,
            channelAccountId: target.channelAccountId,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      return { found: due.length, ...Object.fromEntries([...counts].map(([outcome, total]) => [outcome.toLowerCase(), total])) };
    },
  });
}

/** Only the configuration a refresh reads. The worker's full env is assignable to it. */
export type TokenRefreshEnv = Pick<WorkerEnv, "CHANNEL_CREDENTIAL_KEY_ID" | "CHANNEL_CREDENTIAL_KEY">;

export interface InstagramTokenRefreshOverrides {
  /** Injectable so a test can compose the real loop and still answer for Meta. */
  readonly http?: InstagramHttpPort;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly horizonMs?: number;
  readonly limit?: number;
}

/** A loop that may not be running, and says which it is rather than leaving the caller to guess. */
export interface TokenRefreshLoop extends RecoveryLoop {
  readonly running: boolean;
}

/**
 * The loop as the worker runs it, or a loop that does nothing and reports that it is not running.
 *
 * Refreshing needs the credential-encryption key and nothing else — the `ig_refresh_token` grant
 * authenticates with the token it is refreshing, so no app secret is involved. Without that key the stored
 * tokens cannot be read at all, so there is no refresh to run.
 *
 * It does not warn about that. The same key is what the sender needs, so a deployment missing it already
 * hears `worker.no_channel_adapter`, and a second warning about one missing value is how a boot log becomes
 * something operators skim. `running` is the honest signal: `worker.started` lists the loops that are
 * actually running, so this one's absence is visible there instead.
 */
export function startInstagramTokenRefresh(
  env: TokenRefreshEnv,
  db: DbClient,
  logger: Logger,
  overrides: InstagramTokenRefreshOverrides = {},
): TokenRefreshLoop {
  if (env.CHANNEL_CREDENTIAL_KEY_ID === undefined || env.CHANNEL_CREDENTIAL_KEY === undefined) {
    logger.debug("worker.no_token_refresh", { reason: "credential-encryption configuration is missing" });
    return { running: false, close: () => Promise.resolve() };
  }
  const cipher = createCredentialCipher({
    keyId: env.CHANNEL_CREDENTIAL_KEY_ID,
    keys: { [env.CHANNEL_CREDENTIAL_KEY_ID]: Buffer.from(env.CHANNEL_CREDENTIAL_KEY, "base64") },
  });
  const http = overrides.http ?? createFetchHttpPort();
  const now = overrides.now ?? ((): Date => new Date());
  const loop = startInstagramTokenSweeper({
    intervalMs: overrides.intervalMs ?? TOKEN_SWEEP_INTERVAL_MS,
    horizonMs: overrides.horizonMs ?? TOKEN_REFRESH_HORIZON_MS,
    limit: overrides.limit ?? TOKEN_SWEEP_BATCH,
    findDue: (options) => findInstagramTokensDueForRefresh(db, options),
    refresh: {
      readCredential: (target) =>
        readChannelCredential(db, cipher, { workspaceId: target.workspaceId, credentialId: target.credentialId, purpose: CREDENTIAL_PURPOSE }),
      refresh: (token) => refreshLongLivedToken({ http }, token),
      rotate: (input) => rotateChannelCredential(db, cipher, { ...input, purpose: CREDENTIAL_PURPOSE }),
      markNeedsReauthorization: (input) => markChannelAccountNeedsReauthorization(db, input),
      logger,
      now,
    },
    logger,
    now,
  });
  return { running: true, close: () => loop.close() };
}
