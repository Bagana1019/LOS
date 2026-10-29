import { FatfCategory } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { FATF_FIXTURE } from './fatf.fixture';

const { entries } = FATF_FIXTURE;
const byCode = (code: string) => entries.find((e) => e.countryCode === code);

describe('FATF_FIXTURE', () => {
  it('has a stable version and an ISO publishedAt', () => {
    expect(FATF_FIXTURE.version).toBe('mock-2026-10');
    expect(new Date(FATF_FIXTURE.publishedAt).toISOString()).toBe(FATF_FIXTURE.publishedAt);
  });

  it('uses unique upper-case ISO alpha-2 codes and valid categories', () => {
    const codes = entries.map((e) => e.countryCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const e of entries) {
      expect(e.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(e.countryName.length).toBeGreaterThan(0);
      expect(FatfCategory).toContain(e.category);
      expect(e.listedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('lists KP, IR and MM as CALL_FOR_ACTION', () => {
    for (const code of ['KP', 'IR', 'MM']) expect(byCode(code)?.category).toBe('CALL_FOR_ACTION');
  });

  it('has a handful of INCREASED_MONITORING countries', () => {
    expect(entries.filter((e) => e.category === 'INCREASED_MONITORING').length).toBeGreaterThanOrEqual(3);
  });

  it('does not include Mongolia', () => {
    expect(byCode('MN')).toBeUndefined();
  });

  it('is plain data that survives structuredClone', () => {
    expect(structuredClone(FATF_FIXTURE)).toEqual(FATF_FIXTURE);
  });
});
