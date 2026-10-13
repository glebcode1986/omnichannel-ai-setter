/**
 * `pnpm billing:publish-routes` — writes a deployment's selling configuration from `BILLING_ROUTING`
 * (#46, ADR-019, BILLING_ROUTING.md §"The client never names a route").
 *
 * The producer that spec asks for. Routes come "from operator configuration", and nothing wrote one: so
 * `selectRoute` answered `NO_ROUTE` for every checkout and `recordVerifiedBillingEvent` answered
 * `UNKNOWN_ROUTE` for every webhook, in any deployment a test had not seeded. The catalogue had the same
 * shape of hole and `pnpm catalog:publish` is its answer; this is the other half, and a deployment that
 * means to take money runs both.
 *
 * **One variable holding one document**, the same shape `STRIPE_ROUTES` already uses for the credentials
 * side: JSON, validated here, and never echoed. Sellers and routes travel together so a route cannot name
 * a seller the configuration does not define — that mistake would otherwise be found by the first customer
 * rather than by whoever wrote the file. The two variables meet at `routeCode`: `BILLING_ROUTING` says what
 * a route *is*, `STRIPE_ROUTES` says which keys speak for it, and a route configured here with no
 * credentials registers no adapter and therefore cannot be chosen.
 *
 * **Re-running is normal.** Both writes are upserts, because a company changes its support address and a
 * route gains a currency; that is the difference between this and publishing a catalogue version, which
 * cuts a new one every time. `--dry-run` reports what it would write and touches nothing.
 *
 * **Nothing here is logged but codes.** The validation reports the path of a bad field and never its
 * value: `BILLING_ROUTING` carries a provider account reference, and ADR-017 keeps provider identifiers
 * out of anything a person reads by accident.
 */
import process from "node:process";

import { applyBillingRouting, type BillingRoutingConfig } from "../../packages/db/src/billing-routing-store.ts";
import { createDbClient } from "../../packages/db/src/client.ts";

/** Everything wrong with the document, rather than the first thing: a list is one round of editing. */
export interface ConfigFault {
  readonly path: string;
  readonly problem: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isNonEmptyString);

/**
 * Validates the document and says everything wrong with it, or returns the typed configuration.
 *
 * Hand-written rather than zod on purpose: this is root tooling, which has no zod of its own, and reaching
 * into a package's dependencies to borrow one would make a deployment command depend on where a package
 * manager happened to put a module. The field names are the store's own, so a fault names something the
 * operator wrote.
 *
 * It deliberately does **not** check capability coherence, currency codes or settlement models.
 * `upsertBillingRoute` does, against the same CHECK the table enforces, and it names which of the thirteen
 * capabilities is wrong. A second opinion here would be a second place the rule lived.
 */
