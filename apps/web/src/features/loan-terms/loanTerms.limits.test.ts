import { describe, expect, it } from 'vitest';
import { SaveLoanTermsRequest } from '@los/contracts';

const base = { productId: 'p1', amount: 500000, termMonths: 12, purpose: 'x' };
describe('loan terms digit limits', () => {
  it('accepts 10-digit amount', () => expect(SaveLoanTermsRequest.safeParse({ ...base, amount: 9_999_999_999 }).success).toBe(true));
  it('rejects 11-digit amount', () => expect(SaveLoanTermsRequest.safeParse({ ...base, amount: 10_000_000_000 }).success).toBe(false));
  it('rejects 3 decimals', () => expect(SaveLoanTermsRequest.safeParse({ ...base, amount: 100.123 }).success).toBe(false));
  it('rejects 11-digit downPayment', () => expect(SaveLoanTermsRequest.safeParse({ ...base, downPayment: 1e10 }).success).toBe(false));
});
