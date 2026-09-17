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

/**
 * Compile-time exhaustiveness guard for discriminated unions; throws if reached at runtime.
 *
 * A value that reaches here came from outside the type system (JavaScript callers, provider payloads, an
 * unsafe cast), so it is untrusted: the error names only the shape it had, never the discriminant itself,
 * which could be customer data or a secret.
 */
export function assertNever(value: never, context = "value"): never {
  const shape =
    typeof value === "object" && value !== null
      ? "type" in value
        ? "object with an unhandled type discriminant"
        : "object without a type discriminant"
      : typeof value;
  throw new DomainValidationError(context, `unhandled variant (${shape})`);
}
