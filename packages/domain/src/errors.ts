/**
 * Raised when a value violates a domain invariant. Messages name the field and the rule only; they
 * never include the offending value, which may be customer data.
 */
export class DomainValidationError extends Error {
  readonly field: string;

  constructor(field: string, rule: string) {
    super(`${field}: ${rule}`);
    this.name = "DomainValidationError";
    this.field = field;
  }
}

/** Compile-time exhaustiveness guard for discriminated unions; throws if reached at runtime. */
export function assertNever(value: never, context = "value"): never {
  const kind = typeof value === "object" && value !== null && "type" in value ? String((value as { type: unknown }).type) : typeof value;
  throw new DomainValidationError(context, `unhandled variant (${kind})`);
}
