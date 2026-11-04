import { describe, expect, it } from 'vitest';
import { InquirySource } from '@los/contracts';
import { hasMessage } from '../../lib/i18n';
import { detailView, fieldLabel, formatDetailValue, statusColor, summaryLines, warningColor } from './inquiry.utils';

describe('summaryLines', () => {
  it('a missing inquiry has no summary', () => {
    expect(summaryLines({ source: 'CIB', status: 'MISSING', summary: {} })).toEqual([]);
  });
  it('CIB shows active loans, the monthly payment and the outstanding balance', () => {
    const lines = summaryLines({ source: 'CIB', status: 'FRESH', summary: { active_loan_count: 2, monthly_payment: 600_000, outstanding: 3_000_000 } });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('2');
    expect(lines[1]).toContain('600');
  });
  it('every source renders something for a fetched row (including the empty/negative cases)', () => {
    for (const source of InquirySource) {
      expect(summaryLines({ source, status: 'FRESH', summary: {} }).length, source).toBeGreaterThan(0);
      expect(summaryLines({ source, status: 'STALE', summary: { has_record: true, has_debt: true, is_pensioner: true, hit: true } }).length, source).toBeGreaterThan(0);
    }
  });
  it('a hit on the blacklist and a court debt are spelled out', () => {
    expect(summaryLines({ source: 'BLACKLIST', status: 'FRESH', summary: { hit: true } })[0]).toContain('Хар жагсаалтад байна');
    expect(summaryLines({ source: 'XYP_COURT_DEBT', status: 'FRESH', summary: { has_debt: true, total_amount: 1_500_000 } })[0]).toContain('Өртэй');
  });
});

describe('colors and i18n', () => {
  it('stale is yellow, red warning is red', () => {
    expect(statusColor('STALE')).toBe('warning');
    expect(statusColor('FRESH')).toBe('success');
    expect(statusColor('MISSING')).toBe('default');
    expect(warningColor('RED')).toBe('error');
    expect(warningColor('WARNING')).toBe('warning');
    expect(warningColor('NONE')).toBe('default');
  });
  it('every enum-driven i18n key exists', () => {
    for (const s of InquirySource) expect(hasMessage(`inquiry.source.${s}`), s).toBe(true);
    for (const k of ['MISSING', 'FRESH', 'STALE']) expect(hasMessage(`inquiry.status.${k}`), k).toBe(true);
    for (const k of ['NONE', 'WARNING', 'RED']) expect(hasMessage(`inquiry.warning.${k}`), k).toBe(true);
    for (const k of ['PRIMARY', 'CO_BORROWER', 'GUARANTOR']) expect(hasMessage(`inquiry.role.${k}`), k).toBe(true);
    for (const k of ['INQUIRY_MISSING', 'INQUIRY_STALE', 'NO_BORROWER']) expect(hasMessage(`inquiry.step.reason.${k}`), k).toBe(true);
    for (const k of ['INCOME_MISSING', 'NO_PRIMARY_BORROWER']) expect(hasMessage(`income.step.reason.${k}`), k).toBe(true);
    for (const k of ['RENT', 'PENSION', 'OTHER']) expect(hasMessage(`income.manual.type.${k}`), k).toBe(true);
    for (const k of ['NDSH', 'MANUAL']) expect(hasMessage(`income.salary.source.${k}`), k).toBe(true);
  });
});

describe('detailView', () => {
  it('splits scalars, nested objects and arrays into fields and tables', () => {
    const v = detailView({ score: 700, band: 'GOOD', loans: [{ lender: 'A', outstanding: 5 }, { lender: 'B', monthlyPayment: 7 }], nested: { x: true }, empty: [] });
    expect(v.fields).toEqual([{ key: 'score', value: 700 }, { key: 'band', value: 'GOOD' }, { key: 'nested.x', value: true }]);
    expect(v.tables).toHaveLength(1);
    expect(v.tables[0]!.columns).toEqual(['lender', 'outstanding', 'monthlyPayment']);
  });
  it('null detail is empty; labels fall back to the key; money keys format as MNT', () => {
    expect(detailView(null)).toEqual({ fields: [], tables: [] });
    expect(fieldLabel('unknownKey')).toBe('unknownKey');
    expect(fieldLabel('lender')).not.toBe('lender');
    expect(formatDetailValue('outstanding', 1000)).toContain('₮');
    expect(formatDetailValue('areaM2', 55)).not.toContain('₮');
    expect(formatDetailValue('x', null)).toBe('—');
  });
});
