/**
 * Seller profiles, billing routes, checkout contracts and the activation path (#46, ADR-019).
 *
 * Five rules shape every function here.
 *
 * **The client never names a route, a provider account or a selling entity.** `openCheckoutContract`
 * takes a plan version, an interval, an arrangement kind and a currency — product facts the customer is
 * entitled to choose — and the route is selected from operator configuration the customer cannot write.
 * There is no parameter in which a forged identifier could arrive, which is a stronger statement than
 * validating one would be.
 *
 * **A checkout is written before the customer is sent anywhere, and never edited afterwards.** It records
 * what was offered, by which seller entity, at what price, and which terms were accepted. A trigger
 * freezes it; a deferred constraint trigger refuses to let it commit without its acceptances.
 *
 * **Only a verified provider event or an authoritative reconciliation activates anything.** The type
 * `VerifiedBillingEvent` cannot be constructed outside `billing-events.ts`, so a success-page handler has
 * no way to reach this file's activation path even by mistake.
 *
 * **One live charge path per workspace.** Enforced by a partial unique index rather than by a check here,
 * because the race it prevents — two checkouts completing at once — is exactly the one an application
 * check loses. A provider switch ends the old arrangement and opens the new one in one transaction.
 *
 * **No expected exception is caught inside a transaction.** In PostgreSQL a failed statement aborts the
 * whole transaction, so where a conflict is a normal outcome — a redelivered webhook — this serializes on
 * a transaction-scoped advisory lock and reads before writing. The unique index stays as the backstop for
 * anything that does not come through here.
 */
import { createHash } from "node:crypto";

import {
  acceptedInOwnLanguage,
  canonicalLanguageTag,
  entitlementEffectOf,
  isBillingCapability,
  isChargeInterval,
  isCurrencyCode,
  LEGAL_DOCUMENT_KINDS,
  missingAcceptances,
  negotiateDocumentLocale,
  money,
  periodEndFor,
  selectRoute,
  settlementModelCoherent,
  taxRemittedBy,
  type ArrangementKind,
  type BillingCapability,
  type BillingRouteTerms,
  type ChargeInterval,
  type EntitlementEffect,
  type LegalDocumentKind,
  type Money,
  type PaymentQuote,
  type QuoteVerdict,
  type RouteRefusal,
  type SettlementModel,
} from "@omnichannel/domain";

import { recordSystemAuditEvent, recordWorkspaceAuditEvent } from "./audit-store";
import type { DbClient, DbExecutor } from "./client";
import { billingProviderRegistered, snapshotVerifiedBillingEvent, type VerifiedBillingEvent } from "./billing-events";
import { DbInputError } from "./errors";
import { requireRole, scopeOf, type WorkspaceContext } from "./tenancy";

/** Commercial changes are the owner's, not an admin's. The spec is explicit and so is every other file. */
const BILLING_ROLES = ["OWNER"] as const;

/**
 * How long an unfinished checkout holds the workspace's single live charge path.
 *
 * A quote has its own expiry and is respected first; this is the backstop for a checkout nobody came back
 * to. Long enough that a customer who went to find their card is not locked out, short enough that an
 * abandoned attempt does not block a purchase until somebody notices.
 */
export const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------
// Operator configuration: ours, not a tenant's
// ---------------------------------------------------------------------------------------------------------

export interface SellerProfileInput {
  readonly code: string;
  readonly legalName: string;
  readonly displayName: string;
  /** ISO 3166-1 alpha-2 of the entity's registration. */
  readonly jurisdiction: string;
  readonly supportEmail: string;
  /** Opaque pointer into infrastructure configuration. Never a secret. */
  readonly legalConfigRef?: string;
  readonly retiredAt?: Date | null;
}

export interface SellerProfileRecord {
  readonly sellerProfileId: string;
  readonly code: string;
}

/**
 * Creates or updates a selling entity.
 *
 * Mutable, unlike a plan version, and deliberately: a company changes its registered address and its
 * support address, and a new row for each would multiply the entity a customer bought from. What must not
 * move with it is history, which is why `checkout_contracts` copies the legal name and jurisdiction in
 * rather than reading them through the foreign key.
 *
 * Takes no workspace context. A selling entity is ours; no tenant has one, and giving this a context
 * would imply a tenant could.
 */
export async function upsertSellerProfile(db: DbClient, input: SellerProfileInput): Promise<SellerProfileRecord> {
  const data = {
    legalName: input.legalName,
    displayName: input.displayName,
    jurisdiction: input.jurisdiction,
    supportEmail: input.supportEmail,
    legalConfigRef: input.legalConfigRef ?? null,
    retiredAt: input.retiredAt ?? null,
  };
  const row = await db.sellerProfile.upsert({
    where: { code: input.code },
    create: { code: input.code, ...data },
    update: data,
    select: { id: true, code: true },
  });
  return { sellerProfileId: row.id, code: row.code };
}

/**
 * A deployment's whole selling configuration: who sells, and through which provider accounts.
 *
 * One document rather than two lists so a route cannot name a seller the same configuration does not
 * define — a route pointing at a missing seller is a refusal at the first charge, discovered by the first
 * customer rather than by whoever wrote the configuration.
 */
export interface BillingRoutingConfig {
  readonly sellers: readonly SellerProfileInput[];
  readonly routes: readonly BillingRouteInput[];
}

export interface BillingRoutingApplied {
  readonly sellerCodes: readonly string[];
  readonly routeCodes: readonly string[];
}

/**
 * Applies a deployment's selling configuration, sellers first.
 *
 * The producer `BILLING_ROUTING.md` asks for: routes come "from operator configuration", and before this
 * existed nothing wrote one — so `selectRoute` answered `NO_ROUTE` for every checkout and
 * `recordVerifiedBillingEvent` answered `UNKNOWN_ROUTE` for every webhook, in any deployment that had not
 * been seeded by a test.
 *
 * Takes a configuration object, never the environment: a core package that read `process.env` would make
 * every caller's configuration invisible to the type system, and `packages/env`'s own note says apps
 * validate once at startup and pass typed configuration inward. The parsing lives in the command.
 *
 * Sellers before routes because `upsertBillingRoute` resolves its seller by code and refuses an unknown
 * one. Both are upserts, so this is safe to re-run — a deployment that changes a support address or adds a
 * currency to a route runs it again, which is the difference between this and publishing a catalogue
 * version.
 *
 * Not transactional across the whole document, deliberately: each upsert is one coherent row, and a
 * partial application leaves routes that work rather than none. A route that failed its own coherence
 * check throws with the capability it got wrong, which is more use than rolling back the four that were
 * right.
 */
export async function applyBillingRouting(db: DbClient, config: BillingRoutingConfig): Promise<BillingRoutingApplied> {
  const sellerCodes: string[] = [];
  for (const seller of config.sellers) {
    const record = await upsertSellerProfile(db, seller);
    sellerCodes.push(record.code);
  }
  const routeCodes: string[] = [];
  for (const route of config.routes) {
    const record = await upsertBillingRoute(db, route);
    routeCodes.push(record.code);
  }
  return { sellerCodes, routeCodes };
}

export interface BillingRouteInput {
  readonly code: string;
  /** Which adapter owns this route. Free text; an enum of provider names is the leak ADR-017 forbids. */
  readonly provider: string;
  /** The provider's own account/configuration object. Opaque. */
  readonly providerAccountRef?: string;
  readonly sellerProfileCode: string;
  readonly settlementModel: SettlementModel;
  readonly capabilities: readonly BillingCapability[];
  readonly currencies: readonly string[];
  readonly intervals: readonly ChargeInterval[];
  readonly markets?: readonly string[];
  readonly enabled?: boolean;
  readonly priority?: number;
}

export interface BillingRouteRecord {
  readonly billingRouteId: string;
  readonly code: string;
}

/**
 * Creates or updates a route.
 *
 * Coherence is checked here as well as by the CHECK on the table. The constraint is what makes an
 * incoherent row impossible; this is what tells the operator which of the thirteen capabilities they got
 * wrong, which a constraint violation does not.
 */
export async function upsertBillingRoute(db: DbClient, input: BillingRouteInput): Promise<BillingRouteRecord> {
  const terms: BillingRouteTerms = {
    routeId: "",
    code: input.code,
    settlementModel: input.settlementModel,
    capabilities: input.capabilities,
    currencies: input.currencies,
    intervals: input.intervals,
    markets: input.markets ?? [],
    enabled: input.enabled ?? false,
    priority: input.priority ?? 0,
  };
  const faults = settlementModelCoherent(terms);
  if (faults.length > 0) {
    throw new DbInputError("capabilities", `route ${input.code} is incoherent: ${faults.join(", ")}`);
  }
  const unknown = input.currencies.filter((currency) => !isCurrencyCode(currency));
  if (unknown.length > 0) {
    throw new DbInputError("currencies", `not currency or payment-asset codes: ${unknown.join(", ")}`);
  }

  const seller = await db.sellerProfile.findUnique({ where: { code: input.sellerProfileCode }, select: { id: true } });
  if (seller === null) {
    throw new DbInputError("sellerProfileCode", `no seller profile with code ${input.sellerProfileCode}`);
  }
  const data = {
    provider: input.provider,
    providerAccountRef: input.providerAccountRef ?? null,
    sellerProfileId: seller.id,
    settlementModel: input.settlementModel,
    capabilities: [...input.capabilities],
    currencies: [...input.currencies],
    intervals: [...input.intervals],
    markets: [...(input.markets ?? [])],
    enabled: input.enabled ?? false,
    priority: input.priority ?? 0,
  };
  const row = await db.billingRoute.upsert({
    where: { code: input.code },
    create: { code: input.code, ...data },
    update: data,
    select: { id: true, code: true },
  });
  return { billingRouteId: row.id, code: row.code };
}

/**
 * The operator's routes, as the domain sees them.
 *
 * Capabilities and intervals are filtered through the domain's own guards rather than cast. A row written
 * before a capability was renamed would otherwise arrive as a string the product cannot interpret and
 * would be silently treated as present.
 */
