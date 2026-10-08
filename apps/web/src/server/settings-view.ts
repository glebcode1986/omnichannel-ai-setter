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
  readonly takeoverPauseHours?: number;
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
  if (goal.length > MAX_PROPOSAL_FIELD_CHARS) {
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
    ...(typeof hours === "number" && Number.isSafeInteger(hours) && hours > 0 ? { takeoverPauseHours: hours } : {}),
    ...(isInstagramAfterWindowPolicy(instagram) ? { instagramAfterWindowPolicy: instagram } : {}),
    ...(isWhatsAppAfterWindowPolicy(whatsapp) ? { whatsappAfterWindowPolicy: whatsapp } : {}),
    whatsappTemplateAutomationAllowlist: allowlist,
    expectedVersion: version,
  };
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
  if (Number.isNaN(changedAt.getTime()) || id === "") {
    return undefined;
  }
  return { changedAt, id };
}

/** The link to the next page of history, keeping whatever else the URL carried. */
export function auditHistoryHref(basePath: string, query: RawSearchParams, cursor: PolicyAuditCursor): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const single = one(value);
    if (single !== undefined && key !== AUDIT_CURSOR_PARAM) {
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
    const rendered = { before: renderValue(left[field]), after: renderValue(right[field]) };
    if (hadBefore && hadAfter && rendered.before === rendered.after) {
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
 * A stored value as one line of text.
 *
 * Lists are sorted before they are joined, because `mandatoryReviewReasons` is written from a `Set` and
 * its order is an implementation detail: two snapshots with the same topics in a different order are the
 * same settings, and reporting them as a change would make every save look like it touched review topics.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return [...value.map((entry) => renderValue(entry))].sort().join(", ");
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
  return {
    channel: SIMULATION_CHANNELS.find((candidate) => candidate === channel) ?? DEFAULT_SIMULATION_INPUTS.channel,
    window: SIMULATION_WINDOWS.find((candidate) => candidate === window) ?? DEFAULT_SIMULATION_INPUTS.window,
    account: SIMULATION_ACCOUNTS.find((candidate) => candidate === account) ?? DEFAULT_SIMULATION_INPUTS.account,
    humanSupport: SIMULATION_HUMAN_SUPPORT.find((candidate) => candidate === humanSupport) ?? DEFAULT_SIMULATION_INPUTS.humanSupport,
  };
}

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
