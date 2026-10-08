/**
 * Turning the AI-settings URL into a screen, and a screen's decisions back into a URL (Issue #30).
 *
 * Four things live here rather than in the page, because each is a rule that wants a test of its own and
 * none of them needs a database:
 *
 * **The proposal survives its own refusal.** A high-impact change is refused until it is acknowledged, and
 * a refusal that forgot what was proposed sent the owner back to a form rebuilt from *stored* values — so
 * the effect summary ended up describing a change that was no longer on screen. The proposal travels in
 * the URL and the form is rendered from it, which is the only arrangement in which the summary and the
 * values being confirmed are the same thing.
 *
 * **The acknowledgement names what it acknowledges.** Not a bare "confirm" flag, which is satisfied by a
 * checkbox the owner ticked before any summary existed, but the exact impact codes the server computed and
 * showed. The server recomputes them and compares; a request that names a different set, or none, is
 * refused again.
 *
 * **The version travels with the proposal.** `savePolicy` refuses a save composed against settings that
 * have since moved, so an acknowledgement cannot be carried across somebody else's change either.
 *
 * **The history is paged, and the diff is computed here.** `AI_CONFIGURATION_UX.md` asks for the old and
 * new values of material changes, which means comparing two stored snapshots field by field — a pure
 * function over two JSON values, and one that must not invent a field that is absent from both.
 */
import { POLICY_IMPACTS, isAiMode, isConfidencePreset, isInstagramAfterWindowPolicy, isTimingPreset, isWhatsAppAfterWindowPolicy } from "@omnichannel/domain";
import type { AiMode, ConfidencePreset, InstagramAfterWindowPolicy, PolicyImpact, TimingPreset, WhatsAppAfterWindowPolicy } from "@omnichannel/domain";
import { WORKSPACE_ADMIN_ROLES } from "@omnichannel/db";
import type { PolicyAuditCursor } from "@omnichannel/db";

import {
  DEFAULT_SIMULATION_INPUTS,
  SIMULATION_ACCOUNTS,
  SIMULATION_CHANNELS,
  SIMULATION_HUMAN_SUPPORT,
  SIMULATION_REPLY_KINDS,
  SIMULATION_WINDOWS,
  type SimulationInputs,
} from "./simulation";

import type { RawSearchParams } from "./inbox-view";

export function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

/**
 * A free-text field's limit, applied to the proposal rather than to the policy.
 *
 * The domain does not bound a business goal, and should not: it is the owner's sentence about their own
 * business. What is bounded is the *refused* round trip — a proposal travels in a URL, and a URL has a
 * length a server will accept. So the limit is stated, enforced before anything is encoded, and refuses
 * rather than truncates: a goal silently cut in half is a worse answer than a visible refusal.
 */
export const MAX_PROPOSAL_FIELD_CHARS = 2_000;

/** Everything the form posts, as the values a save would write. */
export interface PolicyProposal {
  readonly mode?: AiMode;
  readonly businessGoal: string;
  readonly qualificationCriteria: readonly string[];
  readonly confidencePreset?: ConfidencePreset;
  readonly timingPreset?: TimingPreset;
  /** Only meaningful with `timingPreset: "CUSTOM"`; the ranges an owner typed, in milliseconds. */
  readonly timing?: {
    readonly debounceWindowMs: { readonly minMs: number; readonly maxMs: number };
    readonly deliveryDelayMs: { readonly minMs: number; readonly maxMs: number };
  };
  /** Hours, always present: an unusable value is refused rather than omitted and silently kept. */
  readonly takeoverPauseHours: number;
  readonly instagramAfterWindowPolicy?: InstagramAfterWindowPolicy;
  readonly whatsappAfterWindowPolicy?: WhatsAppAfterWindowPolicy;
  readonly whatsappTemplateAutomationAllowlist: readonly string[];
  /** The policy version the form was rendered from. */
  readonly expectedVersion: number;
}

/** The parameter the refused proposal travels in. */
export const PROPOSAL_PARAM = "proposal";
export const IMPACTS_PARAM = "impacts";
export const AUDIT_CURSOR_PARAM = "auditCursor";

/**
 * The proposal as a URL parameter. Opaque rather than secret: it carries the owner's own form values and
 * no authority at all — the save re-reads the policy, re-checks the role and recomputes the impacts.
 */
export function encodeProposal(proposal: PolicyProposal): string {
  return Buffer.from(JSON.stringify(proposal), "utf8").toString("base64url");
}