export async function readBillingRoutes(db: DbExecutor, options: { readonly enabledOnly?: boolean } = {}): Promise<readonly BillingRouteTerms[]> {
  const rows = await db.billingRoute.findMany({
    ...(options.enabledOnly === true ? { where: { enabled: true } } : {}),
    orderBy: [{ priority: "asc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      settlementModel: true,
      capabilities: true,
      currencies: true,
      intervals: true,
      markets: true,
      enabled: true,
      priority: true,
    },
  });
  return rows.map(termsOf);
}

function termsOf(row: {
  readonly id: string;
  readonly code: string;
  readonly settlementModel: SettlementModel;
  readonly capabilities: readonly string[];
  readonly currencies: readonly string[];
  readonly intervals: readonly string[];
  readonly markets: readonly string[];
  readonly enabled: boolean;
  readonly priority: number;
}): BillingRouteTerms {
  return {
    routeId: row.id,
    code: row.code,
    settlementModel: row.settlementModel,
    capabilities: row.capabilities.filter(isBillingCapability),
    currencies: [...row.currencies],
    intervals: row.intervals.filter(isChargeInterval),
    markets: [...row.markets],
    enabled: row.enabled,
    priority: row.priority,
  };
}

export interface LegalDocumentInput {
  readonly kind: LegalDocumentKind;
  readonly locale: string;
  /**
   * Where the published text lives: an absolute `https` URL (#47).
   *
   * Opaque in the sense that matters — nothing parses it, nothing branches on it, and the text is not
   * stored here — but not opaque in form. A checkout renders it as the link somebody reads *before* they
   * tick the box, so a value that is not a URL is a checkbox asking for consent to something unreadable,
   * which is precisely what this issue exists to prevent. Checked here and again by a CHECK.
   */
  readonly contentRef: string;
  /** Set for a document belonging to one selling entity; absent applies to every seller profile. */
  readonly sellerProfileCode?: string;
  readonly requiredForCheckout?: boolean;
  readonly effectiveFrom: Date;
}

export interface LegalDocumentRecord {
  readonly legalDocumentId: string;
  readonly kind: LegalDocumentKind;
  readonly version: number;
}

/**
 * Publishes the next version of a legal document.
 *
 * The version is assigned here rather than passed in, for the reason every other versioned table in this
 * codebase assigns its own: two publishers choosing a number is a race, and the row somebody accepted
 * has to have a number nobody else used.
 */
export async function publishLegalDocument(db: DbClient, input: LegalDocumentInput): Promise<LegalDocumentRecord> {
  if (!isReadableDocumentUrl(input.contentRef)) {
    throw new DbInputError("contentRef", "a legal document is published at an absolute https URL somebody can open");
  }
  // Canonicalized once, here, and stored that way — because every other part of this file identifies a
  // document by its locale and they have to mean the same thing by it.
  //
  // Astra's P2 on #101: publishing kept `input.locale` verbatim and allocated versions by that raw
  // string, while `negotiateDocumentLocale` canonicalizes before matching. So `en-US` and `en-us` each
  // became v1 of the same kind, both current, neither superseding the other, and which spelling a reader
  // was offered came down to row order rather than to `effectiveFrom` or `version`. Two aliases of one
  // language tag are one identity, and the only place that can be settled is where the row is written.
  const locale = canonicalLanguageTag(input.locale);
  if (locale === undefined || locale === null) {
    throw new DbInputError("locale", "a legal document is published in a well-formed BCP-47 language tag");
  }
  return db.$transaction(async (tx) => {
    const seller =
      input.sellerProfileCode === undefined
        ? null
        : await tx.sellerProfile.findUnique({ where: { code: input.sellerProfileCode }, select: { id: true } });
    if (input.sellerProfileCode !== undefined && seller === null) {
      throw new DbInputError("sellerProfileCode", `no seller profile with code ${input.sellerProfileCode}`);
    }
    // One lock for the whole catalogue rather than one per kind and locale. It serializes version
    // assignment, as before, and it also orders a publication against a checkout — which is the race
    // that matters: a version becoming effective between the store resolving the current documents and
    // the acceptance rows being written makes the applicability trigger refuse, one layer below where
    // anything could turn it into a sentence. Both are rare owner-or-operator acts, so serializing them
    // against each other costs nothing.
    await serialize(tx, LEGAL_CATALOGUE_LOCK);
    // Versions are allocated per *canonical* locale, and existing rows are matched the same way rather
    // than by string equality — so a catalogue that already holds a non-canonical spelling still gets one
    // sequence instead of two. The comparison is in TypeScript because the canonical form of a language
    // tag is not something SQL can compute: no SQL expression knows that `iw` and `he` are one language.
    // What the database does enforce is the part it can decide — `current_legal_documents()` groups by the
    // locale case-folded and separator-folded, so two spellings of one language cannot both be current
    // even for a row that never came through this function.
    const published = await tx.legalDocument.findMany({ where: { kind: input.kind }, select: { locale: true, version: true } });
    const sameLanguage = published.filter((row) => canonicalLanguageTag(row.locale) === locale);
    const version = Math.max(0, ...sameLanguage.map((row) => row.version)) + 1;
    const row = await tx.legalDocument.create({
      data: {
        kind: input.kind,
        locale,
        version,
        contentRef: input.contentRef,
        effectiveFrom: input.effectiveFrom,
        ...(seller === null ? {} : { sellerProfileId: seller.id }),
        ...(input.requiredForCheckout === undefined ? {} : { requiredForCheckout: input.requiredForCheckout }),
      },
      select: { id: true },
    });
    return { legalDocumentId: row.id, kind: input.kind, version };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------------------------------------

/**
 * Whether a published location is one a reader could actually open.
 *
 * `https` only, and absolute. A relative path would resolve against whatever page rendered it — the
 * fixtures in #46 were path fragments, so a link to `terms/en/1` from the checkout route would have
 * pointed at a page that does not exist — and `http` would hand somebody a contract over a channel that
 * can be rewritten in transit.
 */
export function isReadableDocumentUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export interface CheckoutRequest {
  readonly planVersionId: string;
  readonly interval: ChargeInterval;
  readonly arrangement: ArrangementKind;
  /**
   * The catalogue currency to be priced in. Required: a hidden default would decide a price for somebody.
   *
   * Not the settlement asset. A crypto route takes an EUR-priced charge and quotes it in an asset, and the
   * asset arrives on `quote` — so a plan keeps one price book however many providers can take money for it.
   */
  readonly currency: string;
  /** ISO 3166-1 alpha-2, where the product knows it. */
  readonly market?: string;
  /**
   * The reader's own interface language, as a BCP-47 tag (#47).
   *
   * What the documents are *offered* in is negotiated from it rather than equal to it: a product that has
   * not translated its offer shows the fallback language, and the acceptance records both facts. Filtering
   * documents by an exact match — which is what this did before #47 — offered a reader with no translation
   * no documents at all, and a checkout screen with nothing to tick is not a stricter checkout.
   */
  readonly locale: string;
  /**
   * Ends the workspace's current charge path and binds the new one to it as its successor.
   *
   * `false` by default, and that default *is* the rule "never create a second active charge path
   * silently": a caller that has not said it is migrating gets a refusal rather than a second provider.
   * It belongs on the request rather than only on the write, so the screen that offers a migration can
   * be priced without first being told it already has an arrangement.
   */
  readonly supersedeCurrent?: boolean;
}

/** One legal document a checkout is made under: ticked when required, linked when not (#47). */
export interface LegalDocumentOffer {
  readonly legalDocumentId: string;
  readonly kind: LegalDocumentKind;
  readonly version: number;
  /** The locale this version is published in, which is not always the one that was asked for. */
  readonly locale: string;
  readonly contentRef: string;
  /**
   * Whether a checkout may not proceed without an explicit acceptance of this kind.
   *
   * A property of the *kind* rather than of this version, and computed as "the current document of this
   * kind in any applicable locale requires it". The database's coverage trigger reads it the same way,
   * and it has to: a rule that differed per locale would offer one reader a checkbox nobody asked for
   * and refuse another for want of one they were never shown.
   */
  readonly requiredForCheckout: boolean;
  /** Whether this version is in the reader's own language, or a fallback they may not read. */
  readonly inViewerLanguage: boolean;
  /**
   * When this version came into force.
   *
   * Shown beside the version number because the number alone is ambiguous: the sequence counts
   * publications of a kind and locale across the whole catalogue, so a selling entity's first offer can
   * be "version 2". The date is the same for every reader and is what a dispute can actually use.
   */
  readonly effectiveFrom: Date;
}

/**
 * What a checkout would be, before anybody commits to it.
 *
 * Deliberately without the provider's name, its account reference or the route's identifier. A screen
 * needs the seller it is buying from, the amount, the currency and who remits the tax; a value that
 * reaches a page can reach a view-source, and the Inbox guard in `apps/web` fails the build over exactly
 * these three field names.
 */
export interface CheckoutOffer {
  readonly available: true;
  readonly seller: {
    readonly legalName: string;
    readonly displayName: string;
    readonly jurisdiction: string;
    readonly supportEmail: string;
  };
  readonly settlementModel: SettlementModel;
  /** `PROVIDER` for a Merchant of Record; `SELLER` when the tax is ours to remit. */
  readonly taxRemittedBy: "PROVIDER" | "SELLER";
  readonly arrangement: ArrangementKind;
  readonly interval: ChargeInterval;
  readonly base: Money;
  readonly documents: readonly LegalDocumentOffer[];
  /** The locale the reader asked for, echoed so the screen and the acceptance record agree. */
  readonly viewerLocale: string;
  /**
   * Whether a checkout opened now could actually be settled (#47).
   *
   * False when the selected route's provider has no adapter registered in this process, which is the
   * state of every deployment until #41 chooses one. Reported rather than refused, because the screen
   * still has a plan, a price, a seller and the terms to show — and "we cannot take your money yet" is a
   * different sentence from "there is no plan for you".
   */
  readonly checkoutReady: boolean;
  /**
   * An opaque identity of the commercial terms this offer displayed (#47).
   *
   * The form posts it back and `openCheckoutContract` recomputes it from its own fresh resolution inside
   * the opening transaction. It exists because consent is to *terms*, and the terms are not only the plan
   * and the price: they are the selling legal entity, its jurisdiction, and whether the tax is remitted by
   * that entity or by the provider at its own hosted checkout. None of that was bound to the acceptance
   * before — the form carried the plan, the interval and the document ids, and global documents
   * legitimately apply to every seller, so a route reconfigured between the GET and the POST produced a
   * contract naming a different seller under terms nobody had been shown. Astra demonstrated it on #101.
   *
   * Opaque on purpose, and *compared* rather than trusted: the client cannot name a seller, a provider or
   * a route with it. All it can do is prove which offer it was shown, and a value that does not match what
   * the server resolves now is refused with `OFFER_CHANGED` so the person reads the new terms and accepts
   * them deliberately. A digest rather than a stored row because it needs no lifecycle: the authority is
   * always the fresh resolution, and this only answers "is that still what you saw".
   */
  readonly offerDigest: string;
}

export const CHECKOUT_REFUSALS = [
  "NO_ROUTE",
  "NO_PRICE",
  "ARRANGEMENT_EXISTS",
  "TERMS_NOT_ACCEPTED",
  "DOCUMENT_NOT_APPLICABLE",
  /**
   * A required document the reader cannot be offered in any language (#47).
   *
   * Operator misconfiguration, not a customer's circumstance: the fallback locale is the one the product
   * publishes everything in, so a required kind missing from it is a gap somebody has to fill. Refused
   * with its own reason rather than folded into `TERMS_NOT_ACCEPTED`, because "you did not tick the box"
   * and "there is no box to tick" need different people to do different things.
   */
  "DOCUMENT_UNAVAILABLE",
  /**
   * The terms changed between the page that showed the checkboxes and the submission (#47).
   *
   * Named apart from `DOCUMENT_NOT_APPLICABLE` for the reason #77's `STALE_STATE` was: the answer is
   * "read the new terms and accept them", and a refusal that could not say which kind of wrong it was
   * would send somebody looking for a fault that is not theirs.
   */
  "DOCUMENT_SUPERSEDED",
  /**
   * The commercial terms changed between the page that was accepted and the submission (#47).
   *
   * Its own reason rather than a silent re-resolution, because the thing that changed is what somebody
   * consented to: which legal entity is selling, under which jurisdiction, who remits the tax, at what
   * price. The answer is "here are the new terms, accept them if you still want to" — which is a
   * different sentence from every document refusal, and the only one that keeps the acceptance honest.
   */
  "OFFER_CHANGED",
  /**
   * No provider adapter can settle a checkout on the selected route (#47, #41).
   *
   * Refused here rather than left to the caller, because a checkout that cannot possibly settle would
   * still consume the workspace's single live charge path and leave a `PENDING` arrangement for the
   * sweeper to clean up — a purchase blocked by a purchase nobody could complete.
   */
  "PROVIDER_UNAVAILABLE",
] as const;
export type CheckoutRefusalReason = (typeof CHECKOUT_REFUSALS)[number];

export interface CheckoutRefusal {
  readonly available: false;
  readonly reason: CheckoutRefusalReason;
  /** For `NO_ROUTE`, why each configured route refused; for the rest, what is missing. */
  readonly detail: readonly string[];
}

/**
 * Prices a checkout and names the terms it would be made under.
 *
 * Read-only, so the screen can show the acceptance control, the seller and the amount before anybody
 * clicks. `openCheckoutContract` repeats the whole selection inside its transaction rather than taking
 * this result as input: a route disabled between the two would otherwise be used because a browser still
 * had the old answer.
 */
export async function readCheckoutOffer(
  db: DbClient,
  context: WorkspaceContext,
  request: CheckoutRequest,
  at = new Date(),
): Promise<CheckoutOffer | CheckoutRefusal> {
  requireRole(context, BILLING_ROLES, "open a checkout");
  const workspaceId = scopeOf(context);
  const live = request.supersedeCurrent === true ? null : await liveArrangement(db, workspaceId);
  if (live !== null) {
    return { available: false, reason: "ARRANGEMENT_EXISTS", detail: [live.id] };
  }
  const resolved = await resolveCheckout(db, request, at);
  return resolved.available ? resolved.offer : resolved.refusal;
}

interface ResolvedCheckout {
  readonly available: true;
  readonly offer: CheckoutOffer;
  readonly route: BillingRouteTerms;
  readonly sellerProfileId: string;
  readonly documents: readonly LegalDocumentOffer[];
}

async function resolveCheckout(
  db: DbExecutor,
  request: CheckoutRequest,
  at: Date,
): Promise<ResolvedCheckout | { readonly available: false; readonly refusal: CheckoutRefusal }> {
  const routes = await readBillingRoutes(db, { enabledOnly: true });
  const selection = selectRoute(routes, {
    arrangement: request.arrangement,
    interval: request.interval,
    currency: request.currency,
    ...(request.market === undefined ? {} : { market: request.market }),
  });
  if (!selection.selected) {
    return {
      available: false,
      refusal: {
        available: false,
        reason: "NO_ROUTE",
        detail: selection.refusals.map((refusal: { readonly code: string; readonly refusal: RouteRefusal }) => `${refusal.code}: ${refusal.refusal}`),
      },
    };
  }
  const route = selection.route;
  const [price, row] = await Promise.all([
    db.planPrice.findUnique({
      where: { planVersionId_currency_interval: { planVersionId: request.planVersionId, currency: request.currency, interval: request.interval } },
      select: { amountCents: true, currency: true },
    }),
    db.billingRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: {
        sellerProfileId: true,
        // The provider's name, used here and nowhere a page can see it: it decides whether an adapter
        // exists, and nothing else in this function reads it.
        provider: true,
        sellerProfile: { select: { legalName: true, displayName: true, jurisdiction: true, supportEmail: true } },
      },
    }),
  ]);
  if (price === null) {
    return {
      available: false,
      refusal: {
        available: false,
        reason: "NO_PRICE",
        detail: [`${request.planVersionId} has no ${request.currency} price at ${request.interval}`],
      },
    };
  }
  const resolvedDocuments = await readLegalDocumentOffers(db, row.sellerProfileId, request.locale, at);
  if (resolvedDocuments.unofferable.length > 0) {
    return {
      available: false,
      refusal: {
        available: false,
        reason: "DOCUMENT_UNAVAILABLE",
        detail: resolvedDocuments.unofferable.map((kind) => `${kind} is required and published in no language this reader can be offered`),
      },
    };
  }
  const documents = resolvedDocuments.documents;
  return {
    available: true,
    route,
    sellerProfileId: row.sellerProfileId,
    documents,
    offer: {
      available: true,
      seller: row.sellerProfile,
      settlementModel: route.settlementModel,
      taxRemittedBy: taxRemittedBy(route),
      arrangement: request.arrangement,
      interval: request.interval,
      base: money(price.amountCents, price.currency),
      documents,
      // Echoed in canonical form, so the screen, the form it posts and the stored acceptance all name
      // the language the same way.
      viewerLocale: canonicalLanguageTag(request.locale) ?? request.locale,
      // Whether this deployment could settle what it is about to offer. The registry is process-local, so
      // this answers for *this* process — which is the one that will hand the customer to the provider.
      checkoutReady: billingProviderRegistered(row.provider),
      offerDigest: offerDigestOf({
        seller: row.sellerProfile,
        settlementModel: route.settlementModel,
        taxRemittedBy: taxRemittedBy(route),
        arrangement: request.arrangement,
        interval: request.interval,
        base: money(price.amountCents, price.currency),
      }),
    },
  };
}

/**
 * The commercial terms of an offer, as one string.
 *
 * Every field here is something a person is shown and consents to, and nothing here is something they
 * choose: the seller and its jurisdiction, who remits the tax, the shape and length of the commitment and
 * the price. Deliberately **not** the document ids — those are bound separately and have their own
 * refusals, and `DOCUMENT_SUPERSEDED` says "read the new terms" far better than a digest mismatch could.
 * Deliberately not the route id or the provider either: the client must never hold an authoritative
 * pointer to one, and a seller changing provider without changing any disclosed term is not a change to
 * what was agreed.
 */
function offerDigestOf(terms: {
  readonly seller: { readonly legalName: string; readonly jurisdiction: string };
  readonly settlementModel: SettlementModel;
  readonly taxRemittedBy: "PROVIDER" | "SELLER";
  readonly arrangement: ArrangementKind;
  readonly interval: ChargeInterval;
  readonly base: Money;
}): string {
  return createHash("sha256")
    .update(
      [
        terms.seller.legalName,
        terms.seller.jurisdiction,
        terms.settlementModel,
        terms.taxRemittedBy,
        terms.arrangement,
        terms.interval,
        String(terms.base.amountMinor),
        terms.base.currency,
      ].join("\u0000"),
    )
    .digest("hex");
}

/**
 * The locale a product publishes everything in.
 *
 * `apps/web` has its own `FALLBACK_LOCALE` and they are the same letters, deliberately not the same
 * constant: this one is about what the *legal documents* are guaranteed to exist in, and the web app's is
 * about what its message catalogue falls back to. A deployment that translated its interface into a
 * language it has no offer in would otherwise look like it had changed this.
 */
export const LEGAL_FALLBACK_LOCALE = "en";

/** Orders publishing a legal document against opening a checkout. See `publishLegalDocument`. */
const LEGAL_CATALOGUE_LOCK = "legal-document:catalogue";

interface ResolvedDocuments {
  /** One per kind: the current version, in the best locale available for that kind. */
  readonly documents: readonly LegalDocumentOffer[];
  /** Required kinds that exist in no locale this reader could be offered. Operator misconfiguration. */
  readonly unofferable: readonly LegalDocumentKind[];
}

/**
 * The current version of every legal document applicable to a selling entity, in the best locale for one
 * reader (#46, #47).
 *
 * Three rules, and all three are also written in SQL in `current_legal_documents()`. The duplication is
 * deliberate and the integration suite holds the two against each other, because the store decides what a
 * person is *shown* while the triggers decide what may be *written*, and a disagreement between them is
 * either a checkout that cannot commit or an acceptance of something nobody was shown.
 *
 * - **Current, not merely effective.** The newest version already in force wins; a version published for
 *   next month exists and is offered to nobody.
 * - **A seller-specific document displaces a global one** of the same kind and locale, however new the
 *   global one is: an entity that published its own offer has superseded the generic text for its own
 *   checkouts.
 * - **The requirement belongs to the kind**, not to the version or the locale: a kind is required when the
 *   current document of that kind in *any* applicable locale requires it. The conservative reading, and
 *   the only one under which a reader in one language and a reader in another are asked for the same
 *   consent.
 */
async function readLegalDocumentOffers(db: DbExecutor, sellerProfileId: string, viewerLocale: string, at: Date): Promise<ResolvedDocuments> {
  const rows = await db.legalDocument.findMany({
    // Every locale, not the reader's: the negotiation below needs to know what exists before it can
    // choose, and filtering by an exact locale here is precisely the bug #47 exists to fix.
    where: { effectiveFrom: { lte: at }, OR: [{ sellerProfileId }, { sellerProfileId: null }] },
    orderBy: [{ kind: "asc" }, { locale: "asc" }, { effectiveFrom: "desc" }, { version: "desc" }],
    select: { id: true, kind: true, version: true, locale: true, contentRef: true, requiredForCheckout: true, sellerProfileId: true, effectiveFrom: true },
  });

  type Row = (typeof rows)[number];

  /**
   * Which of two documents of one kind and one language is the current one.
   *
   * Computed rather than taken from the query's order on purpose. `orderBy` sorts by the stored locale
   * before the date, so once two spellings of one language are collapsed into a single group the first
   * row of that group is whichever spelling sorts first — not the newest. A rename published as `en-GB`
   * after an `en-gb` would have lost to it, and the reader would have been offered, and the trigger would
   * have enforced, a version that had already been replaced.
   *
   * Specificity first, because a selling entity's own text displaces the platform's whatever its date;
   * then the later `effectiveFrom`; then the higher version, which is the tie-break for two documents
   * made effective at the same instant.
   */
  function supersedes(candidate: Row, chosen: Row): boolean {
    if ((candidate.sellerProfileId !== null) !== (chosen.sellerProfileId !== null)) {
      return candidate.sellerProfileId !== null;
    }
    if (candidate.effectiveFrom.getTime() !== chosen.effectiveFrom.getTime()) {
      return candidate.effectiveFrom.getTime() > chosen.effectiveFrom.getTime();
    }
    return candidate.version > chosen.version;
  }

  // The current document per (kind, canonical language), with the seller-specific precedence applied.
  const current = new Map<string, Row>();
  for (const row of rows) {
    // Grouped by the *canonical* language, not by the stored spelling. `publishLegalDocument`
    // canonicalizes on the way in and `current_legal_documents()` groups the same way in SQL, but a row
    // written before that — or by hand — can still spell one language two ways, and a group per spelling
    // would offer a reader two current versions of one document and let an acceptance of either satisfy
    // the checkout. One language, one group, whatever it is spelled like.
    const key = `${row.kind}\u0000${canonicalLanguageTag(row.locale) ?? row.locale}`;
    const chosen = current.get(key);
    if (chosen === undefined || supersedes(row, chosen)) {
      current.set(key, row);
    }
  }

  const byKind = new Map<LegalDocumentKind, Row[]>();
  for (const row of current.values()) {
    const existing = byKind.get(row.kind);
    if (existing === undefined) {
      byKind.set(row.kind, [row]);
    } else {
      existing.push(row);
    }
  }

  const documents: LegalDocumentOffer[] = [];
  const unofferable: LegalDocumentKind[] = [];
  for (const kind of LEGAL_DOCUMENT_KINDS) {
    const all = byKind.get(kind);
    if (all === undefined || all.length === 0) {
      continue;
    }
    // Specificity dominates locale, and the order matters. Choosing the locale first would hand a
    // Russian reader the platform's generic offer whenever the selling entity had published its own only
    // in English — so the entity's own text would lose on language before it could win on being its own,
    // for a checkout whose contract names that entity's legal name and jurisdiction.
    const specific = all.filter((row) => row.sellerProfileId !== null);
    const candidates = specific.length > 0 ? specific : all;
    // Required is a property of the kind, computed across every locale of the documents actually in play.
    // `current_legal_documents` in SQL applies the same specificity filter and is read the same way by
    // the coverage trigger, so the two cannot ask a reader for different consents.
    const requiredForCheckout = candidates.some((row) => row.requiredForCheckout);
    const locale = negotiateDocumentLocale(
      viewerLocale,
      candidates.map((row) => row.locale),
      LEGAL_FALLBACK_LOCALE,
    );
    const chosen = locale === undefined ? undefined : candidates.find((row) => row.locale === locale);
    if (chosen === undefined) {
      // Published only in a language neither the reader nor the fallback covers. Required is a refusal
      // somebody has to fix; optional is simply not linked, because a link nobody can read is noise.
      if (requiredForCheckout) {
        unofferable.push(kind);
      }
      continue;
    }
    documents.push({
      legalDocumentId: chosen.id,
      kind: chosen.kind,
      version: chosen.version,
      locale: chosen.locale,
      contentRef: chosen.contentRef,
      requiredForCheckout,
      inViewerLanguage: acceptedInOwnLanguage(viewerLocale, chosen.locale),
      effectiveFrom: chosen.effectiveFrom,
    });
  }
  return { documents, unofferable };
}

export interface OpenCheckoutInput extends CheckoutRequest {
  /** The document versions the person ticked. Every required kind has to be among them. */
  readonly acceptedDocumentIds: readonly string[];
  /**
   * The document versions the page actually rendered a tick for (#47).
   *
   * Without it, a requirement that appeared *after* the page was drawn — a first refund policy, or a
   * version that starts requiring acceptance — comes back as `TERMS_NOT_ACCEPTED`: "you did not tick the
   * box" about a box that did not exist. With it, the store can tell "you left one unticked" from "the
   * terms changed while you were reading", which are different sentences with different next steps.
   *
   * Optional, because a caller with no page behind it (a script, a future API) has nothing to declare.
   * Omitting it only loses the distinction; it never weakens the enforcement, which is always computed
   * from what the store itself would offer now.
   */
  readonly offeredDocumentIds?: readonly string[];
  /**
   * The `offerDigest` of the offer the page displayed (#47).
   *
   * Optional for the same reason `offeredDocumentIds` is: a caller with no page behind it has no displayed
   * offer to declare. Omitting it loses the protection for that caller and weakens nothing for anybody
   * else — the comparison is always against what the store resolves inside the transaction.
   */
  readonly offeredDigest?: string;
  /**
   * A time-bounded charge in another currency or asset, from an adapter that quoted one.
   *
   * Absent for the ordinary case, where the charge is the catalogue price in the catalogue's currency.
   * The base price is never rewritten by it: a plan does not change meaning because an asset moved.
   */
  readonly quote?: { readonly charge: Money; readonly expiresAt: Date };
  readonly at?: Date;
}

export interface OpenedCheckout {
  readonly available: true;
  readonly checkoutContractId: string;
  readonly arrangementId: string;
  readonly base: Money;
  readonly charge: Money;
  readonly quoteExpiresAt?: Date;
  readonly seller: CheckoutOffer["seller"];
  readonly settlementModel: SettlementModel;
  /** The arrangement this checkout replaces, when it was opened as a migration. */
  readonly supersededArrangementId?: string;
}

/**
 * Writes the checkout contract, its acceptance snapshot and the charge path it opens.
 *
 * One transaction, and the order inside it is forced by the constraints rather than chosen: the contract
 * first, because the acceptances reference it; the acceptances next; and the deferred constraint trigger
 * checks at commit that every required document kind has one. A contract written by anything other than
 * this function — a support script, a later convenience helper — still cannot commit without them.
 *
 * The arrangement is created `PENDING` here rather than at settlement, so that the single-live-path index
 * also refuses a second concurrent checkout. It activates only on a verified event.
 */
export async function openCheckoutContract(db: DbClient, context: WorkspaceContext, input: OpenCheckoutInput): Promise<OpenedCheckout | CheckoutRefusal> {
  requireRole(context, BILLING_ROLES, "open a checkout");
  const workspaceId = scopeOf(context);
  const at = input.at ?? new Date();
  // Canonicalized once, here, at the boundary. `RU-ru`, `ru_RU` and `ru-RU` are one language, and the
  // column exists to be grouped by in a dispute — several spellings of one language in it would make
  // that query quietly wrong. An untaggable value is refused rather than stored.
  const locale = canonicalLanguageTag(input.locale);
  if (locale === null || locale === undefined) {
    throw new DbInputError("locale", `not a language tag: ${input.locale}`);
  }

  try {
    return await write(db, context, { ...input, locale }, workspaceId, at);
  } catch (error) {
    // The triggers are the backstop, and a backstop whose message reaches a page is not one. The lock
    // below makes the race they catch very unlikely rather than impossible — `effective_from` is
    // caller-supplied and may be backdated — so a raised exception is translated into the same refusal
    // the store would have produced itself, instead of a Postgres sentence in the middle of a checkout.
    const message = error instanceof Error ? error.message : "";
    if (/is superseded/u.test(message)) {
      return { available: false, reason: "DOCUMENT_SUPERSEDED", detail: [] };
    }
    if (/has no accepted/u.test(message)) {
      return { available: false, reason: "TERMS_NOT_ACCEPTED", detail: [] };
    }
    throw error;
  }
}

async function write(
  db: DbClient,
  context: WorkspaceContext,
  input: OpenCheckoutInput,
  workspaceId: string,
  at: Date,
): Promise<OpenedCheckout | CheckoutRefusal> {
  return db.$transaction(async (tx) => {
    // Two locks, both before anything is read. The workspace key orders two submissions against each
    // other, so a double click or a second tab is refused with `ARRANGEMENT_EXISTS` rather than losing a
    // race on the single-live index and escaping as a unique-violation. The catalogue key orders this
    // against `publishLegalDocument`, so the documents resolved below are still the current ones when
    // the acceptances are written.
    await serialize(tx, `checkout:workspace:${workspaceId}`);
    await serialize(tx, LEGAL_CATALOGUE_LOCK);
    const live = await liveArrangement(tx, workspaceId);
    if (live !== null && input.supersedeCurrent !== true) {
      return { available: false, reason: "ARRANGEMENT_EXISTS", detail: [live.id] } satisfies CheckoutRefusal;
    }
    // Resolved again inside the transaction rather than taken from the page: a route disabled, a price
    // withdrawn or a new version of the terms becoming effective between the GET that drew the checkboxes
    // and this POST would otherwise be invisible, because the browser still holds the old answer.
    const resolved = await resolveCheckout(tx, input, at);
    if (!resolved.available) {
      return resolved.refusal;
    }
    // Before any document question, because this one is more fundamental: a document refusal says "read
    // the new terms of the thing you were buying", while this says "the thing you were buying is not what
    // you were shown". Compared against the resolution above, which came from operator configuration a
    // client cannot write.
    if (input.offeredDigest !== undefined && input.offeredDigest !== resolved.offer.offerDigest) {
      return {
        available: false,
        reason: "OFFER_CHANGED",
        detail: ["the seller, the tax treatment or the price changed after the terms were displayed"],
      } satisfies CheckoutRefusal;
    }
    const accepted = resolved.documents.filter((document) => input.acceptedDocumentIds.includes(document.legalDocumentId));
    const unknown = input.acceptedDocumentIds.filter((id) => !resolved.documents.some((document) => document.legalDocumentId === id));
    if (unknown.length > 0) {
      // Two different wrongs, and they need different people to do different things. A document that was
      // current when the page was drawn and is not current now is a stale tab: the answer is "the terms
      // changed, read them again". Anything else was never offered to this workspace at all.
      const named = await tx.legalDocument.findMany({
        where: { id: { in: unknown } },
        select: { id: true, kind: true, locale: true, version: true, sellerProfileId: true, effectiveFrom: true },
      });
      // Stale means "a version of something this checkout *is* offered under, which has since been
      // replaced". A document belonging to another selling entity is not a stale version of mine, and
      // telling somebody to re-read terms that were never theirs would send them to the wrong page.
      const stale = named.filter(
        (document) =>
          (document.sellerProfileId === null || document.sellerProfileId === resolved.sellerProfileId) &&
          document.effectiveFrom.getTime() <= at.getTime() &&
          resolved.documents.some((offered) => offered.kind === document.kind),
      );
      if (stale.length > 0) {
        return {
          available: false,
          reason: "DOCUMENT_SUPERSEDED",
          detail: stale.map((document) => `${document.kind} v${String(document.version)} (${document.locale})`),
        } satisfies CheckoutRefusal;
      }
      // Not applicable to this seller profile, not effective yet, or not a document at all. Refused
      // rather than ignored: recording it would be recording consent to something nobody was shown.
      return { available: false, reason: "DOCUMENT_NOT_APPLICABLE", detail: unknown } satisfies CheckoutRefusal;
    }
    const required = resolved.documents.filter((document) => document.requiredForCheckout);
    const missing = missingAcceptances(required.map((document) => document.kind), accepted.map((document) => document.kind));
    if (missing.length > 0) {
      // A box left unticked, or a box that was never there? The page says which ticks it rendered, and a
      // requirement outside that set appeared after it was drawn — so the person is told the terms
      // changed rather than blamed for a control they never saw.
      const offered = input.offeredDocumentIds;
      const appeared =
        offered === undefined ? [] : required.filter((document) => missing.includes(document.kind) && !offered.includes(document.legalDocumentId));
      if (appeared.length > 0) {
        return {
          available: false,
          reason: "DOCUMENT_SUPERSEDED",
          detail: appeared.map((document) => `${document.kind} v${String(document.version)} (${document.locale})`),
        } satisfies CheckoutRefusal;
      }
      return { available: false, reason: "TERMS_NOT_ACCEPTED", detail: [...missing] } satisfies CheckoutRefusal;
    }

    // Last of the refusals, and last on purpose. A person who left a box unticked is told that; being
    // told instead that this deployment has no payment provider would send them looking for a fault that
    // is not theirs, and would also make every test of the terms enforcement green for the wrong reason.
    // Still before anything is written: a checkout nobody could settle would take the workspace's one
    // live charge path and leave a `PENDING` arrangement for the sweeper.
    if (!resolved.offer.checkoutReady) {
      return { available: false, reason: "PROVIDER_UNAVAILABLE", detail: [resolved.route.code] } satisfies CheckoutRefusal;
    }

    const charge = input.quote?.charge ?? resolved.offer.base;
    const seller = await tx.sellerProfile.findUniqueOrThrow({
      where: { id: resolved.sellerProfileId },
      select: { legalName: true, displayName: true, jurisdiction: true, supportEmail: true },
    });

    // Ending the superseded path before the new one is created, because the single-live index would
    // otherwise refuse the insert. `ENDED` first and `SUPERSEDED` after the successor exists: the CHECK
    // requires a superseded row to name what replaced it, and the successor has no id yet.
    if (live !== null) {
      await tx.billingArrangement.update({ where: { id: live.id }, data: { state: "ENDED", endedAt: at } });
    }

    const contract = await tx.checkoutContract.create({
      data: {
        workspaceId,
        actorUserId: context.userId,
        planVersionId: input.planVersionId,
        billingRouteId: resolved.route.routeId,
        sellerProfileId: resolved.sellerProfileId,
        sellerLegalName: seller.legalName,
        sellerJurisdiction: seller.jurisdiction,
        arrangementKind: input.arrangement,
        interval: input.interval,
        baseAmountMinor: resolved.offer.base.amountMinor,
        baseCurrency: resolved.offer.base.currency,
        chargeAmountMinor: charge.amountMinor,
        chargeCurrency: charge.currency,
        ...(input.quote === undefined ? {} : { quoteExpiresAt: input.quote.expiresAt }),
        openedAt: at,
      },
      select: { id: true },
    });
    await tx.legalAcceptance.createMany({
      data: accepted.map((document) => ({
        workspaceId,
        actorUserId: context.userId,
        legalDocumentId: document.legalDocumentId,
        checkoutContractId: contract.id,
        // The reader's own language, not the document's, and canonicalized at the entry point above.
        // The two differ exactly when the product has no translation, and that is the fact a dispute
        // asks about.
        locale: input.locale,
        acceptedAt: at,
      })),
    });

    const arrangement = await tx.billingArrangement.create({
      data: {
        workspaceId,
        billingRouteId: resolved.route.routeId,
        planVersionId: input.planVersionId,
        kind: input.arrangement,
        state: "PENDING",
        interval: input.interval,
        amountMinor: charge.amountMinor,
        currency: charge.currency,
      },
      select: { id: true },
    });
    await tx.checkoutContract.update({ where: { id: contract.id }, data: { arrangementId: arrangement.id } });
    if (live !== null) {
      await tx.billingArrangement.update({ where: { id: live.id }, data: { state: "SUPERSEDED", supersededById: arrangement.id } });
    }

    await recordWorkspaceAuditEvent(tx, context, {
      kind: "CHECKOUT_OPENED",
      summary: `Checkout opened with ${seller.legalName} (${resolved.route.settlementModel})`,
      subjectType: "CheckoutContract",
      subjectId: contract.id,
      actorUserId: context.userId,
      occurredAt: at,
      // Product vocabulary and the operator's own route code. No provider name, no account reference:
      // an audit trail has to stay readable after the provider is replaced.
      detail: {
        routeCode: resolved.route.code,
        settlementModel: resolved.route.settlementModel,
        sellerJurisdiction: seller.jurisdiction,
        arrangement: input.arrangement,
        interval: input.interval,
        baseAmountMinor: resolved.offer.base.amountMinor,
        baseCurrency: resolved.offer.base.currency,
        chargeAmountMinor: charge.amountMinor,
        chargeCurrency: charge.currency,
        acceptedDocuments: accepted.map((document) => `${document.kind} v${String(document.version)} (${document.locale})`),
        viewerLocale: input.locale,
        // Whether every document the person accepted was in their own language. False is a legitimate
        // state of the world — it means the product has no translation — and is worth recording as such.
        acceptedInOwnLanguage: accepted.every((document) => document.inViewerLanguage),
        ...(live === null ? {} : { supersededArrangementId: live.id }),
      },
    });

    return {
      available: true,
      checkoutContractId: contract.id,
      arrangementId: arrangement.id,
      base: resolved.offer.base,
      charge,
      ...(input.quote === undefined ? {} : { quoteExpiresAt: input.quote.expiresAt }),
      seller,
      settlementModel: resolved.route.settlementModel,
      ...(live === null ? {} : { supersededArrangementId: live.id }),
    } satisfies OpenedCheckout;
  });
}

/**
 * The provider and account a checkout was routed to.
 *
 * The one read in this file that returns provider vocabulary, and it exists for the composition root that
 * has to create the provider's session. Takes an id rather than a context because the caller is
 * server-side infrastructure with no session — and returns nothing a page would have any use for.
 */
export async function readCheckoutRouting(
  db: DbExecutor,
  checkoutContractId: string,
): Promise<{ readonly provider: string; readonly providerAccountRef: string | null; readonly routeCode: string } | null> {
  const row = await db.checkoutContract.findUnique({
    where: { id: checkoutContractId },
    select: { billingRoute: { select: { provider: true, providerAccountRef: true, code: true } } },
  });
  return row === null ? null : { provider: row.billingRoute.provider, providerAccountRef: row.billingRoute.providerAccountRef, routeCode: row.billingRoute.code };
}

/**
 * Records the provider's own checkout session, once.
 *
 * Write-once in the trigger as well as here. A second reference would mean a second session, and an
 * entitlement later granted against one of them could not be matched to the other.
 */
export async function attachProviderCheckoutReference(db: DbClient, checkoutContractId: string, providerCheckoutRef: string): Promise<void> {
  if (providerCheckoutRef.trim() === "") {
    throw new DbInputError("providerCheckoutRef", "a provider reference is not empty");
  }
  await db.$transaction(async (tx) => {
    await serialize(tx, `checkout:${checkoutContractId}`);
    const existing = await tx.checkoutContract.findUnique({ where: { id: checkoutContractId }, select: { providerCheckoutRef: true } });
    if (existing === null) {
      throw new DbInputError("checkoutContractId", "no such checkout");
    }
    if (existing.providerCheckoutRef !== null) {
      if (existing.providerCheckoutRef === providerCheckoutRef) {
        return;
      }
      throw new DbInputError("providerCheckoutRef", "this checkout already has a provider reference");
    }
    await tx.checkoutContract.update({ where: { id: checkoutContractId }, data: { providerCheckoutRef } });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------------------

export const BILLING_EVENT_OUTCOMES = ["APPLIED", "DUPLICATE", "UNKNOWN_ROUTE", "UNATTRIBUTED"] as const;
export type BillingEventOutcome = (typeof BILLING_EVENT_OUTCOMES)[number];

export interface BillingEventResult {
  readonly outcome: BillingEventOutcome;
  readonly effect: EntitlementEffect;
  readonly quote?: QuoteVerdict;
  readonly billingEventId?: string;
}

/**
 * Applies one verified provider event to the workspace's normalized billing state.
 *
 * The first line is the whole security model, and it does two things rather than one.
 * `snapshotVerifiedBillingEvent` refuses anything `billing-events.ts` did not mint — so a success-page
 * handler cannot reach this path even by constructing an object of the right shape and casting it — and it
 * returns a private copy of the authenticated facts.
 *
 * The copy is the part that is easy to leave out, and leaving it out was a real defect: asserting answers
 * a question about one instant, and this function then awaits a route lookup, a transaction and several
 * queries. A caller that still holds the object it passed in can move a `Date` inside it while any of
 * those are pending, and every read after the await would see the new value. Re-asserting after each
 * await does not close it, because there is always another await. So nothing below reads the caller's
 * object again: `event` here *is* the snapshot.
 *
 * Idempotent by index. A redelivered webhook is read before it is written, under an advisory lock on the
 * route and event identifier, and returns `DUPLICATE` with the effect the first delivery had — so a
 * provider retrying for an hour neither double-charges nor double-extends.
 */
export async function recordVerifiedBillingEvent(db: DbClient, delivered: VerifiedBillingEvent, now = new Date()): Promise<BillingEventResult> {
  const event = snapshotVerifiedBillingEvent(delivered);

  const route = await db.billingRoute.findUnique({
    where: { code: event.routeCode },
    select: {
      id: true,
      code: true,
      settlementModel: true,
      capabilities: true,
      currencies: true,
      intervals: true,
      markets: true,
      enabled: true,
      priority: true,
    },
  });
  if (route === null) {
    return { outcome: "UNKNOWN_ROUTE", effect: "NONE" };
  }
  const terms = termsOf(route);

  return db.$transaction(async (tx) => {
    await serialize(tx, `billing-event:${route.id}:${event.providerEventId}`);
    const existing = await tx.billingEvent.findUnique({
      where: { billingRouteId_providerEventId: { billingRouteId: route.id, providerEventId: event.providerEventId } },
      select: { id: true, effect: true },
    });
    if (existing !== null) {
      return { outcome: "DUPLICATE", effect: asEffect(existing.effect), billingEventId: existing.id };
    }

    const contract =
      event.checkoutContractId === undefined
        ? null
        : await tx.checkoutContract.findFirst({
            // Scoped to the route: a contract opened on another provider is not this provider's to settle.
            where: { id: event.checkoutContractId, billingRouteId: route.id },
            select: {
              id: true,
              workspaceId: true,
              planVersionId: true,
              arrangementId: true,
              arrangementKind: true,
              interval: true,
              baseAmountMinor: true,
              baseCurrency: true,
              chargeAmountMinor: true,
              chargeCurrency: true,
              quoteExpiresAt: true,
              openedAt: true,
              state: true,
            },
          });
    const arrangementId = event.arrangementId ?? contract?.arrangementId ?? null;
    const arrangement =
      arrangementId === null
        ? null
        : await tx.billingArrangement.findFirst({
            where: { id: arrangementId, billingRouteId: route.id },
            select: {
              id: true,
              workspaceId: true,
              planVersionId: true,
              kind: true,
              state: true,
              interval: true,
              currentPeriodEnd: true,
              startedAt: true,
            },
          });
    const workspaceId = arrangement?.workspaceId ?? contract?.workspaceId ?? null;
    if (workspaceId === null) {
      // An event about nothing this product can name. Recorded, because the provider's event identifier
      // has to be remembered or a redelivery would be processed afresh, and left without effect.
      const row = await writeEvent(tx, { event, routeId: route.id, workspaceId: null, contractId: null, arrangementId: null, effect: "NONE", now });
      return { outcome: "UNATTRIBUTED", effect: "NONE", billingEventId: row.id };
    }

    // The quote is judged whenever the contract puts a clock on the charge or the event reports an
    // amount. Without either there is nothing to check and the verified event's own claim stands: a
    // provider that reports "paid" and no amount is reporting its vocabulary, not hiding a shortfall.
    const quote: PaymentQuote | undefined =
      contract === null || (contract.quoteExpiresAt === null && event.settled === undefined)
        ? undefined
        : {
            base: money(contract.baseAmountMinor, contract.baseCurrency),
            charge: money(contract.chargeAmountMinor, contract.chargeCurrency),
            quotedAt: contract.openedAt,
            ...(contract.quoteExpiresAt === null ? {} : { expiresAt: contract.quoteExpiresAt }),
          };
    const decision = entitlementEffectOf({
      kind: event.kind,
      route: terms,
      ...(quote === undefined ? {} : { quote }),
      ...(event.settled === undefined ? {} : { settled: { amount: event.settled, at: event.settledAt ?? event.occurredAt } }),
      at: now,
    });

    const applied = await apply(tx, {
      effect: decision.effect,
      kind: event.kind,
      event,
      workspaceId,
      contract,
      arrangement,
      quoteVerdict: decision.quote,
      now,
    });

    // Read back the term the grant actually put in force — `apply` has already written it in this
    // transaction — so the event row records the relationship rather than leaving it to be inferred.
    const grantedTerm =
      (applied === "ACTIVATE" || applied === "EXTEND") && arrangement !== null
        ? (await tx.billingArrangement.findUnique({ where: { id: arrangement.id }, select: { currentPeriodEnd: true } }))?.currentPeriodEnd ?? null
        : null;

    const row = await writeEvent(tx, {
      event,
      routeId: route.id,
      workspaceId,
      contractId: contract?.id ?? null,
      arrangementId: arrangement?.id ?? null,
      effect: applied,
      now,
      ...(decision.quote === undefined ? {} : { quote: decision.quote }),
      ...(grantedTerm === null ? {} : { appliedTermEndsAt: grantedTerm }),
    });
    await recordSystemAuditEvent(
      tx,
      { workspaceId },
      {
        kind: "BILLING_ARRANGEMENT_CHANGED",
        summary: `${event.kind} on route ${route.code}: ${applied}`,
        subjectType: "BillingArrangement",
        subjectId: arrangement?.id ?? contract?.id ?? route.code,
        occurredAt: event.occurredAt,
        detail: {
          routeCode: route.code,
          settlementModel: route.settlementModel,
          kind: event.kind,
          effect: applied,
          activationSource: event.activationSource,
          ...(decision.quote === undefined ? {} : { quote: decision.quote }),
        },
      },
    );
    return { outcome: "APPLIED", effect: applied, ...(decision.quote === undefined ? {} : { quote: decision.quote }), billingEventId: row.id };
  });
}

type ContractRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly planVersionId: string;
  readonly arrangementId: string | null;
  readonly arrangementKind: ArrangementKind;
  readonly interval: string;
  readonly quoteExpiresAt: Date | null;
  readonly state: string;
} | null;

type ArrangementRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly planVersionId: string;
  readonly kind: ArrangementKind;
  readonly state: string;
  readonly interval: string;
  readonly currentPeriodEnd: Date | null;
  readonly startedAt: Date | null;
} | null;

/** The later of two optional instants, or whichever one exists. Null only when neither does. */
function laterOf(left: Date | null, right: Date | null): Date | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left.getTime() >= right.getTime() ? left : right;
}

/**
 * Writes what the effect means, and reports what it actually did.
 *
 * The return value can be narrower than the decision. An `EXTEND` for an arrangement that was never
 * activated is a reordering — the renewal arrived before the first settlement — and extending a path that
 * is not paying for anything would grant a term nobody bought, so it becomes `NONE` and the provider's
 * retry or the reconciliation sweep brings the pair back in order.
 */
async function apply(
  tx: DbExecutor,
  input: {
    readonly effect: EntitlementEffect;
    readonly kind: VerifiedBillingEvent["kind"];
    readonly event: VerifiedBillingEvent;
    readonly workspaceId: string;
    readonly contract: ContractRow;
    readonly arrangement: ArrangementRow;
    readonly quoteVerdict?: QuoteVerdict;
    readonly now: Date;
  },
): Promise<EntitlementEffect> {
  const { arrangement, contract, event, now, workspaceId } = input;

  if (input.effect === "NONE") {
    // A quote that expired with nothing settled closes the checkout; an underpayment or an ambiguous
    // settlement leaves it open, because the money is the customer's and a person has to decide between
    // a top-up and a refund.
    if (contract !== null && contract.state === "OPEN" && input.quoteVerdict === "EXPIRED") {
      await tx.checkoutContract.update({ where: { id: contract.id }, data: { state: "EXPIRED" } });
      await tx.billingArrangement.updateMany({
        where: { id: contract.arrangementId ?? "", state: "PENDING" },
        data: { state: "ENDED", endedAt: now },
      });
    }
    return "NONE";
  }

  if (input.effect === "ACTIVATE") {
    if (arrangement === null || contract === null) {
      return "NONE";
    }
    if (arrangement.state === "ENDED" || arrangement.state === "SUPERSEDED") {
      // A settlement for a path that was already ended — a migration completed first, or the checkout
      // expired. Recorded, never resurrected: reviving it would put the workspace back on a provider it
      // had been moved off.
      return "NONE";
    }
    const interval = chargeIntervalOf(arrangement.interval);
    const periodEndsAt = event.periodEndsAt ?? periodEndFor(interval, now);
    await tx.billingArrangement.update({
      where: { id: arrangement.id },
      data: {
        state: "ACTIVE",
        startedAt: arrangement.startedAt ?? now,
        currentPeriodEnd: periodEndsAt,
        ...(event.providerReference === undefined ? {} : { providerReference: event.providerReference }),
      },
    });
    await tx.checkoutContract.update({ where: { id: contract.id }, data: { state: "SETTLED" } });
    await setSubscription(tx, workspaceId, { planVersionId: arrangement.planVersionId, state: "ACTIVE", periodEndsAt });
    return "ACTIVATE";
  }

  if (input.effect === "EXTEND") {
    if (arrangement === null || arrangement.state !== "ACTIVE") {
      return "NONE";
    }
    // The same rule `ACTIVATE` applies to an ended arrangement, applied to a settled subscription:
    // recorded, never resurrected.
    //
    // A renewal must not undo a cancellation. `CANCELED_PENDING_END` is the customer's own decision and
    // `INACTIVE` is that decision carried out, and the only way back from the first is
    // `resumeSubscription` — which checks a billing role, refuses once the paid period has passed, and
    // writes "Cancellation withdrawn" to the audit trail. A webhook writing `ACTIVE` here bypasses all
    // three, so a customer who cancelled would be charged by the provider and then shown an active
    // subscription again, with nothing in the audit trail to say who revived it. There is no way back
    // from `INACTIVE` at all, so reviving one would hand back paid access that was never bought.
    //
    // The arrangement is deliberately left alone too. Moving its period end would leave a row that reads
    // like a live renewal under a subscription that is ending — provider state and application state are
    // never summed. The event is still written with `effect: NONE` and audited, which is what makes the
    // divergence visible; resolving it is `reconcileProviderState`'s job.
    const settled = await tx.workspaceSubscription.findUnique({ where: { workspaceId }, select: { state: true, periodEndsAt: true } });
    if (settled !== null && (settled.state === "CANCELED_PENDING_END" || settled.state === "INACTIVE")) {
      return "NONE";
    }
    // A renewal may only move the paid term forward.
    //
    // Providers redeliver, and they redeliver out of order: a renewal raised for February can arrive after
    // the one raised for March, with its own event id, so idempotency on the id does not help. Writing the
    // stated end unconditionally therefore *removes* access the workspace has already bought — the
    // subscription's `periodEndsAt` goes backwards and `paidWorkAllowed` starts refusing work inside a term
    // somebody paid for. The maximum below used to guard only the computed fallback, which is the case a
    // provider that states its own period never reaches.
    //
    // So the term is compared against what is already paid for, taking both rows into account because
    // either can be ahead: the arrangement carries the provider's view and the subscription carries the
    // entitlement's. A renewal that does not extend past that is a reordering or a redelivery; it is
    // recorded and audited with `effect: NONE` and changes nothing, which is the same answer this branch
    // already gives a renewal for a cancelled subscription.
    const interval = chargeIntervalOf(arrangement.interval);
    const paidThrough = laterOf(arrangement.currentPeriodEnd, settled?.periodEndsAt ?? null);
    const from = paidThrough !== null && paidThrough.getTime() > now.getTime() ? paidThrough : now;
    const periodEndsAt = event.periodEndsAt ?? periodEndFor(interval, from);
    if (paidThrough !== null && periodEndsAt.getTime() <= paidThrough.getTime()) {
      return "NONE";
    }
    // The comparison above is not enough on its own, and finding that out is what the racing case in
    // `billing-routing.integration.test.ts` is for. Two renewals with different event ids are two
    // transactions: both read the same `paidThrough`, both decide they extend it, and the one that commits
    // *second* wins — so a renewal buying less time can still overwrite one buying more. Idempotency keys
    // on the provider's event id, which is precisely what differs here.
    //
    // So the write carries the comparison instead of trusting the read. Under READ COMMITTED the second
    // transaction blocks on the row and then re-evaluates the predicate against the committed value, which
    // is the same reason `billing_arrangements_one_live_key` is an index rather than a check in this file:
    // a decision an application makes before a write is a decision another writer can invalidate.
    const advanced = await extendSubscription(tx, workspaceId, { planVersionId: arrangement.planVersionId, periodEndsAt });
    if (!advanced) {
      return "NONE";
    }
    await tx.billingArrangement.updateMany({
      where: { id: arrangement.id, OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lt: periodEndsAt } }] },
      data: { currentPeriodEnd: periodEndsAt },
    });
    return "EXTEND";
  }

  if (input.effect === "SUSPEND") {
    // Grace, not deletion. The spec is explicit that a commercial limit never removes customer data, and
    // grace's length is product policy rather than a provider's retry schedule.
    //
    // The guard is the rule `ACTIVATE` and `END` already state, and the one this branch was missing: a
    // failed charge is only this workspace's problem if it concerns the path the workspace is actually
    // paying on. A superseded or ended arrangement belongs to a provider the workspace has been moved
    // off, and an identifier the event's route does not own resolves to nothing at all — while the
    // workspace id still arrives from the contract, which was enough to write `GRACE`. Either way the
    // live path is paying, so suspending it would take away access that was bought. The old provider
    // retrying a subscription it should no longer have is the ordinary case, not an exotic one.
    //
    // Recorded with `NONE` and audited rather than silently dropped: that row is what makes a provider
    // still charging a dead path visible, and resolving it is `reconcileProviderState`'s job.
    if (arrangement === null || arrangement.state === "ENDED" || arrangement.state === "SUPERSEDED") {
      return "NONE";
    }
    const existing = await tx.workspaceSubscription.findUnique({ where: { workspaceId }, select: { state: true, graceStartedAt: true } });
    if (existing === null) {
      return "NONE";
    }
    await tx.workspaceSubscription.update({
      where: { workspaceId },
      data: { state: "GRACE", graceStartedAt: existing.graceStartedAt ?? now },
    });
    return "SUSPEND";
  }

  // END: a cancellation, a refund or a chargeback.
  if (arrangement === null) {
    return "NONE";
  }
  if (arrangement.state === "ENDED" || arrangement.state === "SUPERSEDED") {
    return "NONE";
  }
  const existing = await tx.workspaceSubscription.findUnique({ where: { workspaceId }, select: { periodEndsAt: true } });
  const paidThrough = laterOf(arrangement.currentPeriodEnd, existing?.periodEndsAt ?? null);

  // A reversal revokes the term it paid for — not whichever term happens to be current.
  //
  // Providers send reversals late, and a refund or chargeback for an old invoice can arrive months after a
  // newer term on the *same* arrangement was bought and paid for. The previous shape of this branch asked
  // only whether the arrangement was still live and then wrote `INACTIVE`, so a February chargeback took
  // away access somebody had paid for through April. Nothing correlated the money being taken back with
  // the term that was granting service.
  //
  // The event's own `periodEndsAt` is the provider's statement of which term it concerns, and it is
  // retained on every event row that states one (see `writeEvent`), so the audit trail can answer this
  // afterwards too. When the reversal names a term that ends before what is already paid for, it is
  // historical. When it names no term at all it is ambiguous, and an ambiguous reversal is not grounds to
  // delete access that a separate payment bought.
  //
  // Both cases leave every row alone and record `effect: NONE`, which is this file's existing answer for a
  // divergence it will not resolve by guessing: `reconcileProviderState` reads the provider and settles
  // it. The alternative — revoking on a maybe — bills the customer for a month they then cannot use.
  if ((input.kind === "REFUNDED" || input.kind === "CHARGEBACK") && paidThrough !== null && paidThrough.getTime() > now.getTime()) {
    // Two questions, because a reversal can be identified two ways and the common case has neither field
    // missing nor a mystery to solve: the only payment ever made, refunded at once, *is* the current term
    // and must still revoke it.
    //
    // First, what the provider says. A stated period that ends before what is already paid for names an
    // earlier term outright.
    if (event.periodEndsAt !== undefined && event.periodEndsAt.getTime() < paidThrough.getTime()) {
      return "NONE";
    }
    // Second, what the ledger says — and this is where comparing timestamps was wrong.
    //
    // A reversal's `occurredAt` is when the *reversal* was raised, not when the charge it reverses was
    // made: `NormalizedBillingEvent` says so, and a refund issued today for last month's invoice is
    // legitimately newer than today's renewal. Comparing the two therefore let exactly the case this
    // guard exists for through — a new reversal of an old charge — which Astra demonstrated on PR #100
    // after the first version of this fix. Time cannot answer the question; identity has to.
    //
    // So the ledger is asked how many payments have granted a term on this arrangement at all — and only
    // that, because nothing else in an authenticated payload can carry the answer.
    //
    // **One** grant means there is nothing to confuse: the money being returned is the money that bought
    // the access, whatever the provider chose to state, and it goes. That is the ordinary refund, and an
    // earlier attempt at this guard broke it.
    //
    // **More than one** means a separately paid term may be in force, and the reversal has to *show* it
    // concerns that term. Two things that look like proof are not:
    //
    // - `providerReference` cannot serve. Its own contract is "the provider's own subscription **or**
    //   charge object", so on a recurring arrangement two separately paid terms legitimately share one
    //   subscription id, and a refund of the first charge carries it just as the second does. Matching on
    //   it revoked a term the reversal said nothing about — Astra demonstrated that with
    //   `providerReference='sub-shared'` after the previous version of this guard.
    // - "the most recent grant" cannot serve either. Selecting by `occurredAt` descending picks by event
    //   time, while the monotonic renewal rule above deliberately lets a *delayed* event buy a term that
    //   reaches **farther** than one already applied. So the latest event is not necessarily the payment
    //   that bought the term in force, and a refund of the shorter one would end the longer one.
    //
    // What remains is the one proof the payload does carry: a stated period that reaches the term in
    // force, handled by the check above. Without it, a reversal on a multi-grant arrangement changes
    // nothing, is recorded with `effect: NONE` and audited, and `reconcileProviderState` reads the
    // provider to settle it. Refusing to guess costs a disputed term staying live until that read; the
    // alternative deletes a term somebody paid for, which is worse and irreversible from here.
    const grants =
      event.periodEndsAt !== undefined
        ? 0
        : await tx.billingEvent.count({ where: { arrangementId: arrangement.id, effect: { in: ["ACTIVATE", "EXTEND"] } } });
    if (grants > 1) {
      return "NONE";
    }
  }

  await tx.billingArrangement.update({ where: { id: arrangement.id }, data: { state: "ENDED", endedAt: now } });
  if (existing === null) {
    return "END";
  }
  if (input.kind === "SUBSCRIPTION_CANCELED" && existing.periodEndsAt !== null && existing.periodEndsAt.getTime() > now.getTime()) {
    // Cancel at period end: the workspace keeps what it paid for. The accepted default, and the only
    // branch where the end date is in the future.
    await tx.workspaceSubscription.update({ where: { workspaceId }, data: { state: "CANCELED_PENDING_END", canceledAt: now, periodEndsAt: existing.periodEndsAt } });
    return "END";
  }
  // A refund or a chargeback for the current term takes the money back, so that term is over now. Data is
  // kept.
  await tx.workspaceSubscription.update({ where: { workspaceId }, data: { state: "INACTIVE", canceledAt: now } });
  return "END";
}

