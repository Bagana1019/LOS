import { describe, expect, it } from 'vitest';
import { INQUIRY_SOURCES, type InquiryRecord } from '@los/contracts';
import { buildBorrowerView, expiryOf, inquiryStatus, inquiryStepTarget, type Participant } from './inquiry.rules';

const NOW = new Date('2026-11-03T00:00:00Z');
const p: Participant = { customerId: 'c1', role: 'PRIMARY', displayName: 'Овог Нэр', registerNoMasked: 'УБ****0112' };
const rec = (source: InquiryRecord['source'], fetchedAt: string, summary: Record<string, unknown> = {}, customerId = 'c1'): InquiryRecord =>
  ({ id: `${customerId}-${source}`, applicationId: 'a', customerId, source, fetchedAt, fetchedBy: null, expiresAt: null, warningLevel: 'NONE', summary, detail: null });
const all = (fetchedAt: string) => INQUIRY_SOURCES.map((s) => rec(s, fetchedAt));

describe('inquiryStatus (FR-3.5)', () => {
  const fetched = new Date('2026-10-04T00:00:00Z'); // 30 хоногийн дараа = 2026-11-03T00:00Z
  it('MISSING / FRESH / STALE; the boundary instant is still fresh', () => {
    expect(inquiryStatus(null, 30, NOW)).toBe('MISSING');
    expect(expiryOf(fetched, 30).toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(inquiryStatus(fetched, 30, NOW)).toBe('FRESH');
    expect(inquiryStatus(fetched, 30, new Date(NOW.getTime() + 1))).toBe('STALE');
    expect(inquiryStatus(fetched, 10, NOW)).toBe('STALE'); // admin босгыг багасгавал шууд үйлчилнэ
  });
});

describe('buildBorrowerView', () => {
  it('a borrower with nothing fetched is incomplete and lists all 11 missing', () => {
    const v = buildBorrowerView(p, [], [], 30, NOW);
    expect(v.complete).toBe(false);
    expect(v.missing).toHaveLength(11);
    expect(v.items.map((i) => i.source)).toEqual([...INQUIRY_SOURCES]);
    expect(v.monthlyDebtPayment).toBe(0);
  });
  it('11 fresh inquiries → complete; the CIB monthly payment and unregistered loans sum into the monthly debt payment', () => {
    const recs = [...all('2026-11-01T00:00:00Z').filter((r) => r.source !== 'CIB'), rec('CIB', '2026-11-01T00:00:00Z', { monthly_payment: 500_000 })];
    const loans = [{ id: 'l1', customerId: 'c1', lenderName: 'x', amount: 1, monthlyPayment: 100_000.25, note: null }, { id: 'l2', customerId: 'other', lenderName: 'y', amount: 1, monthlyPayment: 9_000_000, note: null }];
    const v = buildBorrowerView(p, recs, loans, 30, NOW);
    expect(v.complete).toBe(true);
    expect(v.hasStale).toBe(false);
    expect(v.unregisteredLoans).toHaveLength(1);
    expect(v.monthlyDebtPayment).toBe(600_000.25);
  });
  it('one stale inquiry makes the borrower incomplete (yellow) but not missing; other customers rows are ignored', () => {
    const recs = [...all('2026-11-01T00:00:00Z').filter((r) => r.source !== 'FICO'), rec('FICO', '2026-08-01T00:00:00Z'), rec('CIB', '2026-11-01T00:00:00Z', {}, 'someone-else')];
    const v = buildBorrowerView(p, recs, [], 30, NOW);
    expect(v).toMatchObject({ complete: false, hasStale: true, missing: [] });
    expect(v.items.find((i) => i.source === 'FICO')!.status).toBe('STALE');
    expect(v.items.find((i) => i.source === 'FICO')!.expiresAt).toBe('2026-08-31T00:00:00.000Z');
  });
  it('a non-numeric CIB payment counts as zero', () => {
    const v = buildBorrowerView(p, [rec('CIB', '2026-11-01T00:00:00Z', { monthly_payment: 'x' })], [], 30, NOW);
    expect(v.monthlyDebtPayment).toBe(0);
  });
});

describe('inquiryStepTarget', () => {
  const view = (complete: boolean, missing: number, hasStale: boolean) => ({ complete, missing: INQUIRY_SOURCES.slice(0, missing), hasStale });
  it('no participants → PENDING NO_BORROWER', () => {
    expect(inquiryStepTarget([])).toEqual({ status: 'PENDING', reason: 'NO_BORROWER' });
  });
  it('everyone complete → COMPLETED', () => {
    expect(inquiryStepTarget([view(true, 0, false), view(true, 0, false)])).toEqual({ status: 'COMPLETED', reason: null });
  });
  it('missing outranks stale', () => {
    expect(inquiryStepTarget([view(false, 2, true)])).toEqual({ status: 'PENDING', reason: 'INQUIRY_MISSING' });
    expect(inquiryStepTarget([view(false, 0, true), view(true, 0, false)])).toEqual({ status: 'PENDING', reason: 'INQUIRY_STALE' });
  });
});
