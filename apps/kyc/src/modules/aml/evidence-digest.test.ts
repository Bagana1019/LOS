import { describe, expect, it } from 'vitest';
import { canonicalJson, evidenceDigestOf } from './evidence-digest';
import type { HitCandidate } from './engine/screening-engine';

const candidate = (over: Partial<HitCandidate> = {}): HitCandidate => ({
  list: 'UN_SC', matchType: 'NAME_EXACT', score: 1, severity: 'BLOCKING', entryRef: 'T-1', entryName: 'Entry One', matchedValue: 'Entry One',
  details: { programme: 'TEST', dateOfBirth: 'UNKNOWN', nationalities: ['MN', 'KZ'], nested: { a: 1, b: [1, 2] } }, listVersion: 'v1', ...over,
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('is independent of the key insertion order', () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(canonicalJson({ y: { q: 2, p: 1 }, x: 1 }));
  });

  it('skips undefined keys, keeps null, and renders scalars like JSON', () => {
    expect(canonicalJson({ a: undefined, b: null, c: 'é"', d: false })).toBe('{"b":null,"c":"é\\"","d":false}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson([undefined])).toBe('[null]');
  });
});

describe('evidenceDigestOf', () => {
  it('is a sha256 hex string, stable for equal evidence whatever the key order of the details', () => {
    const a = evidenceDigestOf(candidate());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceDigestOf(candidate({ details: { nested: { b: [1, 2], a: 1 }, nationalities: ['MN', 'KZ'], dateOfBirth: 'UNKNOWN', programme: 'TEST' } }))).toBe(a);
  });

  it('changes with the list, entry, match type, severity and score', () => {
    const digests = [
      evidenceDigestOf(candidate()),
      evidenceDigestOf(candidate({ list: 'FATF' })),
      evidenceDigestOf(candidate({ entryRef: 'T-2' })),
      evidenceDigestOf(candidate({ matchType: 'NAME_FUZZY' })),
      evidenceDigestOf(candidate({ severity: 'WARNING' })),
      evidenceDigestOf(candidate({ score: 0.9 })),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('changes with any evidence in the details (birth date evidence, category, nationalities order)', () => {
    const base = evidenceDigestOf(candidate());
    expect(evidenceDigestOf(candidate({ details: { ...candidate().details, dateOfBirth: 'MATCH' } }))).not.toBe(base);
    expect(evidenceDigestOf(candidate({ details: { ...candidate().details, category: 'CALL_FOR_ACTION' } }))).not.toBe(base);
    expect(evidenceDigestOf(candidate({ details: { ...candidate().details, nationalities: ['KZ', 'MN'] } }))).not.toBe(base);
  });

  it('does not depend on the list version, the display name or the matched value', () => {
    expect(evidenceDigestOf(candidate({ listVersion: 'v2', entryName: 'Renamed', matchedValue: null }))).toBe(evidenceDigestOf(candidate()));
  });

  it('ignores the markers the service adds itself', () => {
    const base = evidenceDigestOf(candidate());
    const marked = candidate({ details: { ...candidate().details, carriedOverFrom: 'old-1', evidenceDigest: 'abc', reopenedBecause: 'EVIDENCE_CHANGED' } });
    expect(evidenceDigestOf(marked)).toBe(base);
    expect(marked.details).toHaveProperty('carriedOverFrom'); // оролтыг өөрчлөөгүй
  });
});
