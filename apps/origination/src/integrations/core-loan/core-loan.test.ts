import { describe, expect, it } from 'vitest';
import { createCoreLoanPort } from './core-loan.provider';
import { CoreLoanError, type OpenLoanRequest } from './core-loan.port';
import { MockCoreLoanPort } from './core-loan.mock';

const req = (accountNo = '5012345678'): OpenLoanRequest => ({ idempotencyKey: 'd-1', applicationId: 'a', contractNo: 'C-1', customerId: 'c', amount: 1, currency: 'MNT', termMonths: 12, interestRate: 20, repaymentType: 'ANNUITY', disburseDate: '2026-11-03', firstPaymentDate: null, account: { bankCode: 'KHAN', accountNo, holderName: 'X' } });

describe('core-loan integration', () => {
  it('H1 test hook: delayed open times out, is invisible to findLoan until flushed, then the same key yields one loan', async () => {
    const m = new MockCoreLoanPort();
    m.delayOpens = true;
    await expect(m.openLoan(req())).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' });
    expect(await m.findLoan('d-1')).toBeNull();
    m.flushLateOpens();
    const found = await m.findLoan('d-1');
    expect(found?.coreLoanId).toMatch(/^CL-/);
    expect((await m.openLoan(req())).coreLoanId).toBe(found!.coreLoanId);
  });
  it('mock is deterministic and idempotent per key', async () => {
    const p = createCoreLoanPort({ INTEGRATION_MODE: 'mock' });
    const a = await p.openLoan(req());
    expect(a.coreLoanId).toMatch(/^CL-[0-9A-F]{10}$/);
    expect((await p.openLoan(req())).coreLoanId).toBe(a.coreLoanId);
  });
  it('H1: mock lookup by reference returns null before open and the same loan after (no second account)', async () => {
    const p = createCoreLoanPort({ INTEGRATION_MODE: 'mock' });
    expect(await p.findLoan('d-1')).toBeNull();
    const opened = await p.openLoan(req());
    expect(await p.findLoan('d-1')).toEqual(opened);
    expect(await p.findLoan('other')).toBeNull();
  });
  it('H1: rejected open leaves nothing to find', async () => {
    const p = createCoreLoanPort({});
    await expect(p.openLoan(req('5000000000'))).rejects.toBeInstanceOf(CoreLoanError);
    expect(await p.findLoan('d-1')).toBeNull();
  });
  it('mock rejects the demo failing account', async () => {
    await expect(createCoreLoanPort({}).openLoan(req('5000000000'))).rejects.toBeInstanceOf(CoreLoanError);
  });
  it('real mode fails closed without config and when not implemented', async () => {
    const p = createCoreLoanPort({ INTEGRATION_MODE: 'real' });
    await expect(p.openLoan(req())).rejects.toThrow(/CORE_LOAN_API_URL/);
    await expect(createCoreLoanPort({ INTEGRATION_MODE: 'real' } as never).openLoan(req())).rejects.toBeTruthy();
    await expect(p.findLoan('d-1')).rejects.toThrow(/CORE_LOAN_API_URL/);
    const configured = createCoreLoanPort({ INTEGRATION_MODE: 'real', CORE_LOAN_API_URL: 'http://core', CORE_LOAN_API_KEY: 'k' });
    await expect(configured.findLoan('d-1')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});