export function readBillingRoutingConfig(raw: unknown): { readonly config: BillingRoutingConfig } | { readonly faults: readonly ConfigFault[] } {
  const faults: ConfigFault[] = [];
  if (!isRecord(raw)) {
    return { faults: [{ path: "BILLING_ROUTING", problem: "must be a JSON object with `sellers` and `routes`" }] };
  }
  const sellersRaw = raw.sellers;
  const routesRaw = raw.routes;
  if (!Array.isArray(sellersRaw)) {
    faults.push({ path: "sellers", problem: "must be an array" });
  }
  if (!Array.isArray(routesRaw)) {
    faults.push({ path: "routes", problem: "must be an array" });
  }
  if (faults.length > 0) {
    return { faults };
  }

  const sellers = (sellersRaw as unknown[]).map((entry, index) => {
    const at = `sellers[${String(index)}]`;
    if (!isRecord(entry)) {
      faults.push({ path: at, problem: "must be an object" });
      return undefined;
    }
    for (const field of ["code", "legalName", "displayName", "jurisdiction", "supportEmail"] as const) {
      if (!isNonEmptyString(entry[field])) {
        faults.push({ path: `${at}.${field}`, problem: "must be a non-empty string" });
      }
    }
    if (entry.legalConfigRef !== undefined && !isNonEmptyString(entry.legalConfigRef)) {
      faults.push({ path: `${at}.legalConfigRef`, problem: "must be a non-empty string when present" });
    }
    return entry;
  });

  const routes = (routesRaw as unknown[]).map((entry, index) => {
    const at = `routes[${String(index)}]`;
    if (!isRecord(entry)) {
      faults.push({ path: at, problem: "must be an object" });
      return undefined;
    }
    for (const field of ["code", "provider", "sellerProfileCode", "settlementModel"] as const) {
      if (!isNonEmptyString(entry[field])) {
        faults.push({ path: `${at}.${field}`, problem: "must be a non-empty string" });
      }
    }
    for (const field of ["capabilities", "currencies", "intervals"] as const) {
      const value = entry[field];
      if (!isStringArray(value) || value.length === 0) {
        faults.push({ path: `${at}.${field}`, problem: "must be a non-empty array of strings" });
      }
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      faults.push({ path: `${at}.enabled`, problem: "must be a boolean when present" });
    }
    if (entry.priority !== undefined && (typeof entry.priority !== "number" || !Number.isInteger(entry.priority))) {
      faults.push({ path: `${at}.priority`, problem: "must be an integer when present" });
    }
    return entry;
  });

  // The whole reason sellers and routes share one document: a route naming a seller nobody defined would
  // otherwise be found by the first customer who tried to pay.
  const defined = new Set(sellers.filter(isRecord).map((seller) => seller.code));
  routes.filter(isRecord).forEach((route, index) => {
    if (isNonEmptyString(route.sellerProfileCode) && !defined.has(route.sellerProfileCode)) {
      faults.push({ path: `routes[${String(index)}].sellerProfileCode`, problem: "names no seller in this configuration" });
    }
  });

  if (faults.length > 0) {
    return { faults };
  }
  return { config: { sellers: sellersRaw, routes: routesRaw } as BillingRoutingConfig };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const connectionString = process.env.DATABASE_URL;
  const routing = process.env.BILLING_ROUTING;
  if (connectionString === undefined || connectionString === "") {
    console.error("DATABASE_URL is not set; this command writes to a deployment's own database.");
    return 1;
  }
  if (routing === undefined || routing.trim() === "") {
    console.error("BILLING_ROUTING is not set. Without it this deployment has no selling entity and no route, so every checkout refuses.");
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(routing);
  } catch {
    // The variable's own text is never printed: it carries provider account references.
    console.error("BILLING_ROUTING is not valid JSON.");
    return 1;
  }

  const read = readBillingRoutingConfig(parsed);
  if ("faults" in read) {
    console.error(`BILLING_ROUTING is not usable (${String(read.faults.length)} problem(s)):`);
    for (const fault of read.faults) {
      console.error(`  ${fault.path}: ${fault.problem}`);
    }
    return 1;
  }

  if (dryRun) {
    console.log(
      `Would write ${String(read.config.sellers.length)} seller(s) and ${String(read.config.routes.length)} route(s): ` +
        `${read.config.routes.map((route) => route.code).join(", ")}`,
    );
    return 0;
  }

  const db = createDbClient({ connectionString });
  try {
    const applied = await applyBillingRouting(db, read.config);
    console.log(`Sellers: ${applied.sellerCodes.join(", ")}`);
    console.log(`Routes:  ${applied.routeCodes.join(", ")}`);
    console.log(
      "A route still needs its provider credentials in STRIPE_ROUTES under the same routeCode; without them " +
        "no adapter is registered for it and it cannot be chosen.",
    );
    return 0;
  } catch (error) {
    // The store's own refusal, reported rather than thrown as a stack trace: it names the route and which
    // of the thirteen capabilities is incoherent, which is the message an operator can act on. A command
    // that printed a Node stack here would bury it.
    console.error(`BILLING_ROUTING was refused: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "Writes before the refused one have already been applied. Fix the document and run this again — both " +
        "writes are upserts, so re-running is how this is meant to be corrected.",
    );
    return 1;
  } finally {
    await db.$disconnect();
  }
}

// Guarded so the validation above can be imported by a test without the command running.
if (process.argv[1] !== undefined && process.argv[1].endsWith("publish-routes.ts")) {
  process.exit(await main());
}
