/**
 * Where sign-in attempts are counted (#117).
 *
 * Redis, because a limit that is per process is not a limit: `packages/queue/src/families.ts` says so
 * about the only other rate limit in this product — "enforced across every worker sharing the queue, not
 * per process — which is what makes it meaningful once more than one worker runs" — and nothing in this
 * repository promises a single web instance. Module state does survive between requests here, so a map
 * would *work*, and would also be a protection claim that becomes false the first time the deployment is
 * replicated.
 *
 * `REDIS_URL` is one of only four unconditionally required variables in `env.ts`, so this substrate is
 * always present where the app boots at all.
 *
 * One round trip, atomically, with the house idiom: a Lua script registered through `defineCommand`,
 * exactly as `reply-cycle.ts` does. `INCR` followed by `EXPIRE` from the client would be two commands, and
 * a process that died between them would leave a counter with no expiry — a key that refuses that address
 * for ever.
 */
import { createRedisConnection } from "@omnichannel/queue";
import type Redis from "ioredis";

import { loadWebEnv } from "../env";
import { getLogger } from "./logger";
import type { AttemptCounter } from "./sign-in-rate-limit";

/** Increment, and set the expiry only when the key is new, so a window does not slide forward for ever. */
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const COMMAND_NAME = "omnichannelCountSignInAttempt";

interface CounterCommands {
  [COMMAND_NAME]: (key: string, windowMs: string) => Promise<number>;
}

/** A counter over one Redis connection. Exported for the tests, which supply their own client. */
export function redisAttemptCounter(connection: Redis): AttemptCounter {
  if (!(COMMAND_NAME in connection)) {
    connection.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: COUNT_SCRIPT });
  }
  const commands = connection as unknown as CounterCommands;
  return {
    increment: (key, windowMs) => commands[COMMAND_NAME](key, String(windowMs)),
  };
}

/**
 * A counter that answers "not over the limit" when Redis cannot be reached, and says so loudly.
 *
 * **This is a stated decision and the tradeoff is real.** Failing closed would mean a Redis blip locks
 * every customer out of signing in, including the operator who would fix it; failing open means the limit
 * is absent during an outage. For an availability control in front of the product's front door, open is
 * the right side to fail on — and the thing that makes it defensible rather than negligent is that it is
 * **not silent**: every occurrence logs `signin.rate_limit_unavailable` at warn, which is the signal that
 * the protection is currently off.
 *
 * Returning `1` rather than throwing is what expresses "allowed": the policy compares a count against a
 * limit, and one attempt is under every limit this product sets.
 */
function failOpen(counter: AttemptCounter): AttemptCounter {
  return {
    increment: async (key, windowMs) => {
      try {
        return await counter.increment(key, windowMs);
      } catch (error) {
        getLogger().warn("signin.rate_limit_unavailable", {
          // The key is a hash and carries no address, so it is safe to log and useful for correlation.
          key,
          windowMs,
          reason: error instanceof Error ? error.name : "unknown",
        });
        return 1;
      }
    },
  };
}

let shared: AttemptCounter | undefined;

/**
 * The process-wide counter.
 *
 * Lazily built, like every other composition module here (`db.ts`, `queue.ts`, `logger.ts`), so importing
 * this module never reads the environment and `next build` does not depend on a production secret.
 *
 * It matches the existing shape of this app's Redis use rather than improving on it: the connection is
 * created once and never closed, exactly as `getQueueProducer()` does. Giving the web process a shutdown
 * path for its Redis clients is a real gap and belongs to whoever closes it for both.
 */
export function getSignInCounter(): AttemptCounter {
  if (shared === undefined) {
    const env = loadWebEnv();
    shared = failOpen(redisAttemptCounter(createRedisConnection(env.REDIS_URL, "producer", getLogger())));
  }
  return shared;
}
