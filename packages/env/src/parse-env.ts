import type { z } from "zod";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ParseEnvOptions {
  /**
   * Treat `KEY=` (empty string) as unset so defaults/required checks apply.
   * Defaults to `true`, because empty assignments in `.env` files are almost always accidental.
   */
  emptyStringAsUndefined?: boolean;
}

export interface EnvIssue {
  /**
   * Name of the schema-declared variable that failed validation, `(root)` for object-level issues or
   * `(schema)` when the schema threw. Nested path segments are never included (they can be input).
   */
  readonly key: string;
  /**
   * Fixed text for the kind of failure plus, where available, what the schema expects (enum options,
   * type, format, bounds) — derived from the schema definition, never from issue text or metadata.
   */
  readonly message: string;
}

/**
 * Thrown when environment validation fails. Diagnostics are value-free by construction: keys are
 * schema-declared variable names and messages are assembled from fixed text and the schema's own
 * definition. Zod issue messages and metadata are never copied — custom messages, error maps and
 * refinements can embed input there — and exceptions thrown by the schema become a fixed issue.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(
      [
        "Invalid environment configuration:",
        ...issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
      ].join("\n"),
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const SCHEMA_THREW = "Validation threw an exception (details withheld; they may contain values)";
const NESTED_SUFFIX = " (in a nested value)";
const MAX_UNWRAP = 32;

interface SchemaDefinition {
  type?: unknown;
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  entries?: unknown;
  values?: unknown;
  format?: unknown;
  checks?: unknown;
  shape?: unknown;
  valueType?: unknown;
  element?: unknown;
  check?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  value?: unknown;
  inclusive?: unknown;
  pattern?: unknown;
  length?: unknown;
  size?: unknown;
  prefix?: unknown;
  suffix?: unknown;
  includes?: unknown;
}

function definitionOf(schema: unknown): SchemaDefinition | undefined {
  const definition = (schema as { _zod?: { def?: unknown } } | undefined)?._zod?.def;
  return definition !== null && typeof definition === "object" ? definition : undefined;
}

/**
 * Strips wrappers down to the schema whose expectation matters. For a pipe that is the output side
 * (e.g. `.pipe(z.number())`), unless the output is a bare transform, in which case it is the input.
 */
function unwrap(schema: unknown): unknown {
  let current = schema;
  for (let step = 0; step < MAX_UNWRAP; step += 1) {
    const definition = definitionOf(current);
    switch (definition?.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "catch":
      case "readonly":
      case "nonoptional":
        current = definition.innerType;
        break;
      case "pipe":
        current = definitionOf(definition.out)?.type === "transform" ? definition.in : definition.out;
        break;
      default:
        return current;
    }
  }
  return current;
}

/** Follows object/record/array structure; path segments are only used for lookup, never printed. */
function schemaAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    const definition = definitionOf(unwrap(current));
    if (definition?.type === "object" && definition.shape !== null && typeof definition.shape === "object") {
      current =
        typeof segment === "string" && Object.hasOwn(definition.shape, segment)
          ? (definition.shape as Record<string, unknown>)[segment]
          : undefined;
    } else if (definition?.type === "record") {
      current = definition.valueType;
    } else if (definition?.type === "array") {
      current = definition.element;
    } else {
      return undefined;
    }
  }
  return current;
}

function formatOptions(values: readonly unknown[]): string | undefined {
  const printable = values.filter((value) => ["string", "number", "boolean"].includes(typeof value));
  return printable.length > 0 ? `one of ${printable.map((value) => JSON.stringify(value)).join("|")}` : undefined;
}

