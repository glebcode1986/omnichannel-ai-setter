/**
 * A `ReplyModel` that answers from the case instead of from a provider.
 *
 * It exists so the suite runs in CI with no key, no network and no cost, and so a case can specify a
 * *misbehaving* model: a refusal, unreadable output, a citation that was never supplied. A harness that can
 * only produce well-formed answers cannot test what the system does when a model does not.
 *
 * It is a `ReplyModel` like any other, which is the point — the engine cannot tell the difference, so what
 * the suite exercises is the real path.
 */
import type { ReplyGenerationRequest, ReplyGenerationResult, ReplyModel } from "@omnichannel/application";
import { ReplyModelUnavailableError } from "@omnichannel/application";

import type { FixtureReply } from "./case";

export const FIXTURE_PROVIDER = "fixture";
export const FIXTURE_MODEL = "golden-case";

export function createFixtureModel(reply: FixtureReply): ReplyModel {
  return {
    generate(_request: ReplyGenerationRequest): Promise<ReplyGenerationResult> {
      const base = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, latencyMs: 0 };
      switch (reply.kind) {
        case "OUTPUT":
          return Promise.resolve({ ...base, output: reply.output });
        case "MALFORMED":
          return Promise.resolve({ ...base, output: reply.output });
        case "REFUSAL":
          return Promise.resolve({ ...base, output: undefined, rejection: "REFUSAL" });
        case "UNAVAILABLE":
          return Promise.reject(new ReplyModelUnavailableError("fixture_unavailable"));
      }
    },
  };
}
