// matchPhrase: үгийн хил хүндэтгэсэн хайлт (BSA-FR-3.1). Бүх текст синтетик.
import { describe, expect, it } from 'vitest';
import { lastWordLength, matchPhrase } from './text-match';
import { matchKey, prepareTxn, rawTextOf } from './normalize';
import { makeTxn } from './testing/factories';

describe('matchPhrase', () => {
  it('EXACT when both edges are word boundaries', () => {
    expect(matchPhrase('tsalin 2026 03|', 'tsalin', true)).toBe('EXACT');
    expect(matchPhrase('x tsalin', 'tsalin', false)).toBe('EXACT');
    expect(matchPhrase('tsalin', 'tsalin', false)).toBe('EXACT');
  });

  it('PREFIX only when the caller allows inflected suffixes', () => {
    expect(matchPhrase('tsalingin urdchilga', 'tsalin', true)).toBe('PREFIX');
    expect(matchPhrase('tsalingin urdchilga', 'tsalin', false)).toBeNull();
  });

  it('never matches inside another word (left boundary): "ус" is not in "мусак" / "Rus"', () => {
    expect(matchPhrase(matchKey('мусак'), matchKey('ус'), false)).toBeNull();
    expect(matchPhrase(matchKey('Rus'), matchKey('ус'), false)).toBeNull();
    expect(matchPhrase(matchKey('Ус'), matchKey('ус'), false)).toBe('EXACT');
    expect(matchPhrase(matchKey('Усны төлбөр'), matchKey('ус'), false)).toBeNull(); // 'усны' өөр үг: тусдаа түлхүүр хэрэгтэй
  });

  it('prefers a later EXACT occurrence over an earlier PREFIX one', () => {
    expect(matchPhrase('tsalingin tsalin', 'tsalin', true)).toBe('EXACT');
    expect(matchPhrase('musak us', 'us', false)).toBe('EXACT');
  });

  it('treats the field separator as a boundary and never matches across fields', () => {
    expect(matchPhrase('abc|us def', 'us', false)).toBe('EXACT');
    expect(matchPhrase('foo us|bar', 'us bar', false)).toBeNull();
  });

  it('empty phrase never matches', () => {
    expect(matchPhrase('anything', '', true)).toBeNull();
    expect(matchPhrase('', 'x', true)).toBeNull();
  });

  it('multi-word phrases match whole word sequences', () => {
    expect(matchPhrase('zelin ergen tololt 12', 'zelin ergen tololt', false)).toBe('EXACT');
    expect(matchPhrase('zelin ergen tololtiin', 'zelin ergen tololt', true)).toBe('PREFIX');
    expect(matchPhrase('zelin tolbor ergen tololt', 'zelin ergen tololt', true)).toBeNull();
  });
});

describe('lastWordLength', () => {
  it('measures the last word of a key phrase', () => {
    expect(lastWordLength('tsalin')).toBe(6);
    expect(lastWordLength('sarin tsalin')).toBe(6);
    expect(lastWordLength('g mobile')).toBe(6);
    expect(lastWordLength('us')).toBe(2);
  });
});

describe('normalize', () => {
  it('matchKey is empty-safe and length-capped', () => {
    expect(matchKey(null)).toBe('');
    expect(matchKey(undefined)).toBe('');
    expect(matchKey('')).toBe('');
    expect(matchKey('Цалин')).toBe('tsalin');
    expect(matchKey('a'.repeat(50), 10)).toBe(matchKey('a'.repeat(10)));
  });

  it('prepareTxn builds one haystack with a field separator and the normalized counterparty account', () => {
    const p = prepareTxn(makeTxn({ key: 'k', description: 'Цалин', counterpartyName: 'Номин ХХК', counterpartyAccount: '5011-234 567' }));
    expect(p.haystack).toBe('tsalin|nomin hk');
    expect(p.account).toBe('5011234567');
    expect(prepareTxn(makeTxn({ key: 'k' })).account).toBe('');
  });

  it('rawTextOf keeps the original script, normalizes whitespace and is computed once', () => {
    const p = prepareTxn(makeTxn({ key: 'k', description: '  Цалин \n 2026  ', counterpartyName: 'Бат' }));
    expect(rawTextOf(p)).toBe('Цалин 2026 | Бат');
    p.rawText = 'cached';
    expect(rawTextOf(p)).toBe('cached');
  });
});
