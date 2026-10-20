/**
 * Whether this worker can read a voice note, and what it says about the choice (Issue #21).
 *
 * The decision is made once at boot for the same reason the embeddings one is: an unconfigured provider
 * is a configuration rather than a fault, and discovering it per job would mean every recording producing
 * an error somewhere instead of one line at startup saying what this process can do.
 *
 * The deprecation warning is here rather than in the adapter because this is where the model is chosen.
 * `whisper-1` is removed from the provider's API on 2027-02-26, and the failure it produces afterwards is
 * a 400 on every recording — which reads like a code problem rather than a calendar one.
 */
import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createTranscription } from "./transcription";
import type { WorkerEnv } from "./env";

function logger() {
  const events: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const record = (event: string, fields?: Readonly<Record<string, unknown>>) => {
    events.push({ event, ...(fields === undefined ? {} : { fields }) });
  };
  return { events, logger: { info: record, warn: record, error: record, debug: vi.fn(), child: vi.fn() } as unknown as Logger };
}

const env = (overrides: Partial<WorkerEnv> = {}) =>
  ({
    OPENAI_API_KEY: "sk-transcription-test-key",
    AI_TRANSCRIPTION_MODEL: "gpt-transcribe",
    ...overrides,
  }) as WorkerEnv;

describe("choosing a transcription provider", () => {
  it("reads recordings when a key is configured, and reports the model it will run", () => {
    const { logger: log, events } = logger();

    const provider = createTranscription(env(), log);

    expect(provider).toMatchObject({ provider: "openai", model: "gpt-transcribe" });
    expect(events).toEqual([]);
  });

  it("runs without a transcriber, without complaint, when no key is configured", () => {
    const { logger: log, events } = logger();

    // A supported configuration rather than a degraded one: the recording is recorded as unread, the
    // draft carries AUDIO_NOT_TRANSCRIBED, and the reply waits for a person.
    expect(createTranscription(env({ OPENAI_API_KEY: undefined }), log)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("lets an operator name another model and runs the one they named", () => {
    const { logger: log } = logger();

    expect(createTranscription(env({ AI_TRANSCRIPTION_MODEL: "gpt-4o-transcribe" }), log)).toMatchObject({ model: "gpt-4o-transcribe" });
  });

  it("names the removal date when the deprecated model is configured, and still runs it", () => {
    const { logger: log, events } = logger();

    const provider = createTranscription(env({ AI_TRANSCRIPTION_MODEL: "whisper-1" }), log);

    // Named rather than refused: it is an operator's decision and it still works today.
    expect(provider).toMatchObject({ model: "whisper-1" });
    expect(events).toEqual([
      {
        event: "worker.transcription_model_deprecated",
        fields: { model: "whisper-1", removedOn: "2027-02-26", replacement: "gpt-transcribe" },
      },
    ]);
  });

  it("never puts the key in a log line", () => {
    const { logger: log, events } = logger();

    createTranscription(env({ AI_TRANSCRIPTION_MODEL: "whisper-1" }), log);

    expect(JSON.stringify(events)).not.toContain("sk-transcription-test-key");
  });
});
