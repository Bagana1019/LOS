import { describe, expect, it } from 'vitest';
import { createCoreLoanPort } from './core-loan.provider';
import { CoreLoanError, type OpenLoanRequest } from './core-loan.port';

const req = (accountNo = '5012345678'): OpenLoanRequest => ({ idempotencyKey: 'd-1', applicationId: 'a', contractNo: 'C-1', customerId: 'c', amount: 1, currency: 'MNT', termMonths: 12, interestRate: 20, repaymentType: 'ANNUITY', disburseDate: '2026-11-03', firstPaymentDate: null, account: { bankCode: 'KHAN', accountNo, holderName: 'X' } });

describe('core-loan integration', () => {
  it('mock is deterministic and idempotent per key', async () => {
    const p = createCoreLoanPort({ INTEGRATION_MODE: 'mock' });
    const a = await p.openLoan(req());
    expect(a.coreLoanId).toMatch(/^CL-[0-9A-F]{10}$/);
    expect((await p.openLoan(req())).coreLoanId).toBe(a.coreLoanId);
  });
  it('mock rejects the demo failing account', async () => {
    await expect(createCoreLoanPort({}).openLoan(req('5000000000'))).rejects.toBeInstanceOf(CoreLoanError);
  });
  it('real mode fails closed without config and when not implemented', async () => {
    const p = createCoreLoanPort({ INTEGRATION_MODE: 'real' });
    await expect(p.openLoan(req())).rejects.toThrow(/CORE_LOAN_API_URL/);
    await expect(createCoreLoanPort({ INTEGRATION_MODE: 'real' } as never).openLoan(req())).rejects.toBeTruthy();
  });
});
