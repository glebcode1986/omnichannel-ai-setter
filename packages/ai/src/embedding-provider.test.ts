import { EmbeddingUnavailableError } from "@omnichannel/application";
import { describe, expect, it } from "vitest";

import { createVoyageEmbeddingProvider, embeddingProfileId, VOYAGE_EMBEDDINGS_URL } from "./embedding-provider";
import type { ModelHttpPort, ModelHttpRequest, ModelHttpResult } from "./transport";

const API_KEY = "pa-fake-key-for-tests";
const DIMENSIONS = 1_024;

const axis = (index: number): number[] => {
  const values = new Array<number>(DIMENSIONS).fill(0);
  values[index] = 1;
  return values;
};

function scripted(results: ModelHttpResult[]) {
  const requests: ModelHttpRequest[] = [];
  let index = 0;
  const port: ModelHttpPort = {
    send: (request) => {
      requests.push(request);
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(next ?? { kind: "NO_RESPONSE", reason: "NETWORK" });
    },
  };
  return { port, requests };
}

const response = (data: unknown): ModelHttpResult => ({ kind: "RESPONSE", status: 200, body: JSON.stringify({ data, model: "voyage-3.5" }) });

const provider = (results: ModelHttpResult[]) => {
  const { port, requests } = scripted(results);
  return { provider: createVoyageEmbeddingProvider({ apiKey: API_KEY, model: "voyage-3.5", http: port }), requests };
};

describe("request shape", () => {
  it("encodes a question differently from the passage that answers it", async () => {
    const { provider: embeddings, requests } = provider([response([{ index: 0, embedding: axis(0) }])]);

    await embeddings.embed(["Are you open Saturday?"], "QUERY");
    await embeddings.embed(["Saturday hours are 10:00-18:00."], "DOCUMENT");

    expect(requests[0]?.url).toBe(VOYAGE_EMBEDDINGS_URL);
    expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ input_type: "query", output_dimension: DIMENSIONS, model: "voyage-3.5" });
    // Using one intent for both sides costs recall silently: nothing fails, the answers are just worse.
    expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({ input_type: "document" });
  });

  it("caps input length and never puts the key anywhere but the header", async () => {
    const { provider: embeddings, requests } = provider([response([{ index: 0, embedding: axis(0) }])]);

    await embeddings.embed(["x".repeat(20_000)], "DOCUMENT");

    const body = JSON.parse(requests[0]?.body ?? "{}") as { input: string[] };
    expect(body.input[0]?.length).toBe(8_000);
    expect(requests[0]?.body).not.toContain(API_KEY);
    expect(requests[0]?.url).not.toContain(API_KEY);
  });

  it("does not call the provider for an empty batch", async () => {
    const { provider: embeddings, requests } = provider([response([])]);

    await expect(embeddings.embed([], "QUERY")).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe("response mapping", () => {
  it("stamps every vector with the profile that produced it", async () => {
    const { provider: embeddings } = provider([response([{ index: 0, embedding: axis(3) }])]);

    const [vector] = await embeddings.embed(["hello"], "QUERY");

    expect(embeddings.profile).toBe(embeddingProfileId("voyage-3.5", DIMENSIONS));
    // Retrieval filters stored rows on exactly this string, which is what stops two models' vectors mixing.
    expect(vector?.profile).toBe("voyage-3.5:1024:v1");
    expect(vector?.values).toHaveLength(DIMENSIONS);
    expect(embeddings.dimensions).toBe(DIMENSIONS);
  });

  it("gives a revision its own profile, so re-embedding is a deliberate act", () => {
    expect(embeddingProfileId("voyage-3.5", 1_024, "v2")).not.toBe(embeddingProfileId("voyage-3.5", 1_024, "v1"));
    expect(embeddingProfileId("voyage-3.5", 512)).not.toBe(embeddingProfileId("voyage-3.5", 1_024));
  });

  it("pairs vectors with inputs by the provider's index, not by arrival order", async () => {
    const { provider: embeddings } = provider([
      response([
        { index: 1, embedding: axis(1) },
        { index: 0, embedding: axis(0) },
      ]),
    ]);

    const [first, second] = await embeddings.embed(["question one", "question two"], "QUERY");

    // Trusting array order here would silently attach one input's meaning to another's text.
    expect(first?.values[0]).toBe(1);
    expect(second?.values[1]).toBe(1);
  });

  it("refuses a batch whose indices do not cover every input", async () => {
    const duplicated = provider([
      response([
        { index: 0, embedding: axis(0) },
        { index: 0, embedding: axis(1) },
      ]),
    ]);

    // Two vectors for input 0 and none for input 1: returning a short list would misalign the caller.
    await expect(duplicated.provider.embed(["one", "two"], "QUERY")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("rejects a vector of the wrong width rather than storing something uncomparable", async () => {
    const { provider: embeddings } = provider([response([{ index: 0, embedding: [0.1, 0.2] }])]);

    await expect(embeddings.embed(["hello"], "QUERY")).rejects.toThrow(/unexpected_dimensions/);
  });

  it("rejects non-numeric and non-finite components", async () => {
    const values = axis(0);
    values[5] = Number.POSITIVE_INFINITY;
    const infinite = provider([response([{ index: 0, embedding: values }])]);
    const textual = provider([response([{ index: 0, embedding: axis(0).map((value, index) => (index === 7 ? "0.1" : value)) }])]);

    await expect(infinite.provider.embed(["hello"], "QUERY")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await expect(textual.provider.embed(["hello"], "QUERY")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("reports transport and provider failures as unavailable, without quoting the provider", async () => {
    const timeout = provider([{ kind: "NO_RESPONSE", reason: "TIMEOUT" }]);
    const serverError = provider([{ kind: "RESPONSE", status: 500, body: '{"detail":"model overloaded for tenant acme"}' }]);
    const unreadable = provider([{ kind: "RESPONSE", status: 200, body: "not json" }]);
    const wrongShape = provider([response("nope")]);

    await expect(timeout.provider.embed(["a"], "QUERY")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await expect(serverError.provider.embed(["a"], "QUERY")).rejects.toThrow(/http_500/);
    // A provider message can quote the text that was embedded, so it never travels with the error.
    await expect(serverError.provider.embed(["a"], "QUERY")).rejects.not.toThrow(/acme/);
    await expect(unreadable.provider.embed(["a"], "QUERY")).rejects.toThrow(/unreadable_response/);
    await expect(wrongShape.provider.embed(["a"], "QUERY")).rejects.toThrow(/unexpected_response_shape/);
  });

  it("refuses a batch larger than the provider accepts instead of losing the tail", async () => {
    const { provider: embeddings, requests } = provider([response([])]);

    await expect(embeddings.embed(new Array<string>(129).fill("x"), "DOCUMENT")).rejects.toThrow(/batch_too_large/);
    expect(requests).toHaveLength(0);
  });
});
