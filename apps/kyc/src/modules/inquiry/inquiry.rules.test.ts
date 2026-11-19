import { describe, expect, it } from 'vitest';
import { INQUIRY_SOURCES } from '@los/contracts';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../../integrations/errors';
import { InquiryRejectedError, InquiryUnavailableError } from '../../integrations/inquiry/inquiry.provider';
import { blacklistInquiry, creditHistoryFrom, expiresAt, inquiryFailureFrom, latestPerSource } from './inquiry.rules';

const rec = (customerId: string, source: (typeof INQUIRY_SOURCES)[number], fetchedAt: string, summary: Record<string, unknown> = {}) => ({ customerId, source, fetchedAt, summary });

// Provider-ийн алдаа → эх сурвалж тус бүрийн failure (бусад эх сурвалжийг үргэлжлүүлнэ); танигдаагүй алдаа → null (дуудагч шиднэ).
describe('inquiryFailureFrom', () => {
  it('түр ажиллахгүй → INQUIRY_UNAVAILABLE (мессежийг хадгална)', () => {
    expect(inquiryFailureFrom('CIB', new InquiryUnavailableError('CIB', 'CIB түр ажиллахгүй'))).toEqual({ source: 'CIB', code: 'INQUIRY_UNAVAILABLE', message: 'CIB түр ажиллахгүй' });
  });
  it('vendor татгалзсан → INQUIRY_REJECTED', () => {
    expect(inquiryFailureFrom('CIB', new InquiryRejectedError('CIB', 'SR0260', 'CIB: vendor татгалзлаа [SR0260]'))).toEqual({ source: 'CIB', code: 'INQUIRY_REJECTED', message: 'CIB: vendor татгалзлаа [SR0260]' });
  });
  it('холбоо барих мэдээлэл дутуу → CONTACT_REQUIRED (хэрэглэгч засах боломжтой тул тусдаа код)', () => {
    expect(inquiryFailureFrom('CIB', new InquiryRejectedError('CIB', 'CONTACT_REQUIRED', 'утас, имэйл шаардлагатай'))).toMatchObject({ code: 'CONTACT_REQUIRED' });
  });
  it('бодит холболт хэрэгжээгүй → INTEGRATION_NOT_IMPLEMENTED', () => {
    expect(inquiryFailureFrom('FICO', new IntegrationNotImplementedError('inquiry:FICO'))).toEqual({ source: 'FICO', code: 'INTEGRATION_NOT_IMPLEMENTED', message: 'Бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)' });
  });
  it('тохиргоо дутуу → INTEGRATION_NOT_CONFIGURED; мессежэд env-ийн нэр гарахгүй', () => {
    const f = inquiryFailureFrom('CIB', new IntegrationNotConfiguredError('sainscore', ['SAINSCORE_PASSWORD_HASH']));
    expect(f).toMatchObject({ source: 'CIB', code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(f!.message).not.toContain('SAINSCORE');
  });
  it.each([[new Error('boom')], [null], ['x']])('танигдаагүй алдаа %j → null', (e) => {
    expect(inquiryFailureFrom('CIB', e)).toBeNull();
  });
});

describe('expiresAt (FR-3.5)', () => {
  it('adds stale days', () => {
    expect(expiresAt(new Date('2026-11-01T00:00:00Z'), 30).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('blacklistInquiry (FR-3.4, BR-9)', () => {
  it('a hit is a RED warning with deduplicated reason codes — never a block', () => {
    const r = blacklistInquiry({ hit: true, reasons: [{ reasonCode: 'FRAUD', listType: 'INTERNAL' }, { reasonCode: 'FRAUD', listType: 'INTERNAL' }, { reasonCode: 'NPL', listType: 'INTERNAL' }] });
    expect(r.warningLevel).toBe('RED');
    expect(r.summary).toEqual({ hit: true, reason_codes: ['FRAUD', 'NPL'] });
  });
  it('no hit is clean', () => {
    expect(blacklistInquiry({ hit: false, reasons: [] })).toMatchObject({ warningLevel: 'NONE', summary: { hit: false, reason_codes: [] } });
  });
});

describe('latestPerSource', () => {
  it('keeps the newest row per (customer, source) in a stable customer/source order', () => {
    const rows = [
      rec('c2', 'FICO', '2026-11-01T00:00:00Z'), rec('c1', 'FICO', '2026-10-01T00:00:00Z'), rec('c1', 'FICO', '2026-11-02T00:00:00Z', { v: 2 }),
      rec('c1', 'CIB', '2026-10-30T00:00:00Z'), rec('c1', 'CIB', '2026-10-01T00:00:00Z'),
    ];
    const out = latestPerSource(rows);
    expect(out.map((r) => `${r.customerId}:${r.source}`)).toEqual(['c1:CIB', 'c1:FICO', 'c2:FICO']);
    expect(out[1]!.summary).toEqual({ v: 2 });
  });
});

describe('creditHistoryFrom (monthly payment for underwriting)', () => {
  const cib = rec('c1', 'CIB', 't', { active_loan_count: 2, monthly_payment: 500_000, overdue_months: 1 });
  const fico = rec('c1', 'FICO', 't', { fico_score: 701 });
  it('exposes the active-loan monthly payment from CIB plus unregistered loans', () => {
    expect(creditHistoryFrom([cib, fico], [{ monthlyPayment: 120_000.5 }])).toEqual({ ficoScore: 701, activeLoanCount: 2, overdueHistoryMonths: 1, existingDebtServiceMonthly: 620_000.5 });
  });
  it('nothing fetched → unknown (null), never a made-up value', () => {
    expect(creditHistoryFrom([], [])).toEqual({ ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: null });
  });
  it('only unregistered loans → the known lower bound', () => {
    expect(creditHistoryFrom([], [{ monthlyPayment: 90_000 }, { monthlyPayment: 10_000 }])).toMatchObject({ activeLoanCount: null, existingDebtServiceMonthly: 100_000 });
  });
  it('CIB with zero payment and no unregistered loans → 0, not null', () => {
    expect(creditHistoryFrom([rec('c1', 'CIB', 't', { monthly_payment: 0, active_loan_count: 0 })], []).existingDebtServiceMonthly).toBe(0);
  });
  it('ignores non-numeric summary values', () => {
    expect(creditHistoryFrom([rec('c1', 'CIB', 't', { monthly_payment: 'x' }), rec('c1', 'FICO', 't', { fico_score: Number.NaN })], [])).toEqual({ ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: null });
  });
});