/**
 * `undefined` for anything this module did not write.
 *
 * Every field is re-validated on the way in, because the parameter is user-editable: a mode nobody
 * defined, a version that is not a number or a criteria list that is not a list of strings all read as
 * "there is no pending proposal", which falls back to the stored values. The alternative — trusting the
 * shape because we wrote it once — is how a hand-edited URL becomes a write.
 */
export function decodeProposal(encoded: string | undefined): PolicyProposal | undefined {
  if (encoded === undefined || encoded === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  const version = raw["expectedVersion"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return undefined;
  }
  const goal = typeof raw["businessGoal"] === "string" ? raw["businessGoal"] : "";
  const criteria = stringList(raw["qualificationCriteria"]);
  const allowlist = stringList(raw["whatsappTemplateAutomationAllowlist"]);
  // All three, not just the goal. They travel in the same parameter, so a bound on one of them is a bound
  // on nothing: a pasted criteria list is as capable of producing a `Location` a server will not accept,
  // and then the high-impact change can never be confirmed at all.
  if (oversizedField([goal, criteria.join("\n"), allowlist.join("\n")])) {
    return undefined;
  }
  const mode = raw["mode"];
  const confidencePreset = raw["confidencePreset"];
  const timingPreset = raw["timingPreset"];
  const instagram = raw["instagramAfterWindowPolicy"];
  const whatsapp = raw["whatsappAfterWindowPolicy"];
  const hours = raw["takeoverPauseHours"];
  return {
    ...(isAiMode(mode) ? { mode } : {}),
    businessGoal: goal,
    qualificationCriteria: criteria,
    ...(isConfidencePreset(confidencePreset) ? { confidencePreset } : {}),
    ...(isTimingPreset(timingPreset) ? { timingPreset } : {}),
    ...(timingFrom(raw["timing"]) === undefined ? {} : { timing: timingFrom(raw["timing"]) as NonNullable<PolicyProposal["timing"]> }),
    takeoverPauseHours:
      typeof hours === "number" && hours >= TAKEOVER_PAUSE_HOURS.min && hours <= TAKEOVER_PAUSE_HOURS.max && Number.isSafeInteger(hours)
        ? hours
        : TAKEOVER_PAUSE_HOURS.min,
    ...(isInstagramAfterWindowPolicy(instagram) ? { instagramAfterWindowPolicy: instagram } : {}),
    ...(isWhatsAppAfterWindowPolicy(whatsapp) ? { whatsappAfterWindowPolicy: whatsapp } : {}),
    whatsappTemplateAutomationAllowlist: allowlist,
    expectedVersion: version,
  };
}

/** Whether any of the free-text fields that share the proposal parameter is over its stated bound. */
export function oversizedField(fields: readonly string[]): boolean {
  return fields.some((value) => value.length > MAX_PROPOSAL_FIELD_CHARS);
}

/**
 * The hours an owner may ask the assistant to stay out for after a person replies.
 *
 * Bounded here as well as on the input, for the reason the custom timing numbers are: `min` and `max` are
 * a hint to a browser and nothing to a crafted POST, and the domain only asks for a positive integer — so
 * `takeoverPauseHours=100000` was eleven years of silence, accepted and audited as a deliberate choice.
 * A week is the product bound the form has always shown.
 */
export const TAKEOVER_PAUSE_HOURS = { min: 1, max: 168 } as const;

/** Whether the takeover pause a form submitted may be used, or `undefined` when the field was omitted. */
export function takeoverPauseProblem(raw: string): "INCOMPLETE" | "OUT_OF_RANGE" | undefined {
  const trimmed = raw.trim();
  if (!/^-?[0-9]+$/u.test(trimmed)) {
    return "INCOMPLETE";
  }
  const hours = Number.parseInt(trimmed, 10);
  return hours >= TAKEOVER_PAUSE_HOURS.min && hours <= TAKEOVER_PAUSE_HOURS.max ? undefined : "OUT_OF_RANGE";
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : [];
}

function timingFrom(value: unknown): PolicyProposal["timing"] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const debounce = rangeFrom(raw["debounceWindowMs"]);
  const delay = rangeFrom(raw["deliveryDelayMs"]);
  return debounce === undefined || delay === undefined ? undefined : { debounceWindowMs: debounce, deliveryDelayMs: delay };
}