/** Schema-owned bound values: numbers, bigints and dates (from `.min(new Date(...))`). */
function boundText(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

const INTEGER_FORMATS: ReadonlySet<unknown> = new Set(["safeint", "int32", "uint32"]);

/** A string format rule, described by its schema-owned parameters. */
function formatRule(definition: SchemaDefinition): string | undefined {
  switch (definition.format) {
    case "regex":
      return definition.pattern instanceof RegExp ? `matching ${String(definition.pattern)}` : "matching a pattern";
    case "starts_with":
      return typeof definition.prefix === "string" ? `starting with ${JSON.stringify(definition.prefix)}` : undefined;
    case "ends_with":
      return typeof definition.suffix === "string" ? `ending with ${JSON.stringify(definition.suffix)}` : undefined;
    case "includes":
      return typeof definition.includes === "string" ? `including ${JSON.stringify(definition.includes)}` : undefined;
    case "lowercase":
    case "uppercase":
      return definition.format;
    default:
      return typeof definition.format === "string" ? `a valid ${definition.format}` : undefined;
  }
}

interface Rules {
  formats: string[];
  sizes: string[];
  bounds: string[];
  multiples: string[];
  integer: boolean;
}

function rulesOf(definition: SchemaDefinition): Rules {
  const rules: Rules = { formats: [], sizes: [], bounds: [], multiples: [], integer: INTEGER_FORMATS.has(definition.format) };
  const checks: readonly unknown[] = Array.isArray(definition.checks) ? definition.checks : [];
  for (const check of checks) {
    const rule = definitionOf(check);
    switch (rule?.check) {
      case "string_format": {
        const text = formatRule(rule);
        if (text !== undefined) rules.formats.push(text);
        break;
      }
      case "number_format":
        if (INTEGER_FORMATS.has(rule.format)) rules.integer = true;
        break;
      case "min_length":
      case "min_size":
        if (boundText(rule.minimum) !== undefined) rules.sizes.push(`length >= ${boundText(rule.minimum)}`);
        break;
      case "max_length":
      case "max_size":
        if (boundText(rule.maximum) !== undefined) rules.sizes.push(`length <= ${boundText(rule.maximum)}`);
        break;
      case "length_equals":
      case "size_equals": {
        const exact = boundText(rule.check === "length_equals" ? rule.length : rule.size);
        if (exact !== undefined) rules.sizes.push(`length = ${exact}`);
        break;
      }
      case "greater_than":
      case "less_than": {
        const value = boundText(rule.value);
        if (value !== undefined) {
          rules.bounds.push(`${rule.check === "greater_than" ? ">" : "<"}${rule.inclusive === true ? "=" : ""} ${value}`);
        }
        break;
      }
      case "multiple_of":
        if (boundText(rule.value) !== undefined) rules.multiples.push(`a multiple of ${boundText(rule.value)}`);
        break;
      default:
        break;
    }
  }
  return rules;
}

/**
 * What the schema expects for this kind of failure, from its definition only (schema code, never
 * input): format rules for format failures, size/bound rules for too small/big, and so on.
 */
function describeExpectation(schema: unknown, code: string): string | undefined {
  const definition = definitionOf(unwrap(schema));
  if (!definition) {
    return undefined;
  }
  switch (definition.type) {
    case "enum":
      return definition.entries !== null && typeof definition.entries === "object"
        ? formatOptions(Object.values(definition.entries))
        : undefined;
    case "literal":
      return Array.isArray(definition.values) ? formatOptions(definition.values) : undefined;
    case "string":
    case "array":
    case "set": {
      const rules = rulesOf(definition);
      const topFormat = definition.type === "string" ? formatRule(definition) : undefined;
      const subject = topFormat ?? definition.type;
      const formats = [...(topFormat ? [topFormat] : []), ...rules.formats];
      if (code === "invalid_format") {
        return formats.length > 0 ? formats.join(", ") : subject;
      }
      if (code === "too_small" || code === "too_big") {
        return rules.sizes.length > 0 ? `${subject} with ${rules.sizes.join(", ")}` : subject;
      }
      const details = [...rules.formats, ...(rules.sizes.length > 0 ? [`with ${rules.sizes.join(", ")}`] : [])];
      return [subject, ...details].join(" ");
    }
    case "number":
    case "bigint":
    case "date": {
      const rules = rulesOf(definition);
      const subject = definition.type === "number" && rules.integer ? "integer" : definition.type;
      if (code === "not_multiple_of") {
        return rules.multiples.length > 0 ? rules.multiples.join(", ") : subject;
      }
      const details = code === "too_small" || code === "too_big" ? rules.bounds : [...rules.bounds, ...rules.multiples];
      return details.length > 0 ? `${subject} ${details.join(", ")}` : subject;
    }
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  invalid_type: "Invalid input",
  invalid_value: "Invalid option",
  invalid_format: "Invalid format",
  too_small: "Too small",
  too_big: "Too big",
  not_multiple_of: "Invalid multiple",
  invalid_union: "Matched no allowed alternative",
  invalid_key: "Invalid key",
  invalid_element: "Invalid element",
  unrecognized_keys: "Unrecognized keys (names withheld)",
};
const CUSTOM_FAILURE_TEXT = "Invalid value (custom validation details withheld)";

function describeIssue(schema: z.ZodObject, issue: z.core.$ZodIssue, rawInput: string | undefined): string {
  const rawCode: unknown = issue.code;
  const code = typeof rawCode === "string" ? rawCode : "";
  const path: readonly PropertyKey[] = Array.isArray(issue.path) ? issue.path : [];
  const failure = Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code] : undefined;
  if (failure === undefined) {
    return path.length > 1 ? `${CUSTOM_FAILURE_TEXT}${NESTED_SUFFIX}` : CUSTOM_FAILURE_TEXT;
  }
  let message = failure;
  const expectation = code === "unrecognized_keys" ? undefined : describeExpectation(schemaAtPath(schema, path), code);
  if (expectation !== undefined) {
    message += `: expected ${expectation}`;
    // Only the kind of raw value (never its text), and only for the top-level environment string.
    if (code === "invalid_type" && path.length === 1) {
      message += `, received ${rawInput === undefined ? "undefined" : "string"}`;
    }
  }
  return path.length > 1 ? `${message}${NESTED_SUFFIX}` : message;
}

/**
 * Validates `source` (default `process.env`) against a Zod object schema and returns the typed,
 * defaulted result. Unknown variables are ignored; only the keys declared in `schema` are read.
 *
 * Diagnostics are value-free by construction (see `EnvValidationError`).
 */
export function parseEnv<TShape extends z.ZodRawShape>(
  schema: z.ZodObject<TShape>,
  source: EnvSource = process.env,
  options: ParseEnvOptions = {},
): z.output<z.ZodObject<TShape>> {
  const emptyStringAsUndefined = options.emptyStringAsUndefined ?? true;
  const declaredKeys = Object.keys(schema.shape);

  const input: Record<string, string | undefined> = {};
  for (const key of declaredKeys) {
    const value = source[key];
    input[key] = emptyStringAsUndefined && value === "" ? undefined : value;
  }

  let issues: EnvIssue[];
  try {
    // `reportInput` stays off so issues never carry the raw (possibly secret) value. Issues are
    // finalized lazily (error maps run then), so everything that touches them stays in this try.
    const result = schema.safeParse(input);
    if (result.success) {
      return result.data;
    }
    issues = result.error.issues.map((issue) => {
      const firstSegment: unknown = Array.isArray(issue.path) ? issue.path[0] : undefined;
      const variable =
        typeof firstSegment === "string" && declaredKeys.includes(firstSegment) ? firstSegment : undefined;
      return {
        key: variable ?? "(root)",
        message: describeIssue(schema, issue, variable === undefined ? undefined : input[variable]),
      };
    });
  } catch {
    // e.g. a transform calling JSON.parse/new URL on a malformed secret: the error may quote it.
    throw new EnvValidationError([{ key: "(schema)", message: SCHEMA_THREW }]);
  }
  throw new EnvValidationError(issues);
}
