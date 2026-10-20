/**
 * An approved provider template, as the product is allowed to reason about it (ADR-016, Issue #20).
 *
 * The *shape* of a template is a domain concept even though templates are a WhatsApp mechanism, for the
 * same reason `WHATSAPP_AFTER_WINDOW_POLICIES` already lives here: the policy and delivery layers must
 * decide whether a set of values may fill an approved template, and they may not import a channel adapter
 * to do it. What stays in the adapter is everything Meta-shaped — parsing `components`, the provider's
 * status vocabulary, the payload — and what lives here is the arithmetic: these names, that many, in this
 * order or any.
 *
 * Nothing here can compose text. A template's wording belongs to the approved template, and the only thing
 * this file knows about it is how many holes it has and what they are called.
 */
import { literalGuard } from "./enum";

/**
 * Meta's two parameter formats. Positional placeholders are numbers and travel in order; named ones are
 * identifiers and each value carries its own name. They are not interchangeable, and a template declares
 * which it uses.
 */
export const TEMPLATE_PARAMETER_FORMATS = ["POSITIONAL", "NAMED"] as const;
export type TemplateParameterFormat = (typeof TEMPLATE_PARAMETER_FORMATS)[number];
export const isTemplateParameterFormat = literalGuard(TEMPLATE_PARAMETER_FORMATS);

/** The approved template's own shape: what a send may fill in, and how. */
export interface ApprovedTemplateShape {
  readonly name: string;
  readonly languageCode: string;
  readonly format: TemplateParameterFormat;
  /**
   * The placeholders the approved wording carries: `["1", "2"]` for a positional template, the parameter
   * names for a named one. For a positional template the order is the order values must arrive in.
   */
  readonly parameters: readonly string[];
}

/** A value offered for one placeholder. Structural on purpose, so a channel's own type satisfies it. */
export interface TemplateValue {
  readonly name: string;
  readonly value: string;
}

export type TemplateVariableProblem =
  | { readonly kind: "COUNT_MISMATCH"; readonly expected: number; readonly supplied: number }
  | { readonly kind: "MISSING_PARAMETER"; readonly name: string }
  | { readonly kind: "UNKNOWN_PARAMETER"; readonly name: string }
  | { readonly kind: "OUT_OF_ORDER"; readonly name: string }
  | { readonly kind: "EMPTY_VALUE"; readonly name: string };

const POSITIONAL_NAME = /^[1-9][0-9]*$/u;

/**
 * Whether these values may fill that template, or the first reason they may not.
 *
 * Checked before dispatch because a provider refusal afterwards is one the customer may already have been
 * promised a reply for — and because the answer cannot change on a retry: a template expecting two values
 * will never accept one.
 */
export function templateVariablesProblem(shape: ApprovedTemplateShape, supplied: readonly TemplateValue[]): TemplateVariableProblem | undefined {
  const empty = supplied.find((parameter) => parameter.value.trim() === "");
  if (empty !== undefined) {
    // An empty value renders as a gap in approved wording. The provider may well accept it; a customer
    // reading "your order  is ready" is the failure this prevents.
    return { kind: "EMPTY_VALUE", name: empty.name };
  }
  if (supplied.length !== shape.parameters.length) {
    return { kind: "COUNT_MISMATCH", expected: shape.parameters.length, supplied: supplied.length };
  }
  if (shape.format === "POSITIONAL") {
    for (const [index, expected] of shape.parameters.entries()) {
      const name = supplied[index]?.name ?? "";
      if (name !== expected) {
        // Positional values must arrive in the order the placeholders appear. A set that matches but is
        // shuffled would put the appointment time where the customer's name belongs.
        return { kind: "OUT_OF_ORDER", name };
      }
    }
    return undefined;
  }
  const expected = new Set(shape.parameters);
  const seen = new Set<string>();
  for (const parameter of supplied) {
    if (!expected.has(parameter.name)) {
      return { kind: "UNKNOWN_PARAMETER", name: parameter.name };
    }
    seen.add(parameter.name);
  }
  const missing = shape.parameters.find((name) => !seen.has(name));
  return missing === undefined ? undefined : { kind: "MISSING_PARAMETER", name: missing };
}

/**
 * How a set of values must be serialized: by name, or by position.
 *
 * Derived from the names rather than carried as a second field, because the two formats partition the name
 * space completely — a positional parameter's name *is* a number and a named one's cannot be.
 */
export function templateParameterFormatOf(parameters: readonly TemplateValue[]): TemplateParameterFormat {
  return parameters.length > 0 && parameters.every((parameter) => POSITIONAL_NAME.test(parameter.name)) ? "POSITIONAL" : "NAMED";
}

/** True when a name is a position rather than a parameter name. */
export function isPositionalParameterName(name: string): boolean {
  return POSITIONAL_NAME.test(name);
}