function rangeFrom(value: unknown): { readonly minMs: number; readonly maxMs: number } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const minMs = raw["minMs"];
  const maxMs = raw["maxMs"];
  // Order is *not* checked here: `minMs > maxMs` is the domain's refusal to make, and making it twice is
  // how two validators end up disagreeing about the same form.
  return typeof minMs === "number" && typeof maxMs === "number" && Number.isSafeInteger(minMs) && Number.isSafeInteger(maxMs) && minMs >= 0 && maxMs >= 0
    ? { minMs, maxMs }
    : undefined;
}

/** The impact codes a URL claims were shown, keeping only ones the domain defines. */
export function impactsFromQuery(value: string | undefined): readonly PolicyImpact[] {
  return (value ?? "")
    .split(",")
    .map((impact) => impact.trim())
    .filter((impact): impact is PolicyImpact => (POLICY_IMPACTS as readonly string[]).includes(impact));
}

/**
 * Whether an acknowledgement covers exactly the impacts a save would have.
 *
 * Set equality, not containment: acknowledging *more* than was shown is as suspect as acknowledging less,
 * because both mean the list the owner read is not the list the server computed. Order does not matter,
 * since it is the server's own enumeration order on one side and a form field on the other.
 */
export function acknowledges(acknowledged: readonly string[], impacts: readonly PolicyImpact[]): boolean {
  const left = new Set(acknowledged);
  const right = new Set<string>(impacts);
  return left.size === right.size && [...right].every((impact) => left.has(impact));
}

