/** Builds a type guard for a closed set of string literals declared `as const`. */
export function literalGuard<const Values extends readonly string[]>(values: Values) {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is Values[number] => typeof value === "string" && allowed.has(value);
}
