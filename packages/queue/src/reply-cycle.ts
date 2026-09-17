/**
 * Reply-cycle ownership for inbound debounce (DELAY_ENGINE.md Stage A). The newest inbound message of a
 * conversation owns the reply cycle; debounce jobs for older anchors are superseded. Removing the older
 * job is best effort, so a superseded job that still wakes up checks ownership here and does nothing.
 * PostgreSQL state remains authoritative for the final pre-send gate; this is the queue-level guard.
 */
import type { Redis } from "ioredis";

import type { InboundDebounceJob } from "./payloads";

/** Long enough to outlive any debounce window and retry backoff. */
const REPLY_CYCLE_TTL_MS = 24 * 60 * 60 * 1000;

const CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local previousAnchor = ''
if current then
  local separator = string.find(current, '|', 1, true)
  local currentAt = tonumber(string.sub(current, 1, separator - 1))
  previousAnchor = string.sub(current, separator + 1)
  if previousAnchor == ARGV[2] then
    return {'CURRENT', previousAnchor}
  end
  local incomingAt = tonumber(ARGV[1])
  if incomingAt < currentAt or (incomingAt == currentAt and ARGV[2] < previousAnchor) then
    return {'STALE', previousAnchor}
  end
end
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'PX', ARGV[3])
return {'CLAIMED', previousAnchor}
`;

const COMMAND_NAME = "omnichannelClaimReplyCycle";

interface ReplyCycleCommands {
  [COMMAND_NAME](key: string, anchorAtMs: string, anchorMessageId: string, ttlMs: string): Promise<[string, string]>;
}

export type ReplyCycleClaim =
  /** This anchor now owns the cycle; `previousAnchorMessageId` (if any) is superseded. */
  | { readonly status: "CLAIMED"; readonly previousAnchorMessageId?: string }
  /** This anchor already owns the cycle (duplicate delivery of the same inbound message). */
  | { readonly status: "CURRENT" }
  /** A newer inbound message already owns the cycle; this anchor is stale. */
  | { readonly status: "STALE"; readonly currentAnchorMessageId: string };

export type ReplyCycleOwnership = "CURRENT" | "SUPERSEDED" | "UNTRACKED";

export interface ReplyCycleRegistry {
  claim(job: InboundDebounceJob): Promise<ReplyCycleClaim>;
  ownership(job: InboundDebounceJob): Promise<ReplyCycleOwnership>;
}

export function createReplyCycleRegistry(connection: Redis, prefix: string): ReplyCycleRegistry {
  if (!(COMMAND_NAME in connection)) {
    connection.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: CLAIM_SCRIPT });
  }
  const commands = connection as unknown as ReplyCycleCommands;
  const keyOf = (job: InboundDebounceJob) =>
    `${prefix}:reply-cycle:${encodeURIComponent(job.workspaceId)}:${encodeURIComponent(job.conversationId)}`;

  return {
    async claim(job) {
      const [status, anchor] = await commands[COMMAND_NAME](
        keyOf(job),
        String(Date.parse(job.anchorInboundAt)),
        job.anchorMessageId,
        String(REPLY_CYCLE_TTL_MS),
      );
      switch (status) {
        case "CLAIMED":
          return anchor === "" ? { status } : { status, previousAnchorMessageId: anchor };
        case "CURRENT":
          return { status };
        case "STALE":
          return { status, currentAnchorMessageId: anchor };
        default:
          throw new Error("Unexpected reply-cycle claim result");
      }
    },

    async ownership(job) {
      const current = await connection.get(keyOf(job));
      if (current === null) {
        // Expired or lost marker: the job cannot be proven stale; downstream DB checks decide.
        return "UNTRACKED";
      }
      return current.slice(current.indexOf("|") + 1) === job.anchorMessageId ? "CURRENT" : "SUPERSEDED";
    },
  };
}
