/**
 * One example of every verdict and role the spread-key audit reports, so the classifier is pinned to
 * behaviour rather than to a count that drifts with the codebase.
 *
 * These are deliberately *not* realistic: each case exists to make exactly one classification true, and
 * `spread-key-audit.test.ts` names the line it expects for each.
 */

interface Filter {
  readonly tenantId?: string;
  readonly state?: string;
}

interface Row {
  readonly id: string;
  readonly label?: string;
}

type AnyFields = Readonly<Record<string, unknown>>;

declare function findMany(args: { readonly where: Filter }): void;
declare function writeRow(args: { readonly data: Row }): void;
declare function log(fields: AnyFields): void;
declare function take(value: Row): void;

export function exposedFilter(tenantId: string | undefined): void {
  findMany({ where: { state: "s", ...(tenantId === undefined ? {} : { tenantId }) } });
}

export function exposedWrite(label: string | undefined): void {
  writeRow({ data: { id: "r1", ...(label === undefined ? {} : { label }) } });
}

export function exposedValue(label: string | undefined): void {
  take({ id: "r1", ...(label === undefined ? {} : { label }) });
}

export function indexSignatureTarget(label: string | undefined): void {
  log({ event: "x", ...(label === undefined ? {} : { label }) });
}

export function alreadyGuarded(label: string | undefined): void {
  take({ id: "r1", ...(label === undefined ? {} : ({ label } satisfies Pick<Row, "label">)) });
}

export function noKeysAtAll(flag: boolean): Record<string, never> {
  // Writes nothing, so it cannot carry a misspelling and must not be reported as a site.
  return { ...(flag ? {} : {}) };
}

export function logicalAndSpread(label: string | undefined): void {
  take({ id: "r1", ...(label !== undefined && { label }) });
}

/**
 * The target's every property is optional and the literal holds nothing but the spread, so if the only
 * key in it were misspelled the whole object would have no property in common with `Filter` and TS2559
 * would fire without any guard. Partial protection, and the reason it gets its own verdict.
 */
export function weakTargetNoSibling(tenantId: string | undefined): void {
  findMany({ where: { ...(tenantId === undefined ? {} : { tenantId }) } });
}
