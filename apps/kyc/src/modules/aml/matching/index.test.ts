import { describe, expect, it } from 'vitest';
import { DEFAULT_AML_POLICY } from '@los/contracts';
import * as matching from './index';

const { reviewThreshold, strongThreshold } = DEFAULT_AML_POLICY;

describe('matching public API', () => {
  it('exports exactly the documented functions', () => {
    expect(Object.keys(matching).sort()).toEqual([
      'bestNameMatch', 'bestPreparedMatch', 'jaroWinkler', 'nameSimilarity', 'normalizeName', 'normalizeNameForms', 'prepareName', 'tokenize',
    ]);
  });

  it('normalizeName and tokenize work together through the barrel', () => {
    expect(matching.tokenize(matching.normalizeName('Бат-Эрдэнэ  Ганболд'))).toEqual(['bat', 'erdene', 'ganbold']);
  });

  it('screens a Mongolian customer (with a Latin alias) against transliterated sanctions names', () => {
    const subject = ['Бат-Эрдэнэ Ганболд', 'Bat-Erdene Ganbold'];
    const hit = matching.bestNameMatch(subject, ['Bat Erdene Ganbold', 'B. E. Ganbold']);
    expect(hit?.score).toBeGreaterThanOrEqual(strongThreshold);
    expect(hit?.candidateName).toBe('Bat Erdene Ganbold');
  });

  it('screens a Russian-script sanctions entry against a Latin customer name', () => {
    const hit = matching.bestNameMatch(['Artak Levonovich Velmonov'], ['Велмонов Артак Левонович']);
    expect(hit?.score).toBeGreaterThanOrEqual(strongThreshold);
  });

  it('does not flag a customer whose name only shares a given name with a sanctioned party', () => {
    const hit = matching.bestNameMatch(['Ганболд Дорж'], ['Ganbold Batbayar Erdenebat', 'Dorj Sukhbaatar']);
    expect(hit).not.toBeNull();
    expect(hit?.score).toBeLessThan(reviewThreshold);
  });
});
