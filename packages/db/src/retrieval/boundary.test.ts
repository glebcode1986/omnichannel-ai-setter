/**
 * Structural guards for the two boundaries retrieval rests on (ADR-010 as amended, ADR-011).
 *
 * `pnpm lint:boundaries` already enforces the package graph. These tests exist because the retrieval
 * contract names both properties explicitly, and because each would fail in a way ordinary tests cannot
 * see: an AI provider imported here would work perfectly, and a new style provenance would simply widen
 * what counts as a human-written example without anything looking broken.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (entry === "generated" || entry === "node_modules") {
      return [];
    }
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return entry.endsWith(".ts") ? [full] : [];
  });
}

describe("db retrieval has no AI-provider dependency", () => {
  it("declares no dependency on the AI package or on any provider SDK", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    const declared = Object.keys({ ...manifest["dependencies"], ...manifest["devDependencies"], ...manifest["peerDependencies"] });

    expect(declared).not.toContain("@omnichannel/ai");
    for (const sdk of ["openai", "@anthropic-ai/sdk", "voyageai", "cohere-ai", "@google/genai"]) {
      expect(declared).not.toContain(sdk);
    }
  });

  it("imports no AI provider anywhere in its sources", () => {
    const offenders = sourceFiles(path.join(packageDir, "src")).filter((file) => {
      const contents = readFileSync(file, "utf8");
      return /from\s+["']@omnichannel\/ai["']|from\s+["']openai["']|from\s+["']@anthropic-ai\//.test(contents);
    });

    // Query vectors arrive as data on the query; this package runs SQL and never asks a model for anything.
    expect(offenders).toEqual([]);
  });
});

describe("style provenance", () => {
  it("admits only verified human writing", () => {
    const schema = readFileSync(path.join(packageDir, "prisma/schema.prisma"), "utf8");
    const block = /enum StyleExampleProvenance \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    const values = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("/"));

    // The style retriever relies on this enum instead of filtering: widening it would silently turn
    // machine-written text into a tone example the business never approved.
    expect(values).toEqual(["HUMAN_TYPED", "HUMAN_EDITED_DRAFT"]);
  });
});
