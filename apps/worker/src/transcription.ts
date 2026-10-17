/**
 * Whether this worker can read a voice note, decided once at boot (Issue #21).
 *
 * The same shape as the embeddings decision, for the same reason: an unconfigured provider is a
 * configuration rather than a fault, and discovering that per job would mean every recording producing an
 * error somewhere instead of one line at startup saying what this process can do.
 *
 * It does not stop the worker. Taking the queue down over a transcription setting would turn a degraded
 * feature into an outage — and the degraded behaviour is honest: the recording is recorded as unread, the
 * draft carries `AUDIO_NOT_TRANSCRIBED`, and the reply waits for a person.
 */
import { createOpenAiTranscriptionProvider } from "@omnichannel/ai";
import type { TranscriptionProvider } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";

import type { WorkerEnv } from "./env";

export function createTranscription(env: WorkerEnv, logger: Logger): TranscriptionProvider | undefined {
  if (env.OPENAI_API_KEY === undefined) {
    return undefined;
  }
  if (env.AI_TRANSCRIPTION_MODEL === "whisper-1") {
    // Named rather than refused: it is an operator's decision and it still works today. The date is the
    // part worth saying out loud, because the failure it produces afterwards is a provider 400 on every
    // recording, which reads like a code problem rather than a calendar one.
    logger.warn("worker.transcription_model_deprecated", { model: env.AI_TRANSCRIPTION_MODEL, removedOn: "2027-02-26", replacement: "gpt-transcribe" });
  }
  return createOpenAiTranscriptionProvider({ apiKey: env.OPENAI_API_KEY, model: env.AI_TRANSCRIPTION_MODEL, logger });
}
