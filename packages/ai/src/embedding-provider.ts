/**
 * Voyage AI implementation of the application's `EmbeddingProvider` port (ADR-011).
 *
 * Voyage is Anthropic's documented embeddings partner; Anthropic's own API has no embeddings endpoint. As
 * with the reply model, the provider is configuration: this file is the only thing that knows Voyage's wire
 * format, and another provider means another file behind the same port.
 *
 * Two properties this file is responsible for:
 *
 * - **A vector is never separated from its profile.** Every returned vector carries `profile`, which is
 *   what retrieval filters stored rows on. Two embedding models' vectors are therefore never compared, even
 *   if someone changes `model` in the environment and forgets to re-embed.
 * - **Queries and documents are embedded differently.** Voyage's models are asymmetric: a question and the
 *   passage that answers it are encoded with different `input_type` values, and using one for both quietly
 *   costs recall. The intent is a parameter of the port, not a setting.
 */
import { EmbeddingUnavailableError, type EmbeddingIntent, type EmbeddingProvider, type EmbeddingVector } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";

import { createFetchModelHttpPort, type ModelHttpPort } from "./transport";

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
export const EMBEDDING_PROVIDER_NAME = "voyage";
/** Matches the `vector(1024)` column; changing it is a migration plus a controlled re-embedding. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Long inputs are truncated by the provider anyway. Capping here keeps a runaway document from turning one
 * retrieval into a multi-second request, and keeps the request body predictable.
 */
const MAX_INPUT_CHARS = 8_000;
const MAX_BATCH = 128;

export interface VoyageEmbeddingConfig {
  readonly apiKey: string;
  /** Supplied by the composition root; never hard-coded into behaviour. */
  readonly model: string;
  readonly dimensions?: number;
  /** Bumped by hand when the profile must change without the model name changing. */
  readonly revision?: string;
  readonly timeoutMs?: number;
  readonly http?: ModelHttpPort;
  readonly url?: string;
  readonly logger?: Logger;
}

/**
 * Identity of a set of vectors: model, width and revision. Stored on every embedded row, so a change to any
 * part of it makes old vectors invisible to new queries rather than silently comparable with them.
 */
export function embeddingProfileId(model: string, dimensions: number, revision = "v1"): string {
  return `${model}:${String(dimensions)}:${revision}`;
}

export function createVoyageEmbeddingProvider(config: VoyageEmbeddingConfig): EmbeddingProvider {
  const http = config.http ?? createFetchModelHttpPort();
  const dimensions = config.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const profile = embeddingProfileId(config.model, dimensions, config.revision);

  return {
    profile,
    dimensions,
    async embed(texts: readonly string[], intent: EmbeddingIntent): Promise<readonly EmbeddingVector[]> {
      if (texts.length === 0) {
        return [];
      }
      if (texts.length > MAX_BATCH) {
        throw new EmbeddingUnavailableError("batch_too_large");
      }

      const result = await http.send({
        url: config.url ?? VOYAGE_EMBEDDINGS_URL,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          input: texts.map((text) => (text.length <= MAX_INPUT_CHARS ? text : text.slice(0, MAX_INPUT_CHARS))),
          input_type: intent === "QUERY" ? "query" : "document",
          output_dimension: dimensions,
        }),
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      if (result.kind === "NO_RESPONSE") {
        throw new EmbeddingUnavailableError(result.reason.toLowerCase());
      }
      if (result.status < 200 || result.status >= 300) {
        config.logger?.warn("ai.embedding_provider_error", { status: result.status });
        // The provider's message never travels with the error: it can quote the text that was embedded.
        throw new EmbeddingUnavailableError(`http_${String(result.status)}`);
      }
      return readVectors(result.body, texts.length, dimensions, profile);
    },
  };
}

/**
 * Vectors are matched back to inputs by the provider's own `index`, never by array position: the API
 * documents that entries may be returned out of order, and silently mis-pairing a query with another
 * input's vector would produce confidently wrong retrieval with nothing to show for it in a log.
 */
function readVectors(body: string, expected: number, dimensions: number, profile: string): readonly EmbeddingVector[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EmbeddingUnavailableError("unreadable_response");
  }
  const data = isRecord(parsed) ? parsed["data"] : undefined;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new EmbeddingUnavailableError("unexpected_response_shape");
  }

  const vectors = new Array<EmbeddingVector | undefined>(expected).fill(undefined);
  for (const entry of data) {
    if (!isRecord(entry)) {
      throw new EmbeddingUnavailableError("unexpected_response_shape");
    }
    const index = entry["index"];
    const values = entry["embedding"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected) {
      throw new EmbeddingUnavailableError("unexpected_response_shape");
    }
    if (!Array.isArray(values) || values.length !== dimensions) {
      // A vector of the wrong width cannot be stored or compared; it is a misconfiguration, not a result.
      throw new EmbeddingUnavailableError("unexpected_dimensions");
    }
    for (const value of values) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new EmbeddingUnavailableError("unexpected_response_shape");
      }
    }
    vectors[index] = { profile, values: values as number[] };
  }

  const complete: EmbeddingVector[] = [];
  for (const vector of vectors) {
    if (vector === undefined) {
      // Duplicate indices leave a hole; returning a short list would misalign every caller downstream.
      throw new EmbeddingUnavailableError("unexpected_response_shape");
    }
    complete.push(vector);
  }
  return complete;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