/**
 * Writes the workspace's normalized subscription.
 *
 * Takes a workspace id rather than a context, for the reason `readEntitlement` does: the caller is a
 * verified webhook or a reconciliation sweep and there is no session to have. Inventing one so this would
 * type-check is how a background path acquires authority nobody granted — and the authority that matters
 * here was established by `snapshotVerifiedBillingEvent` at the entry point, not by a role.
 */
async function setSubscription(
  tx: DbExecutor,
  workspaceId: string,
  input: { readonly planVersionId: string; readonly state: "ACTIVE"; readonly periodEndsAt: Date },
): Promise<void> {
  const data = { planVersionId: input.planVersionId, state: input.state, periodEndsAt: input.periodEndsAt, graceStartedAt: null, canceledAt: null };
  await tx.workspaceSubscription.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
}

/**
 * Moves the subscription's paid term forward, and says whether it actually moved.
 *
 * `updateMany` with the term in the predicate rather than `upsert`, because this is a compare-and-set: the
 * database decides whether this renewal is the later one, at the moment of writing, holding the row. An
 * `upsert` would write whatever it was given and the last writer would win regardless of which term it
 * bought.
 *
 * `false` means the row is already at or beyond this term — a redelivery, or a reordered renewal that lost
 * a race — and the caller records `effect: NONE`. The missing-row case still has to create one, and that
 * create is safe because `workspaceId` is unique: a concurrent create fails rather than duplicating.
 */
