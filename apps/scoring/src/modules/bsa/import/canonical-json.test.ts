// Түлхүүрийн дарааллаас үл хамаарах JSON харьцуулалт (jsonb-ийн түлхүүр эрэмбэлэлтэд тэсвэртэй).
import { describe, expect, it } from 'vitest';
import { canonicalJson, sameJson } from './canonical-json';

describe('canonicalJson / sameJson', () => {
  it('ignores object key order at every depth but keeps array order', () => {
    expect(sameJson({ a: 1, b: { x: 1, y: [1, 2] } }, { b: { y: [1, 2], x: 1 }, a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it('distinguishes values, null and missing keys', () => {
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: null }, {})).toBe(false);
    expect(sameJson({ a: undefined, b: 1 }, { b: 1 })).toBe(true); // undefined талбар JSON-д орохгүй
    expect(sameJson(null, null)).toBe(true);
    expect(sameJson(null, {})).toBe(false);
  });

  it('keeps primitives, dates and numbers intact', () => {
    expect(canonicalJson(41.2)).toBe('41.2');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson({ at: new Date('2026-07-15T09:00:00.000Z') })).toBe('{"at":"2026-07-15T09:00:00.000Z"}');
  });
});
