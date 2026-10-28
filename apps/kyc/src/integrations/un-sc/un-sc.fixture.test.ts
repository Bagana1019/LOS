import { describe, expect, it } from 'vitest';
import { UN_SC_FIXTURE } from './un-sc.fixture';

const { entries } = UN_SC_FIXTURE;

describe('UN_SC_FIXTURE', () => {
  it('has a stable version, an ISO publishedAt and at least 8 entries', () => {
    expect(UN_SC_FIXTURE.version).toBe('mock-2026-10');
    expect(new Date(UN_SC_FIXTURE.publishedAt).toISOString()).toBe(UN_SC_FIXTURE.publishedAt);
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  it('uses unique FIXTURE-UN- refIds', () => {
    const ids = entries.map((e) => e.refId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^FIXTURE-UN-\d{3}$/);
  });

  it('puts the single PRIMARY name first on every entry', () => {
    for (const e of entries) {
      expect(e.names[0]?.quality).toBe('PRIMARY');
      expect(e.names.filter((n) => n.quality === 'PRIMARY')).toHaveLength(1);
    }
  });

  it('has an individual with GOOD_ALIAS and LOW_ALIAS and both date-of-birth forms', () => {
    const multi = entries.find((e) => e.type === 'INDIVIDUAL' && e.names.some((n) => n.quality === 'GOOD_ALIAS') && e.names.some((n) => n.quality === 'LOW_ALIAS'));
    expect(multi).toBeDefined();
    expect(multi?.datesOfBirth.some((d) => /^\d{4}$/.test(d))).toBe(true);
    expect(multi?.datesOfBirth.some((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(multi?.nationalities.length).toBeGreaterThan(0);
    expect(multi?.identifiers.some((i) => i.type === 'Passport')).toBe(true);
  });

  it('keeps dates of birth, nationalities and listedOn in the documented formats', () => {
    for (const e of entries) {
      for (const d of e.datesOfBirth) expect(d).toMatch(/^\d{4}(-\d{2}-\d{2})?$/);
      for (const n of e.nationalities) expect(n).toMatch(/^[A-Z]{2}$/);
      expect(e.listedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('includes a Cyrillic-script individual and an entity', () => {
    expect(entries.some((e) => e.type === 'INDIVIDUAL' && /\p{Script=Cyrillic}/u.test(e.names[0]?.value ?? ''))).toBe(true);
    expect(entries.some((e) => e.type === 'ENTITY')).toBe(true);
  });

  it('includes a Mongolian-format national id for exact register matching', () => {
    const hit = entries.flatMap((e) => e.identifiers.map((i) => ({ e, i }))).find(({ i }) => i.type === 'National Identification Number' && i.country === 'MN');
    expect(hit?.i.value).toBe('ЖЖ99999999');
    expect(hit?.e.type).toBe('INDIVIDUAL');
  });

  it('includes an entity with the 7-digit company register 9999999', () => {
    const hit = entries.find((e) => e.type === 'ENTITY' && e.identifiers.some((i) => i.value === '9999999' && i.country === 'MN'));
    expect(hit).toBeDefined();
  });

  it('is plain data that survives structuredClone', () => {
    expect(structuredClone(UN_SC_FIXTURE)).toEqual(UN_SC_FIXTURE);
  });
});