async function extendSubscription(
  tx: DbExecutor,
  workspaceId: string,
  input: { readonly planVersionId: string; readonly periodEndsAt: Date },
): Promise<boolean> {
  const data = { planVersionId: input.planVersionId, state: "ACTIVE" as const, periodEndsAt: input.periodEndsAt, graceStartedAt: null, canceledAt: null };
  const { count } = await tx.workspaceSubscription.updateMany({
    where: { workspaceId, OR: [{ periodEndsAt: null }, { periodEndsAt: { lt: input.periodEndsAt } }] },
    data,
  });
  if (count > 0) {
    return true;
  }
  const existing = await tx.workspaceSubscription.findUnique({ where: { workspaceId }, select: { workspaceId: true } });
  if (existing !== null) {
    return false;
  }
  await tx.workspaceSubscription.create({ data: { workspaceId, ...data } });
  return true;
}

async function writeEvent(
  tx: DbExecutor,
  input: {
    readonly event: VerifiedBillingEvent;
    readonly routeId: string;
    readonly workspaceId: string | null;
    readonly contractId: string | null;
    readonly arrangementId: string | null;
    readonly effect: EntitlementEffect;
    readonly quote?: QuoteVerdict;
    /** The term this event actually put in force, where it granted one. Computed terms included. */
    readonly appliedTermEndsAt?: Date;
    readonly now: Date;
  },
): Promise<{ readonly id: string }> {
  return tx.billingEvent.create({
    data: {
      billingRouteId: input.routeId,
      ...(input.workspaceId === null ? {} : { workspaceId: input.workspaceId }),
      ...(input.contractId === null ? {} : { checkoutContractId: input.contractId }),
      ...(input.arrangementId === null ? {} : { arrangementId: input.arrangementId }),
      kind: input.event.kind,
      providerEventId: input.event.providerEventId,
      activationSource: input.event.activationSource,
      ...(input.event.settled === undefined ? {} : { amountMinor: input.event.settled.amountMinor, currency: input.event.settled.currency }),
      occurredAt: input.event.occurredAt,
      receivedAt: input.now,
      effect: input.effect,
      // Normalized detail only. No raw payload, no signature, no header: a stored signature is a secret
      // in a table nobody treats as one.
      //
      // The term is retained whenever the provider states one, because a reversal arriving later has to be
      // attributable to the term it paid for rather than to whichever term is current — see the `END`
      // branch in `apply`. Where a provider states no period the arrangement's own `currentPeriodEnd`
      // after this event is the answer, ordered by `occurredAt`; this field does not invent one.
      detail: {
        ...(input.quote === undefined ? {} : { quote: input.quote }),
        ...(input.event.periodEndsAt === undefined ? {} : { periodEndsAt: input.event.periodEndsAt.toISOString() }),
        ...(input.event.providerReference === undefined ? {} : { providerReference: input.event.providerReference }),
        // The term this payment actually put in force, which is not always the one it stated: an event
        // with no period of its own gets the interval computed for it, and that computed term is just as
        // much a fact about what was bought. Recorded so the ledger can answer "which term did this
        // payment buy" for every grant rather than only for the talkative ones.
        ...(input.appliedTermEndsAt === undefined ? {} : { appliedTermEndsAt: input.appliedTermEndsAt.toISOString() }),
      },
    },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Reading and sweeping
// ---------------------------------------------------------------------------------------------------------

export interface ArrangementView {
  readonly arrangementId: string;
  readonly kind: ArrangementKind;
  readonly state: string;
  readonly interval: ChargeInterval;
  readonly amount: Money;
  readonly settlementModel: SettlementModel;
  /** The operator's own route code. Never the provider's name, and never its account reference. */
  readonly routeCode: string;
  readonly sellerLegalName: string;
  readonly startedAt?: Date;
  readonly currentPeriodEnd?: Date;
}

/** The workspace's live charge path, as a screen may see it. Null when there is none. */
export async function readArrangement(db: DbExecutor, workspaceId: string): Promise<ArrangementView | null> {
  const row = await db.billingArrangement.findFirst({
    where: { workspaceId, state: { in: ["PENDING", "ACTIVE"] } },
    select: {
      id: true,
      kind: true,
      state: true,
      interval: true,
      amountMinor: true,
      currency: true,
      startedAt: true,
      currentPeriodEnd: true,
      billingRoute: { select: { code: true, settlementModel: true, sellerProfile: { select: { legalName: true } } } },
    },
  });
  if (row === null) {
    return null;
  }
  return {
    arrangementId: row.id,
    kind: row.kind,
    state: row.state,
    interval: chargeIntervalOf(row.interval),
    amount: money(row.amountMinor, row.currency),
    settlementModel: row.billingRoute.settlementModel,
    routeCode: row.billingRoute.code,
    sellerLegalName: row.billingRoute.sellerProfile.legalName,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.currentPeriodEnd === null ? {} : { currentPeriodEnd: row.currentPeriodEnd }),
  };
}

/**
 * Releases the charge path held by a checkout nobody completed.
 *
 * Without this the single-live-path index becomes a trap: one abandoned attempt would block every later
 * purchase until somebody looked at the table. A quote's own expiry is respected first, and `CHECKOUT_TTL_MS`
 * is the backstop for a checkout with no clock on it.
 *
 * Returns how many were released, so the loop that calls it can say it did something.
 */
export async function expireStaleCheckouts(db: DbClient, now = new Date(), ttlMs = CHECKOUT_TTL_MS): Promise<number> {
  const stale = await db.checkoutContract.findMany({
    where: {
      state: "OPEN",
      OR: [{ quoteExpiresAt: { lt: now } }, { quoteExpiresAt: null, openedAt: { lt: new Date(now.getTime() - ttlMs) } }],
    },
    select: { id: true, workspaceId: true, arrangementId: true, quoteExpiresAt: true },
    take: 200,
  });
  let released = 0;
  for (const contract of stale) {
    const changed = await db.$transaction(async (tx) => {
      await serialize(tx, `checkout:${contract.id}`);
      const current = await tx.checkoutContract.findUnique({ where: { id: contract.id }, select: { state: true } });
      if (current === null || current.state !== "OPEN") {
        return false;
      }
      await tx.checkoutContract.update({
        where: { id: contract.id },
        // A quote that ran out is `EXPIRED`; one with no clock that nobody came back to is `ABANDONED`.
        // Two words for two different things, and both keep the acceptance snapshot the attempt carried.
        data: { state: contract.quoteExpiresAt === null ? "ABANDONED" : "EXPIRED" },
      });
      if (contract.arrangementId !== null) {
        await tx.billingArrangement.updateMany({ where: { id: contract.arrangementId, state: "PENDING" }, data: { state: "ENDED", endedAt: now } });
      }
      await recordSystemAuditEvent(
        tx,
        { workspaceId: contract.workspaceId },
        {
          kind: "BILLING_ARRANGEMENT_CHANGED",
          summary: contract.quoteExpiresAt === null ? "Checkout abandoned; charge path released" : "Checkout quote expired; charge path released",
          subjectType: "CheckoutContract",
          subjectId: contract.id,
          occurredAt: now,
          detail: { released: true, reason: contract.quoteExpiresAt === null ? "ABANDONED" : "EXPIRED" },
        },
      );
      return true;
    });
    released += changed ? 1 : 0;
  }
  return released;
}

async function liveArrangement(db: DbExecutor, workspaceId: string): Promise<{ readonly id: string } | null> {
  return db.billingArrangement.findFirst({ where: { workspaceId, state: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } });
}

/** A stored interval, narrowed. `ONE_TIME` is refused by a CHECK, so reaching the throw means the row lied. */
function chargeIntervalOf(value: string): ChargeInterval {
  if (!isChargeInterval(value)) {
    throw new DbInputError("interval", `not a charge interval: ${value}`);
  }
  return value;
}

/** A stored effect, narrowed, for reporting what a duplicate delivery had already done. */
function asEffect(value: string): EntitlementEffect {
  return value === "ACTIVATE" || value === "EXTEND" || value === "SUSPEND" || value === "END" ? value : "NONE";
}

/**
 * Takes a transaction-scoped advisory lock on a name.
 *
 * Released when the transaction ends, however it ends. Used wherever a conflict is an ordinary outcome
 * rather than a fault — a redelivered webhook, two sweepers meeting — because waiting for a lock costs
 * microseconds and an aborted transaction costs the whole operation.
 */
async function serialize(tx: DbExecutor, name: string): Promise<void> {
  // Called in `FROM` and given a column, because the lock function returns `void` and the client cannot
  // deserialize a void column.
  await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}
