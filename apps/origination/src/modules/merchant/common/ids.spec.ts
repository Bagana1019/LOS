import { describe, expect, it } from 'vitest';
import { IdGenerator } from '../ports';
import { CROCKFORD_ALPHABET, CryptoIdGenerator } from './ids';

describe('CryptoIdGenerator', () => {
  const gen = new CryptoIdGenerator();
  it('is an IdGenerator producing v4 uuids', () => {
    expect(gen).toBeInstanceOf(IdGenerator);
    expect(gen.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(gen.uuid()).not.toBe(gen.uuid());
  });
  it('leaseSuffix is 6 Crockford base32 characters without ambiguous letters', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (let i = 0; i < 500; i++) expect(gen.leaseSuffix()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
    expect(new Set(Array.from({ length: 200 }, () => gen.leaseSuffix())).size).toBeGreaterThan(190);
  });
});
