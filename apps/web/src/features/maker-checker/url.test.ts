import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, TAB_KEYS, buildUrl, isScopeTab, parseId, parseTab } from './url';

describe('parseTab', () => {
  it('accepts every known tab', () => {
    for (const t of TAB_KEYS) expect(parseTab(t)).toBe(t);
  });
  it('falls back to the inbox for missing or unknown values', () => {
    expect(DEFAULT_TAB).toBe('inbox');
    for (const v of [null, undefined, '', 'nope', 'INBOX', 'constructor']) expect(parseTab(v)).toBe('inbox');
  });
});

describe('isScopeTab', () => {
  it('is true for list scopes and false for policies', () => {
    expect(['inbox', 'mine', 'decided', 'all'].every((t) => isScopeTab(t as never))).toBe(true);
    expect(isScopeTab('policies')).toBe(false);
  });
});

describe('parseId', () => {
  it('returns a trimmed id', () => {
    expect(parseId('  0b9a  ')).toBe('0b9a');
  });
  it('ignores blank, missing and absurdly long values', () => {
    expect(parseId(null)).toBeNull();
    expect(parseId(undefined)).toBeNull();
    expect(parseId('   ')).toBeNull();
    expect(parseId('x'.repeat(65))).toBeNull();
    expect(parseId('x'.repeat(64))).toBe('x'.repeat(64));
  });
});

describe('buildUrl', () => {
  it('always keeps the tab explicit', () => {
    expect(buildUrl('/los/maker-checker', { tab: 'inbox' })).toBe('/los/maker-checker?tab=inbox');
    expect(buildUrl('/los/maker-checker', { tab: 'policies' })).toBe('/los/maker-checker?tab=policies');
  });
  it('adds the id when a request is open', () => {
    expect(buildUrl('/p', { tab: 'mine', id: 'abc' })).toBe('/p?tab=mine&id=abc');
    expect(buildUrl('/p', { tab: 'mine', id: null })).toBe('/p?tab=mine');
  });
  it('escapes the id', () => {
    expect(buildUrl('/p', { tab: 'all', id: 'a b&c' })).toBe('/p?tab=all&id=a+b%26c');
  });
  it('round-trips through parseTab / parseId', () => {
    const q = new URLSearchParams(buildUrl('/p', { tab: 'decided', id: 'x-1' }).split('?')[1]);
    expect(parseTab(q.get('tab'))).toBe('decided');
    expect(parseId(q.get('id'))).toBe('x-1');
  });
});
