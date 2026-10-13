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
import {
  entitlementEffectOf,
  isBillingCapability,
  isChargeInterval,
  isCurrencyCode,
  missingAcceptances,
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
import { assertVerifiedBillingEvent, type VerifiedBillingEvent } from "./billing-events";
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
  /** Where the published text lives. Opaque to the product. */
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
  return db.$transaction(async (tx) => {
    const seller =
      input.sellerProfileCode === undefined
        ? null
        : await tx.sellerProfile.findUnique({ where: { code: input.sellerProfileCode }, select: { id: true } });
    if (input.sellerProfileCode !== undefined && seller === null) {
      throw new DbInputError("sellerProfileCode", `no seller profile with code ${input.sellerProfileCode}`);
    }
    await serialize(tx, `legal-document:${input.kind}:${input.locale}`);
    const latest = await tx.legalDocument.findFirst({
      where: { kind: input.kind, locale: input.locale },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const row = await tx.legalDocument.create({
      data: {
        kind: input.kind,
        locale: input.locale,
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
  /** Which language the legal documents are offered in. */
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

/** One legal document a checkout has to be accepted against. */
export interface LegalDocumentOffer {
  readonly legalDocumentId: string;
  readonly kind: LegalDocumentKind;
  readonly version: number;
  readonly locale: string;
  readonly contentRef: string;
  readonly requiredForCheckout: boolean;
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
}

export const CHECKOUT_REFUSALS = [
  "NO_ROUTE",
  "NO_PRICE",
  "ARRANGEMENT_EXISTS",
  "TERMS_NOT_ACCEPTED",
  "DOCUMENT_NOT_APPLICABLE",
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
export async function readCheckoutOffer(db: DbClient, context: WorkspaceContext, request: CheckoutRequest): Promise<CheckoutOffer | CheckoutRefusal> {
  requireRole(context, BILLING_ROLES, "open a checkout");
  const workspaceId = scopeOf(context);
  const live = request.supersedeCurrent === true ? null : await liveArrangement(db, workspaceId);
  if (live !== null) {
    return { available: false, reason: "ARRANGEMENT_EXISTS", detail: [live.id] };
  }
  const resolved = await resolveCheckout(db, request);
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
  const documents = await readLegalDocumentOffers(db, row.sellerProfileId, request.locale);
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
    },
  };
}

/**
 * The effective version of every legal document applicable to a selling entity, in one locale.
 *
 * "Effective" is the latest version whose `effectiveFrom` has passed, per kind; a version published for
 * next month exists and is not offered. A seller-specific document shadows a global one of the same kind,
 * because an entity that publishes its own offer has superseded the generic one for its own checkouts.
 */
async function readLegalDocumentOffers(db: DbExecutor, sellerProfileId: string, locale: string, at = new Date()): Promise<readonly LegalDocumentOffer[]> {
  const rows = await db.legalDocument.findMany({
    where: { locale, effectiveFrom: { lte: at }, OR: [{ sellerProfileId }, { sellerProfileId: null }] },
    orderBy: [{ kind: "asc" }, { effectiveFrom: "desc" }, { version: "desc" }],
    select: { id: true, kind: true, version: true, locale: true, contentRef: true, requiredForCheckout: true, sellerProfileId: true },
  });
  const offers = new Map<LegalDocumentKind, { readonly offer: LegalDocumentOffer; readonly specific: boolean }>();
  for (const row of rows) {
    const candidate = {
      offer: {
        legalDocumentId: row.id,
        kind: row.kind,
        version: row.version,
        locale: row.locale,
        contentRef: row.contentRef,
        requiredForCheckout: row.requiredForCheckout,
      },
      specific: row.sellerProfileId !== null,
    };
    const chosen = offers.get(row.kind);
    // Rows arrive newest first per kind, so the first of a kind wins — except that a seller-specific
    // document displaces a global one however new the global one is: an entity that published its own
    // offer has superseded the generic text for its own checkouts.
    if (chosen === undefined || (candidate.specific && !chosen.specific)) {
      offers.set(row.kind, candidate);
    }
  }
  return [...offers.values()].map((entry) => entry.offer);
}

export interface OpenCheckoutInput extends CheckoutRequest {
  /** The document versions the person ticked. Every required kind has to be among them. */
  readonly acceptedDocumentIds: readonly string[];
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

  return db.$transaction(async (tx) => {
    const live = await liveArrangement(tx, workspaceId);
    if (live !== null && input.supersedeCurrent !== true) {
      return { available: false, reason: "ARRANGEMENT_EXISTS", detail: [live.id] } satisfies CheckoutRefusal;
    }
    const resolved = await resolveCheckout(tx, input);
    if (!resolved.available) {
      return resolved.refusal;
    }

    const accepted = resolved.documents.filter((document) => input.acceptedDocumentIds.includes(document.legalDocumentId));
    const forged = input.acceptedDocumentIds.filter((id) => !resolved.documents.some((document) => document.legalDocumentId === id));
    if (forged.length > 0) {
      // A document that is not applicable to this seller profile, not effective yet, or not in this
      // locale. Refused rather than ignored: recording it would be recording consent to something the
      // customer was never shown.
      return { available: false, reason: "DOCUMENT_NOT_APPLICABLE", detail: forged } satisfies CheckoutRefusal;
    }
    const missing = missingAcceptances(
      resolved.documents.filter((document) => document.requiredForCheckout).map((document) => document.kind),
      accepted.map((document) => document.kind),
    );
    if (missing.length > 0) {
      return { available: false, reason: "TERMS_NOT_ACCEPTED", detail: [...missing] } satisfies CheckoutRefusal;
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
 * The first line is the whole security model: `assertVerifiedBillingEvent` refuses anything that
 * `billing-events.ts` did not mint, so a success-page handler cannot reach this path even by
 * constructing an object of the right shape and casting it.
 *
 * Idempotent by index. A redelivered webhook is read before it is written, under an advisory lock on the
 * route and event identifier, and returns `DUPLICATE` with the effect the first delivery had — so a
 * provider retrying for an hour neither double-charges nor double-extends.
 */
export async function recordVerifiedBillingEvent(db: DbClient, event: VerifiedBillingEvent, now = new Date()): Promise<BillingEventResult> {
  assertVerifiedBillingEvent(event);

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

    const row = await writeEvent(tx, {
      event,
      routeId: route.id,
      workspaceId,
      contractId: contract?.id ?? null,
      arrangementId: arrangement?.id ?? null,
      effect: applied,
      now,
      ...(decision.quote === undefined ? {} : { quote: decision.quote }),
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
    const settled = await tx.workspaceSubscription.findUnique({ where: { workspaceId }, select: { state: true } });
    if (settled !== null && (settled.state === "CANCELED_PENDING_END" || settled.state === "INACTIVE")) {
      return "NONE";
    }
    const interval = chargeIntervalOf(arrangement.interval);
    const from = arrangement.currentPeriodEnd !== null && arrangement.currentPeriodEnd.getTime() > now.getTime() ? arrangement.currentPeriodEnd : now;
    const periodEndsAt = event.periodEndsAt ?? periodEndFor(interval, from);
    await tx.billingArrangement.update({ where: { id: arrangement.id }, data: { currentPeriodEnd: periodEndsAt } });
    await setSubscription(tx, workspaceId, { planVersionId: arrangement.planVersionId, state: "ACTIVE", periodEndsAt });
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
  await tx.billingArrangement.update({ where: { id: arrangement.id }, data: { state: "ENDED", endedAt: now } });
  const existing = await tx.workspaceSubscription.findUnique({ where: { workspaceId }, select: { periodEndsAt: true } });
  if (existing === null) {
    return "END";
  }
  const paidThrough = existing.periodEndsAt;
  if (input.kind === "SUBSCRIPTION_CANCELED" && paidThrough !== null && paidThrough.getTime() > now.getTime()) {
    // Cancel at period end: the workspace keeps what it paid for. The accepted default, and the only
    // branch where the end date is in the future.
    await tx.workspaceSubscription.update({ where: { workspaceId }, data: { state: "CANCELED_PENDING_END", canceledAt: now, periodEndsAt: paidThrough } });
    return "END";
  }
  // A refund or a chargeback takes the money back, so the term it paid for is over now. Data is kept.
  await tx.workspaceSubscription.update({ where: { workspaceId }, data: { state: "INACTIVE", canceledAt: now } });
  return "END";
}

/**
 * Writes the workspace's normalized subscription.
 *
 * Takes a workspace id rather than a context, for the reason `readEntitlement` does: the caller is a
 * verified webhook or a reconciliation sweep and there is no session to have. Inventing one so this would
 * type-check is how a background path acquires authority nobody granted — and the authority that matters
 * here was established by `assertVerifiedBillingEvent`, not by a role.
 */
async function setSubscription(
  tx: DbExecutor,
  workspaceId: string,
  input: { readonly planVersionId: string; readonly state: "ACTIVE"; readonly periodEndsAt: Date },
): Promise<void> {
  const data = { planVersionId: input.planVersionId, state: input.state, periodEndsAt: input.periodEndsAt, graceStartedAt: null, canceledAt: null };
  await tx.workspaceSubscription.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
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
      detail: { ...(input.quote === undefined ? {} : { quote: input.quote }) },
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