/** Not secret, only opaque: the `(changedAt, id)` pair the history pages by, so a link survives a bookmark. */
export function encodeAuditCursor(cursor: PolicyAuditCursor): string {
  return Buffer.from(`${cursor.changedAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(encoded: string | undefined): PolicyAuditCursor | undefined {
  if (encoded === undefined || encoded === "") {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator === -1) {
    return undefined;
  }
  const changedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  // Both halves are checked for what the column actually is. The audit row's id is a `uuid`, and Postgres
  // refuses a comparison against anything that is not one — so `?auditCursor=<not a uuid>` reached the
  // query as a thrown `invalid input syntax for type uuid` and took the whole screen with it, form,
  // playground and history, because this page is rendered inside one `Promise.all` and the route has no
  // error boundary. The date arm had this check from the start; the id arm did not, which is the same
  // half-validated shape `decodeProposal` exists to avoid.
  if (Number.isNaN(changedAt.getTime()) || !UUID.test(id)) {
    return undefined;
  }
  return { changedAt, id };
}

/** The shape Postgres will accept for a `uuid` comparison; anything else is not a cursor we minted. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Parameters the history link deliberately drops.
 *
 * `ask` is the playground's question, and the page runs the playground on every render that carries one —
 * embedding the question, searching both corpora and calling the reply model. Reading the change history
 * is not asking the playground anything, so carrying the question billed a model request per page of
 * history and regenerated the answer underneath the reader, who had not asked for a different one. The
 * chosen *inputs* are kept, so re-running after paging asks the same case again.
 */
const HISTORY_DROPS = new Set<string>([AUDIT_CURSOR_PARAM, "ask"]);

/** The link to the next page of history, keeping the state the screen must not lose. */
export function auditHistoryHref(basePath: string, query: RawSearchParams, cursor: PolicyAuditCursor): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const single = one(value);
    if (single !== undefined && !HISTORY_DROPS.has(key)) {
      next.set(key, single);
    }
  }
  next.set(AUDIT_CURSOR_PARAM, encodeAuditCursor(cursor));
  return `${basePath}?${next.toString()}`;
}

/**
 * The stored fields an audit row compares, in the order a person reads them.
 *
 * Named explicitly rather than derived from `Object.keys`: a column added to the policy table would
 * otherwise appear on this screen with no label and no translation, and the i18n gate would only catch it
 * if somebody happened to have an audit row containing it.
 */
export const AUDITED_POLICY_FIELDS = [
  "mode",
  "businessGoal",
  "qualificationCriteria",
  "confidenceThreshold",
  "mandatoryReviewReasons",
  "debounceMinMs",
  "debounceMaxMs",
  "deliveryDelayMinMs",
  "deliveryDelayMaxMs",
  "takeoverPauseMs",
  "instagramAfterWindowPolicy",
  "whatsappAfterWindowPolicy",
  "whatsappTemplateAutomationAllowlist",
] as const;

export type AuditedPolicyField = (typeof AUDITED_POLICY_FIELDS)[number];

export interface PolicyFieldChange {
  readonly field: AuditedPolicyField;
  /** Rendered form of the stored value; absent when the snapshot does not carry the field at all. */
  readonly before?: string;
  readonly after?: string;
}

/**
 * Which stored fields an audit row actually moved, with both sides.
 *
 * Only the fields that differ: a change log that lists every column on every entry hides the one that
 * moved. A field missing from one side is reported as missing rather than as an empty string, because
 * "there was no goal" and "the goal was blank" are different facts and the audit's own JSON distinguishes
 * them.
 */
export function policyChangeDiff(before: unknown, after: unknown): readonly PolicyFieldChange[] {
  const left = before as Record<string, unknown> | null;
  const right = after as Record<string, unknown> | null;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return [];
  }
  const changes: PolicyFieldChange[] = [];
  for (const field of AUDITED_POLICY_FIELDS) {
    const hadBefore = Object.hasOwn(left, field);
    const hadAfter = Object.hasOwn(right, field);
    if (!hadBefore && !hadAfter) {
      continue;
    }
    const sortLists = UNORDERED_POLICY_FIELDS.has(field);
    const rendered = { before: renderValue(left[field], sortLists), after: renderValue(right[field], sortLists) };
    // Compared on the normalised *value*, never on the rendered line. A list joined for display is
    // ambiguous — `["fast replies, polite tone"]` and `["fast replies", "polite tone"]` read identically
    // — so comparing the display form reported two different settings as no change at all, and the entry
    // rendered with nothing in it.
    if (hadBefore && hadAfter && comparable(left[field], sortLists) === comparable(right[field], sortLists)) {
      continue;
    }
    changes.push({
      field,
      ...(hadBefore ? { before: rendered.before } : {}),
      ...(hadAfter ? { after: rendered.after } : {}),
    });
  }
  return changes;
}

/**
 * The two stored lists whose order carries no meaning, and may therefore be compared as sets.
 *
 * Exactly the two the store sorts in its own `changed()` check. `qualificationCriteria` is deliberately
 * not one of them: it is sentences a person wrote in an order they chose, the store treats a reorder as a
 * change and writes an audit row for it — so sorting it here made the screen disagree with the database
 * about what a change is. The entry was then rendered with an empty value list: a history row asserting
 * that somebody changed something and showing nothing, which is the defect this diff exists to prevent.
 * Splitting one criterion into two was invisible the same way, because the joined strings matched.
 */
const UNORDERED_POLICY_FIELDS = new Set<AuditedPolicyField>(["mandatoryReviewReasons", "whatsappTemplateAutomationAllowlist"]);

/**
 * A stored value in a form that two of them can be compared by, unambiguously.
 *
 * JSON rather than the rendered line, so a separator inside an entry cannot make two different lists look
 * like one. Sorted only where the order carries no meaning, which is the same question the store asks.
 */
function comparable(value: unknown, sortLists: boolean): string {
  if (Array.isArray(value) && sortLists) {
    return JSON.stringify([...value.map((entry) => String(entry))].sort());
  }
  return JSON.stringify(value ?? null);
}

/**
 * A stored value as one line of text.
 *
 * A list is sorted only when its order means nothing. `mandatoryReviewReasons` is written from a `Set`, so
 * two snapshots with the same topics in a different order are the same settings and reporting them as a
 * change would make every save look like it touched review topics. The criteria are not like that.
 */
function renderValue(value: unknown, sortLists = false): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    const rendered = value.map((entry) => renderValue(entry, sortLists));
    return (sortLists ? [...rendered].sort() : rendered).join(", ");
  }
  if (typeof value === "object") {
    // Serialised rather than coerced. Every field in the list above is a scalar or an array of scalars
    // today, but the snapshots are stored JSON and a future field could be neither — and `String({})`
    // renders every object as the same four words, so two different values would compare equal and the
    // change would be reported as no change at all.
    return JSON.stringify(value);
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- every remaining case is a primitive.
  return String(value);
}

/**
 * The hypothetical facts the playground was asked about, taking anything unrecognised as the default.
 *
 * Unrecognised rather than refused: these three come from a link, and a hand-edited one should answer the
 * default question rather than show an error page. The defaults are the permissive case, and the screen
 * says which values were used — so a run never shows an outcome without saying what it was an outcome for.
 */
export function simulationInputsFrom(query: RawSearchParams): SimulationInputs {
  const channel = one(query["simChannel"]);
  const window = one(query["simWindow"]);
  const account = one(query["simAccount"]);
  const humanSupport = one(query["simHumanSupport"]);
  const replyKind = one(query["simReplyKind"]);
  // Trimmed and bounded like any other free text that travels in a link. A template name is an identifier
  // the provider issued, not prose, so a long one is a malformed link rather than a long name.
  const templateName = (one(query["simTemplate"]) ?? "").trim().slice(0, MAX_TEMPLATE_NAME_CHARS);
  return {
    channel: SIMULATION_CHANNELS.find((candidate) => candidate === channel) ?? DEFAULT_SIMULATION_INPUTS.channel,
    window: SIMULATION_WINDOWS.find((candidate) => candidate === window) ?? DEFAULT_SIMULATION_INPUTS.window,
    account: SIMULATION_ACCOUNTS.find((candidate) => candidate === account) ?? DEFAULT_SIMULATION_INPUTS.account,
    humanSupport: SIMULATION_HUMAN_SUPPORT.find((candidate) => candidate === humanSupport) ?? DEFAULT_SIMULATION_INPUTS.humanSupport,
    replyKind: SIMULATION_REPLY_KINDS.find((candidate) => candidate === replyKind) ?? DEFAULT_SIMULATION_INPUTS.replyKind,
    templateName,
  };
}

/** A provider template name is an identifier, so a bound is a sanity check rather than a product limit. */
export const MAX_TEMPLATE_NAME_CHARS = 512;

/**
 * Whether this member may change the settings, by the same list the store enforces.
 *
 * The same list on purpose. The store refuses anybody else, so a screen that offered the form to an agent
 * would be offering a form that cannot be submitted — and a screen that computed "who may edit" from its
 * own list would eventually offer it to somebody the store refuses, or hide it from somebody it allows.
 */
export function mayEditSettings(role: string): boolean {
  return (WORKSPACE_ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * The bounds the form offers for a custom timing range, enforced on the server as well.
 *
 * The `min`/`max` attributes on a number input are a hint to a browser and nothing at all to a crafted
 * POST, so the same numbers live here and the action refuses outside them. They are generous rather than
 * tight — this is a product bound, not a policy — but they are finite: a delivery delay of a year is a
 * reply that never arrives, which is a setting an owner cannot have meant.
 */
export const CUSTOM_TIMING_BOUNDS = {
  debounceSeconds: { min: 0, max: 600 },
  deliveryDelaySeconds: { min: 0, max: 86_400 },
} as const;

/** Why a custom timing submission cannot be accepted, or `undefined` when it can. */
export type CustomTimingProblem = "INCOMPLETE" | "OUT_OF_RANGE" | "REVERSED";

/**
 * Whether the four numbers behind "Custom" are usable, and if not, which way they are wrong.
 *
 * Refusing rather than ignoring is the whole point. A submission that selected `CUSTOM` and left a field
 * empty used to be sent without any ranges at all, and the store then kept the stored ones — so an owner
 * saw "Saved" over timing they had not chosen, with the rest of their form applied. An invalid Custom
 * submission presented as a success is worse than a refusal, because nothing on screen disagrees with it.
 *
 * `REVERSED` is named separately although the domain would also refuse it: naming it here lets the screen
 * say which pair is the wrong way round, and the domain still refuses it if this check is ever bypassed.
 */
export function customTimingProblem(seconds: readonly (number | undefined)[]): CustomTimingProblem | undefined {
  if (seconds.length !== 4 || seconds.some((value) => value === undefined || !Number.isFinite(value) || !Number.isInteger(value))) {
    return "INCOMPLETE";
  }
  const [debounceMin, debounceMax, delayMin, delayMax] = seconds as [number, number, number, number];
  const withinDebounce = (value: number) => value >= CUSTOM_TIMING_BOUNDS.debounceSeconds.min && value <= CUSTOM_TIMING_BOUNDS.debounceSeconds.max;
  const withinDelay = (value: number) => value >= CUSTOM_TIMING_BOUNDS.deliveryDelaySeconds.min && value <= CUSTOM_TIMING_BOUNDS.deliveryDelaySeconds.max;
  if (!withinDebounce(debounceMin) || !withinDebounce(debounceMax) || !withinDelay(delayMin) || !withinDelay(delayMax)) {
    return "OUT_OF_RANGE";
  }
  return debounceMin > debounceMax || delayMin > delayMax ? "REVERSED" : undefined;
}
