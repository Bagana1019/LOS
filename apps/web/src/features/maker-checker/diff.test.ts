import { describe, expect, it } from 'vitest';
import { diffObjects, formatValue, isPlainObject, stableStringify } from './diff';

describe('isPlainObject', () => {
  it('accepts objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe('stableStringify', () => {
  it('sorts object keys at any depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([3, 1, { z: 1, y: 2 }])).toBe('[3,1,{"y":2,"z":1}]');
  });
  it('drops undefined object values and renders primitives like JSON', () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
    expect(stableStringify('s')).toBe('"s"');
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify([undefined])).toBe('[null]');
  });
});

describe('diffObjects', () => {
  it('returns nothing for equal values', () => {
    expect(diffObjects({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toEqual([]);
    expect(diffObjects(null, null)).toEqual([]);
    expect(diffObjects(undefined, undefined)).toEqual([]);
    expect(diffObjects('x', 'x')).toEqual([]);
    expect(diffObjects({}, {})).toEqual([]);
  });

  it('reports changed primitives', () => {
    expect(diffObjects({ name: 'A', n: 1, ok: true }, { name: 'B', n: 1, ok: false })).toEqual([
      { path: 'name', kind: 'changed', before: 'A', after: 'B' },
      { path: 'ok', kind: 'changed', before: true, after: false },
    ]);
  });

  it('distinguishes types (1 vs "1", null vs 0)', () => {
    expect(diffObjects({ a: 1, b: null }, { a: '1', b: 0 })).toEqual([
      { path: 'a', kind: 'changed', before: 1, after: '1' },
      { path: 'b', kind: 'changed', before: null, after: 0 },
    ]);
  });

  it('reports added and removed keys', () => {
    expect(diffObjects({ keep: 1, gone: 'x' }, { keep: 1, fresh: 'y' })).toEqual([
      { path: 'gone', kind: 'removed', before: 'x' },
      { path: 'fresh', kind: 'added', after: 'y' },
    ]);
  });

  it('keeps explicit null distinct from a missing key', () => {
    expect(diffObjects({ a: null }, {})).toEqual([{ path: 'a', kind: 'removed', before: null }]);
    expect(diffObjects({}, { a: null })).toEqual([{ path: 'a', kind: 'added', after: null }]);
    expect(diffObjects({ a: 1 }, { a: null })).toEqual([{ path: 'a', kind: 'changed', before: 1, after: null }]);
  });

  it('treats undefined values as missing keys', () => {
    expect(diffObjects({ a: undefined }, { a: undefined })).toEqual([]);
    expect(diffObjects({ a: undefined }, { a: 1 })).toEqual([{ path: 'a', kind: 'added', after: 1 }]);
    expect(diffObjects({ a: 1 }, { a: undefined })).toEqual([{ path: 'a', kind: 'removed', before: 1 }]);
  });

  it('walks nested objects and reports dot-paths', () => {
    const before = { address: { city: 'UB', geo: { lat: 1, lng: 2 } }, tags: ['a'] };
    const after = { address: { city: 'Darkhan', geo: { lat: 1, lng: 3 }, zip: '14200' }, tags: ['a'] };
    expect(diffObjects(before, after)).toEqual([
      { path: 'address.city', kind: 'changed', before: 'UB', after: 'Darkhan' },
      { path: 'address.geo.lng', kind: 'changed', before: 2, after: 3 },
      { path: 'address.zip', kind: 'added', after: '14200' },
    ]);
  });

  it('flattens a whole object that was added or removed into leaf paths', () => {
    expect(diffObjects({ a: 1 }, { a: 1, extra: { x: 1, y: { z: 2 } } })).toEqual([
      { path: 'extra.x', kind: 'added', after: 1 },
      { path: 'extra.y.z', kind: 'added', after: 2 },
    ]);
    expect(diffObjects({ old: { x: 1 } }, {})).toEqual([{ path: 'old.x', kind: 'removed', before: 1 }]);
  });

  it('keeps an empty object (or undefined-only object) as a leaf when added or removed', () => {
    expect(diffObjects({}, { e: {} })).toEqual([{ path: 'e', kind: 'added', after: {} }]);
    expect(diffObjects({ e: { u: undefined } }, {})).toEqual([{ path: 'e', kind: 'removed', before: { u: undefined } }]);
  });

  it('skips undefined children while flattening', () => {
    expect(diffObjects({}, { o: { a: 1, u: undefined } })).toEqual([{ path: 'o.a', kind: 'added', after: 1 }]);
  });

  it('compares arrays as JSON: element changes, order and length matter', () => {
    expect(diffObjects({ r: ['A', 'B'] }, { r: ['A', 'B'] })).toEqual([]);
    expect(diffObjects({ r: ['A', 'B'] }, { r: ['B', 'A'] })).toEqual([{ path: 'r', kind: 'changed', before: ['A', 'B'], after: ['B', 'A'] }]);
    expect(diffObjects({ r: [1] }, { r: [1, 2] })).toEqual([{ path: 'r', kind: 'changed', before: [1], after: [1, 2] }]);
    expect(diffObjects({ r: [] }, { r: ['x'] })).toHaveLength(1);
  });

  it('ignores key order inside objects held in arrays', () => {
    expect(diffObjects({ l: [{ a: 1, b: 2 }] }, { l: [{ b: 2, a: 1 }] })).toEqual([]);
    expect(diffObjects({ l: [{ a: 1, b: 2 }] }, { l: [{ b: 3, a: 1 }] })).toHaveLength(1);
  });

  it('reports a type change between object and primitive/array at that path', () => {
    expect(diffObjects({ a: { b: 1 } }, { a: 5 })).toEqual([{ path: 'a', kind: 'changed', before: { b: 1 }, after: 5 }]);
    expect(diffObjects({ a: [1] }, { a: { 0: 1 } })).toEqual([{ path: 'a', kind: 'changed', before: [1], after: { 0: 1 } }]);
  });

  it('treats a missing snapshot (null/undefined) as "everything added"', () => {
    const payload = { name: 'X', limits: { max: 10 } };
    const expected = [
      { path: 'name', kind: 'added', after: 'X' },
      { path: 'limits.max', kind: 'added', after: 10 },
    ];
    expect(diffObjects(null, payload)).toEqual(expected);
    expect(diffObjects(undefined, payload)).toEqual(expected);
  });

  it('treats a missing payload as "everything removed"', () => {
    expect(diffObjects({ a: 1 }, null)).toEqual([{ path: 'a', kind: 'removed', before: 1 }]);
  });

  it('reports differing non-object roots at the empty path', () => {
    expect(diffObjects('a', 'b')).toEqual([{ path: '', kind: 'changed', before: 'a', after: 'b' }]);
    expect(diffObjects([1], [2])).toEqual([{ path: '', kind: 'changed', before: [1], after: [2] }]);
    expect(diffObjects({ a: 1 }, 'x')).toEqual([{ path: '', kind: 'changed', before: { a: 1 }, after: 'x' }]);
    expect(diffObjects(null, 5)).toEqual([{ path: '', kind: 'added', after: 5 }]);
  });

  it('is not fooled by keys that exist on Object.prototype', () => {
    expect(diffObjects({}, { constructor: 1 })).toEqual([{ path: 'constructor', kind: 'added', after: 1 }]);
    expect(diffObjects({ constructor: 1 }, {})).toEqual([{ path: 'constructor', kind: 'removed', before: 1 }]);
  });

  it('lists before-keys first, then keys that only exist in after (stable order)', () => {
    const paths = diffObjects({ b: 1, a: 1 }, { c: 2, a: 2, b: 2 }).map((d) => d.path);
    expect(paths).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate its inputs', () => {
    const before = { a: { b: 1 } };
    const after = { a: { b: 2 } };
    diffObjects(before, after);
    expect(before).toEqual({ a: { b: 1 } });
    expect(after).toEqual({ a: { b: 2 } });
  });
});

describe('formatValue', () => {
  it('renders every JSON type readably', () => {
    expect(formatValue(undefined)).toBe('');
    expect(formatValue(null)).toBe('null');
    expect(formatValue('')).toBe('""');
    expect(formatValue('abc')).toBe('abc');
    expect(formatValue(12.5)).toBe('12.5');
    expect(formatValue(false)).toBe('false');
    expect(formatValue({ b: 1, a: [1, 2] })).toBe('{"a":[1,2],"b":1}');
    expect(formatValue(['x', 1])).toBe('["x",1]');
  });
});
