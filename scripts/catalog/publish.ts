/**
 * `pnpm catalog:publish` — publishes the accepted plan and add-on catalogue into a deployment's database
 * (#43, PRICING_PACKAGING.md v0.6, PHASE6_COMMERCIALIZATION_PLAN.md §"Load versioned … catalog from
 * server-side product configuration").
 *
 * This is the producer that configuration line asks for, and the absence of it was not a small gap.
 * `publishAcceptedCatalog` was reachable only from tests, so a deployed database held **no plan versions
 * and no prices at all** — which does not fail loudly, it fails quietly in three places at once:
 *
 * - `ensureWorkspaceTrial` is called when the first Business Profile connects, finds no trial plan, and
 *   returns `{ started: false }`. A real workspace connects a channel and silently gets no trial.
 * - `readCheckoutOffer` has nothing to quote and refuses with `NO_PRICE`.
 * - the billing screen reads an empty catalogue, so a pricing page shows nothing to buy.
 *
 * Every one of those reads like a product decision rather than a missing deployment step, which is why it
 * survived review: the code is correct and nothing calls it. The same shape as the release tables before
 * `pnpm release:record` existed, and the same answer.
 *
 * **A catalogue version is never edited, so publishing is not idempotent**: `publishPlanVersion` cuts
 * version N+1 every time it is asked. `accepted-catalog.ts` says a deployment runs it once and a repeat is
 * "wasteful rather than wrong" — a second identical version is on sale and `readCatalog` still answers
 * with one plan per code. This script therefore declines by default once anything is published and says
 * what it found; `--republish` cuts a new version deliberately, which is what a changed price needs.
 *
 * `--dry-run` writes nothing and reports the decision, which is the honest way to ask what a deployment
 * would do.
 */
import process from "node:process";

import { publishAcceptedCatalog } from "../../packages/db/src/accepted-catalog.ts";
import { readCatalog } from "../../packages/db/src/catalog-store.ts";
import { createDbClient } from "../../packages/db/src/client.ts";

export interface CataloguePresence {
  readonly planCodes: readonly string[];
  readonly addOnCodes: readonly string[];
}

export type PublicationDecision =
  | { readonly action: "PUBLISH"; readonly reason: string }
  | { readonly action: "REPUBLISH"; readonly reason: string }
  | { readonly action: "DECLINE"; readonly reason: string };

/**
 * Whether to publish, cut another version, or decline — the whole decision, as a function of what is
 * already there.
 *
 * Separate from the command so it can be tested without a database, and so the rule is one expression
 * rather than a shape spread through console output. `--republish` is deliberately required rather than
 * inferred from the content: comparing the accepted constants against the newest published version to
 * decide "has the price changed" would put the versioning rule in a second place, and the spec puts it in
 * one — changing a price means publishing a new version, on purpose.
 */
export function decidePublication(input: { readonly present: CataloguePresence; readonly republish: boolean }): PublicationDecision {
  const { present, republish } = input;
  const empty = present.planCodes.length === 0 && present.addOnCodes.length === 0;
  if (empty) {
    return { action: "PUBLISH", reason: "no plan or add-on version is published yet" };
  }
  if (republish) {
    return {
      action: "REPUBLISH",
      reason: `publishing a new version over ${String(present.planCodes.length)} plan(s) and ${String(present.addOnCodes.length)} add-on(s) already on sale`,
    };
  }
  return {
    action: "DECLINE",
    reason:
      `${String(present.planCodes.length)} plan(s) and ${String(present.addOnCodes.length)} add-on(s) are already published ` +
      `(${[...present.planCodes, ...present.addOnCodes].join(", ")}). A version is never edited, so publishing again ` +
      `would put a second identical version on sale. Pass --republish if the accepted catalogue has changed.`,
  };
}

async function main(): Promise<number> {
  const republish = process.argv.includes("--republish");
  const dryRun = process.argv.includes("--dry-run");
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.error("DATABASE_URL is not set; this command writes to a deployment's own database.");
    return 1;
  }

  const db = createDbClient({ connectionString });
  try {
    // Every availability, not just `PUBLIC`: a package withdrawn from sale (`LEGACY`) or never advertised
    // (`PRIVATE`) is still published, and declining on only what a pricing page shows would cut a
    // duplicate version behind it.
    const catalogue = await readCatalog(db, ["PUBLIC", "PRIVATE", "LEGACY"]);
    const present: CataloguePresence = {
      planCodes: catalogue.plans.map((plan) => plan.code),
      addOnCodes: catalogue.addOns.map((addOn) => addOn.code),
    };
    const decision = decidePublication({ present, republish });

    if (decision.action === "DECLINE") {
      console.error(`Declined: ${decision.reason}`);
      return 1;
    }
    if (dryRun) {
      console.log(`Would ${decision.action === "PUBLISH" ? "publish" : "republish"}: ${decision.reason}`);
      return 0;
    }

    const published = await publishAcceptedCatalog(db);
    console.log(`${decision.action === "PUBLISH" ? "Published" : "Republished"}: ${decision.reason}`);
    for (const plan of published.plans) {
      console.log(`  plan     ${plan.code} v${String(plan.version)}`);
    }
    for (const addOn of published.addOns) {
      console.log(`  add-on   ${addOn.code} v${String(addOn.version)}`);
    }
    return 0;
  } finally {
    await db.$disconnect();
  }
}

// Guarded so the decision above can be imported by a test without the command running.
if (process.argv[1] !== undefined && process.argv[1].endsWith("publish.ts")) {
  process.exit(await main());
}
