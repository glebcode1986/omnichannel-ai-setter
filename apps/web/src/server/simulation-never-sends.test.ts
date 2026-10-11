/**
 * The simulation cannot send (AI_CONFIGURATION_UX.md, Issue #30).
 *
 * This is a hard invariant of the contract and no type enforces it, so it is asserted against the
 * module's own source. That is a coarse instrument and says so — what it proves is that the playground
 * creates no delivery, persists no draft and imports nothing that could reach a transport.
 *
 * It is not the only thing keeping a simulated reply away from a customer. `packages/evals/src/run.ts`
 * makes the same point about the same contract: the `ReplyModel` port has no transport, no recipient and
 * no tools, so even a live run against a real provider cannot deliver anything. This guards the layer
 * above that — the one where somebody could add a delivery by accident.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "simulation.ts"), "utf8");

/** Comments are stripped, so prose explaining the boundary is not mistaken for crossing it. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = withoutComments(source);

describe("the simulation", () => {
  it("creates no delivery of any kind", () => {
    // The only route to a customer is a DeliveryJobRecord. Naming one here would be the first step of
    // building a second route, which the contract forbids.
    for (const forbidden of ["deliveryJobRecord", "createDeliveryStore", "coordinateDelivery", "createDeliveryEngine", "scheduleDelivery"]) {
      expect(code, `simulation must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("imports nothing that could reach a transport", () => {
    for (const match of code.matchAll(/from "([^"]+)"/g)) {
      const specifier = match[1] ?? "";
      expect(specifier, "a transport import would give the playground a way to send").not.toMatch(
        /channel-instagram|channel-whatsapp|channel-core|queue|sender|transport/iu,
      );
    }
  });

  it("persists no draft: its store returns an id it never wrote", () => {
    // `createAiDraftStore` is the persisting implementation. The playground supplies its own in-memory
    // port instead, or a simulated reply would appear in the review queue and in every metric that
    // counts drafts.
    expect(code).not.toContain("createAiDraftStore");
    expect(code).toContain("saveDraft");
    expect(code).toMatch(/aiDraftId:\s*"simulated"/u);
  });

  it("writes nothing at all through the database client", () => {
    // Reads are expected — the saved configuration and the corpus are what make the run real. A write
    // would mean the playground had a side effect on the business's data.
    for (const forbidden of [".create(", ".update(", ".createMany(", ".updateMany(", ".delete(", ".deleteMany(", "$executeRaw"]) {
      expect(code, `simulation must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("says in words that nothing is sent, so the claim is not only in a test", () => {
    expect(source).toMatch(/never persisted/u);
    expect(source).toMatch(/nothing can send it/iu);
  });

  it("would notice a leak if one were introduced", () => {
    // Otherwise the checks above pass because the matchers are broken rather than because the module is
    // clean.
    const sample = withoutComments('import { x } from "@omnichannel/channel-instagram";\nawait db.deliveryJobRecord.create({});\n');

    expect(sample).toContain("deliveryJobRecord");
    expect(sample).toContain(".create(");
    expect([...sample.matchAll(/from "([^"]+)"/g)].some((match) => /channel-instagram/u.test(match[1] ?? ""))).toBe(true);
  });

  it("strips comments without eating the code around them", () => {
    const sample = ["/** mentions deliveryJobRecord */", 'const url = "https://example.test/x";', "const keep = 1; // mentions .create("].join("\n");
    const stripped = withoutComments(sample);

    expect(stripped).not.toContain("deliveryJobRecord");
    expect(stripped).toContain('"https://example.test/x"');
    expect(stripped).toContain("const keep = 1;");
  });
});
