import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createEmbeddings } from "./embeddings";
import type { WorkerEnv } from "./env";

/** The column's width. A configured value that disagrees with it can never match a stored vector. */
const COLUMN_DIMENSIONS = 1_024;

function logger() {
  const events: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const record = (event: string, fields?: Readonly<Record<string, unknown>>) => {
    events.push({ event, ...(fields === undefined ? {} : { fields }) });
  };
  return { events, logger: { info: record, warn: record, error: record, debug: vi.fn(), child: vi.fn() } as unknown as Logger };
}

const env = (overrides: Partial<WorkerEnv> = {}) =>
  ({
    VOYAGE_API_KEY: "voyage-test-key",
    AI_EMBEDDING_MODEL: "voyage-3.5",
    AI_EMBEDDING_DIMENSIONS: COLUMN_DIMENSIONS,
    AI_EMBEDDING_REVISION: "v1",
    ...overrides,
  }) as WorkerEnv;

describe("choosing an embedding provider", () => {
  it("runs hybrid retrieval when the configuration agrees with the column", () => {
    const { logger: log, events } = logger();

    expect(createEmbeddings(env(), log)).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it("runs lexical-only, without complaint, when no key is configured", () => {
    const { logger: log, events } = logger();

    // A supported mode rather than a degraded one: a fact retrieval misses becomes MISSING_FACT and
    // human review, never an invented answer.
    expect(createEmbeddings(env({ VOYAGE_API_KEY: undefined }), log)).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("refuses a width the column cannot hold, and says so", () => {
    const { logger: log, events } = logger();

    // The failure this prevents is the quiet one: a mismatched width matches no stored vector, so every
    // semantic query returns nothing and every draft is held. Retrieval would look like it was working.
    for (const dimensions of [COLUMN_DIMENSIONS - 1, COLUMN_DIMENSIONS + 1, 768]) {
      expect(createEmbeddings(env({ AI_EMBEDDING_DIMENSIONS: dimensions }), log)).toBeUndefined();
    }

    expect(events.map((entry) => entry.event)).toEqual([
      "worker.embedding_dimensions_mismatch",
      "worker.embedding_dimensions_mismatch",
      "worker.embedding_dimensions_mismatch",
    ]);
    expect(events[0]?.fields).toMatchObject({ configured: COLUMN_DIMENSIONS - 1, column: COLUMN_DIMENSIONS });
  });

  it("never stops the worker over a retrieval setting", () => {
    const { logger: log } = logger();

    // Taking ingestion down over this would turn a degraded feature into an outage, and inbound customer
    // messages are the one thing that must keep being stored.
    expect(() => createEmbeddings(env({ AI_EMBEDDING_DIMENSIONS: 1 }), log)).not.toThrow();
  });
});
