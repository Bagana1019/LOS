// Pure helpers for the "Өмнө → Дараа" table of a change request (before snapshot vs proposed payload).

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  /** Dot-path of the leaf, e.g. "address.city"; '' when the root values themselves differ. */
  path: string;
  kind: DiffKind;
  /** Absent for 'added'. */
  before?: unknown;
  /** Absent for 'removed'. */
  after?: unknown;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON with sorted object keys, so key order (e.g. after a jsonb round trip) never counts as a change. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    const body = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const jsonEqual = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = Object.keys(a);
  for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) keys.push(k);
  return keys;
}

/** Emit one entry per leaf of a value that exists on one side only. */
function flatten(value: unknown, path: string, kind: 'added' | 'removed', out: DiffEntry[]): void {
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (keys.length > 0) {
      for (const k of keys) flatten(value[k], join(path, k), kind, out);
      return;
    }
  }
  out.push(kind === 'added' ? { path, kind, after: value } : { path, kind, before: value });
}

function walk(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined) return flatten(after, path, 'added', out);
  if (after === undefined) return flatten(before, path, 'removed', out);
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of unionKeys(before, after)) walk(own(before, key), own(after, key), join(path, key), out);
    return;
  }
  // Primitives, arrays (compared as JSON) and mixed types are leaves.
  if (!jsonEqual(before, after)) out.push({ path, kind: 'changed', before, after });
}

/**
 * Field-by-field difference between `before` and `after`.
 * - nested objects are walked recursively and reported by dot-path;
 * - arrays and primitives are leaves, arrays are compared as (key-sorted) JSON;
 * - a root `null`/`undefined` means "no value": everything on the other side is added/removed.
 */
export function diffObjects(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before ?? undefined, after ?? undefined, '', out);
  return out;
}

/** Human readable single-line rendering of a diff leaf. */
export function formatValue(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'object') return stableStringify(v);
  return String(v);
}
