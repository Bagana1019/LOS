import type { EncumbranceSourceResult } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { EncumbranceIncompleteError, combineEncumbranceStatus, normalizeEncumbranceIdentifier, sortSources } from './encumbrance.rules';

const src = (source: 'ZMS' | 'EB', status: EncumbranceSourceResult['status'], over: Partial<EncumbranceSourceResult> = {}): EncumbranceSourceResult => ({
  source, status, pledgee: null, registeredAt: null, note: null, ...over,
});

describe('combineEncumbranceStatus (FR-6.6): DISPUTED > ENCUMBERED > CLEAR', () => {
  it('both sources clear → CLEAR', () => {
    expect(combineEncumbranceStatus([src('ZMS', 'CLEAR'), src('EB', 'CLEAR')])).toBe('CLEAR');
  });

  it('any ENCUMBERED → ENCUMBERED, from either source', () => {
    expect(combineEncumbranceStatus([src('ZMS', 'ENCUMBERED'), src('EB', 'CLEAR')])).toBe('ENCUMBERED');
    expect(combineEncumbranceStatus([src('ZMS', 'CLEAR'), src('EB', 'ENCUMBERED')])).toBe('ENCUMBERED');
  });

  it('any DISPUTED wins over ENCUMBERED and CLEAR', () => {
    expect(combineEncumbranceStatus([src('ZMS', 'ENCUMBERED'), src('EB', 'DISPUTED')])).toBe('DISPUTED');
    expect(combineEncumbranceStatus([src('ZMS', 'DISPUTED'), src('EB', 'ENCUMBERED')])).toBe('DISPUTED');
    expect(combineEncumbranceStatus([src('ZMS', 'CLEAR'), src('EB', 'DISPUTED')])).toBe('DISPUTED');
  });

  it('several rows of one source (several pledges) are all considered', () => {
    expect(combineEncumbranceStatus([src('ZMS', 'CLEAR'), src('ZMS', 'ENCUMBERED'), src('EB', 'CLEAR')])).toBe('ENCUMBERED');
  });

  it('NOT_APPLICABLE from one source does not hide the other source', () => {
    expect(combineEncumbranceStatus([src('ZMS', 'NOT_APPLICABLE'), src('EB', 'CLEAR')])).toBe('CLEAR');
    expect(combineEncumbranceStatus([src('ZMS', 'NOT_APPLICABLE'), src('EB', 'ENCUMBERED')])).toBe('ENCUMBERED');
  });

  it('fails closed: a missing source, an empty list, or nothing actually checked is never CLEAR', () => {
    expect(() => combineEncumbranceStatus([])).toThrow(EncumbranceIncompleteError);
    expect(() => combineEncumbranceStatus([src('ZMS', 'CLEAR')])).toThrow(EncumbranceIncompleteError);
    expect(() => combineEncumbranceStatus([src('EB', 'CLEAR')])).toThrow(EncumbranceIncompleteError);
    expect(() => combineEncumbranceStatus([src('ZMS', 'NOT_APPLICABLE'), src('EB', 'NOT_APPLICABLE')])).toThrow(EncumbranceIncompleteError);
    // нэг эх сурвалж хариулаагүй бол нөгөө нь "ачаалалтай" гэсэн ч хэсэгчилсэн хариу буцаахгүй
    expect(() => combineEncumbranceStatus([src('ZMS', 'ENCUMBERED')])).toThrow(EncumbranceIncompleteError);
  });
});

describe('normalizeEncumbranceIdentifier', () => {
  it('vehicle plates: spaces and dashes removed, upper-cased', () => {
    expect(normalizeEncumbranceIdentifier('VEHICLE', ' 1234-уба ')).toBe('1234УБА');
    expect(normalizeEncumbranceIdentifier('VEHICLE', 'уен 5246')).toBe('УЕН5246');
  });

  it('other assets: trimmed and upper-cased (mn), inner characters kept', () => {
    expect(normalizeEncumbranceIdentifier('APARTMENT', ' mock-уб90010112-1 ')).toBe('MOCK-УБ90010112-1');
    expect(normalizeEncumbranceIdentifier('EQUIPMENT', 'sn 12-ab')).toBe('SN 12-AB');
  });

  it('null when nothing is left', () => {
    expect(normalizeEncumbranceIdentifier('VEHICLE', ' - _ ')).toBeNull();
    expect(normalizeEncumbranceIdentifier('LAND', '   ')).toBeNull();
  });
});

describe('sortSources', () => {
  it('ЗМС first, then ЭБ, keeping the order within a source', () => {
    const out = sortSources([src('EB', 'CLEAR'), src('ZMS', 'ENCUMBERED', { pledgee: 'A' }), src('ZMS', 'CLEAR', { pledgee: 'B' })]);
    expect(out.map((s) => `${s.source}:${s.pledgee ?? '-'}`)).toEqual(['ZMS:A', 'ZMS:B', 'EB:-']);
  });
});
