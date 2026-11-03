import { describe, expect, it } from 'vitest';
import { INQUIRY_SOURCES } from '@los/contracts';
import { createInquiryProvider } from './inquiry-integration.module';
import { InquiryUnavailableError } from './inquiry.provider';
import { MockInquiryProvider, OVERDUE_REGISTER, UNAVAILABLE_REGISTER } from './mock-inquiry.provider';
import { RealInquiryProvider } from './real-inquiry.provider';
import { IntegrationNotImplementedError } from '../errors';

const external = INQUIRY_SOURCES.filter((s) => s !== 'BLACKLIST');
const p = new MockInquiryProvider();

describe('MockInquiryProvider (DEMO, deterministic)', () => {
  it('the same register always yields the same answer for every one of the 10 external sources', async () => {
    expect(external).toHaveLength(10);
    for (const s of external) expect(await p.fetch(s, 'УБ90010112')).toEqual(await new MockInquiryProvider().fetch(s, 'УБ90010112'));
  });

  it('CIB summary exposes the active-loan monthly payment and the loan counts', async () => {
    for (let i = 0; i < 60; i++) {
      const { summary, detail } = await p.fetch('CIB', `УБ${String(90010000 + i)}`);
      for (const k of ['active_loan_count', 'total_disbursed', 'outstanding', 'monthly_payment']) expect(typeof summary[k]).toBe('number');
      const loans = (detail.loans as Array<{ status: string; monthlyPayment: number }>).filter((l) => l.status === 'ACTIVE');
      expect(loans).toHaveLength(summary.active_loan_count as number);
      expect(loans.reduce((s, l) => s + l.monthlyPayment, 0)).toBe(summary.monthly_payment);
      if (summary.active_loan_count === 0) expect(summary.monthly_payment).toBe(0);
    }
  });

  it('the overdue fixture register is a WARNING with 2 active loans; FICO/DTI/others have the documented keys', async () => {
    const overdue = await p.fetch('CIB', `УБ${OVERDUE_REGISTER.source.replace('$', '')}`);
    expect(overdue.warningLevel).toBe('WARNING');
    expect(overdue.summary).toMatchObject({ active_loan_count: 2, monthly_payment: 600_000, overdue_months: 2 });
    const fico = (await p.fetch('FICO', 'УБ90010112')).summary.fico_score as number;
    expect(fico).toBeGreaterThanOrEqual(520);
    expect(fico).toBeLessThanOrEqual(819);
    expect((await p.fetch('DTI', 'УБ90010112')).summary.dti).toBeGreaterThan(0);
    expect(await p.fetch('LIVESTOCK', 'УБ90010112')).toHaveProperty('summary.total_heads');
    expect(await p.fetch('XYP_PENSION', 'УБ90010112')).toHaveProperty('summary.is_pensioner');
  });

  it('criminal / court-debt records are warnings; the mix over many registers covers both outcomes', async () => {
    const seen = { crim: new Set<string>(), court: new Set<string>() };
    for (let i = 0; i < 400; i++) {
      const reg = `УБ${String(10000000 + i * 37)}`;
      seen.crim.add((await p.fetch('XYP_CRIMINAL', reg)).warningLevel);
      seen.court.add((await p.fetch('XYP_COURT_DEBT', reg)).warningLevel);
    }
    expect([...seen.crim].sort()).toEqual(['NONE', 'WARNING']);
    expect([...seen.court].sort()).toEqual(['NONE', 'WARNING']);
  });

  it('property / vehicle / legal sources return count + items for many registers', async () => {
    for (let i = 0; i < 30; i++) {
      const reg = `УБ${String(20000000 + i)}`;
      for (const s of ['XYP_PROPERTY', 'XYP_VEHICLE', 'XYP_LEGAL'] as const) {
        const r = await p.fetch(s, reg);
        expect((r.detail.items as unknown[]).length).toBe(r.summary.count);
      }
    }
  });

  it('the unavailable fixture register throws InquiryUnavailableError', async () => {
    await expect(p.fetch('CIB', `УБ${UNAVAILABLE_REGISTER.source.replace('$', '')}`)).rejects.toBeInstanceOf(InquiryUnavailableError);
  });
});

describe('createInquiryProvider · INTEGRATION_MODE', () => {
  it('mock by default, real on request; real fails closed', async () => {
    expect(createInquiryProvider({})).toBeInstanceOf(MockInquiryProvider);
    expect(createInquiryProvider({ INTEGRATION_MODE: 'mock' })).toBeInstanceOf(MockInquiryProvider);
    const real = createInquiryProvider({ INTEGRATION_MODE: 'real' });
    expect(real).toBeInstanceOf(RealInquiryProvider);
    await expect(real.fetch('CIB', 'УБ90010112')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });
});
