import { describe, expect, it } from 'vitest';
import { IncomeCalculateBody, IncomeExpensesBody, IncomeSalaryInput, InquiryFetchRequest, INQUIRY_SOURCES, UnregisteredLoanInput } from './inquiry';

describe('InquiryFetchRequest', () => {
  it('normalises the register, defaults staleDays to 30 and accepts all 11 sources', () => {
    const r = InquiryFetchRequest.parse({ applicationId: 'a', customerId: 'c', registerNo: 'уб 90010112', sources: [...INQUIRY_SOURCES] });
    expect(r.registerNo).toBe('УБ90010112');
    expect(r.staleDays).toBe(30);
    expect(r.sources).toHaveLength(11);
  });
  it('rejects empty sources, unknown sources and a missing register', () => {
    const base = { applicationId: 'a', customerId: 'c', registerNo: 'УБ90010112' };
    expect(InquiryFetchRequest.safeParse({ ...base, sources: [] }).success).toBe(false);
    expect(InquiryFetchRequest.safeParse({ ...base, sources: ['NOPE'] }).success).toBe(false);
    expect(InquiryFetchRequest.safeParse({ ...base, registerNo: '' }).success).toBe(false);
    expect(InquiryFetchRequest.safeParse({ ...base, staleDays: 0 }).success).toBe(false);
  });
});

describe('InquiryFetchRequest.contact (ЗМС vendor утас, имэйл)', () => {
  const base = { applicationId: 'a', customerId: 'c', registerNo: 'УБ90010112' };
  it('is optional: older callers without contact still parse', () => {
    expect(InquiryFetchRequest.parse(base).contact).toBeUndefined();
  });
  it('trims, and accepts null / empty values (a customer may have no phone or email; the adapter treats blank as missing)', () => {
    expect(InquiryFetchRequest.parse({ ...base, contact: { phone: ' 99112233 ', email: 'a@b.mn' } }).contact).toEqual({ phone: '99112233', email: 'a@b.mn' });
    expect(InquiryFetchRequest.parse({ ...base, contact: { phone: null, email: '' } }).contact).toEqual({ phone: null, email: '' });
    expect(InquiryFetchRequest.parse({ ...base, contact: {} }).contact).toEqual({});
  });
  it('rejects oversized values (no unbounded PII forwarded to the vendor)', () => {
    expect(InquiryFetchRequest.safeParse({ ...base, contact: { phone: '9'.repeat(33) } }).success).toBe(false);
    expect(InquiryFetchRequest.safeParse({ ...base, contact: { email: 'a'.repeat(255) } }).success).toBe(false);
  });
});

describe('income inputs', () => {
  it('period must be YYYY-MM with a real month', () => {
    expect(IncomeCalculateBody.safeParse({ customerId: 'c', periodFrom: '2025-11', periodTo: '2026-10' }).success).toBe(true);
    expect(IncomeCalculateBody.safeParse({ customerId: 'c', periodFrom: '2025-13', periodTo: '2026-10' }).success).toBe(false);
    expect(IncomeCalculateBody.safeParse({ customerId: 'c', periodFrom: '2025-1', periodTo: '2026-10' }).success).toBe(false);
  });
  it('salary must be positive, month 1..12', () => {
    expect(IncomeSalaryInput.safeParse({ customerId: 'c', year: 2026, month: 5, salary: 1 }).success).toBe(true);
    expect(IncomeSalaryInput.safeParse({ customerId: 'c', year: 2026, month: 13, salary: 1 }).success).toBe(false);
    expect(IncomeSalaryInput.safeParse({ customerId: 'c', year: 2026, month: 5, salary: 0 }).success).toBe(false);
  });
  it('expenses need at least one value and cannot be negative', () => {
    expect(IncomeExpensesBody.safeParse({}).success).toBe(false);
    expect(IncomeExpensesBody.safeParse({ householdExpenseMonthly: 0 }).success).toBe(true);
    expect(IncomeExpensesBody.safeParse({ businessExpenseMonthly: -1 }).success).toBe(false);
  });
  it('unregistered loan needs a lender name and non-negative amounts', () => {
    expect(UnregisteredLoanInput.safeParse({ lenderName: 'x', amount: 0, monthlyPayment: 0 }).success).toBe(true);
    expect(UnregisteredLoanInput.safeParse({ lenderName: ' ', amount: 1, monthlyPayment: 1 }).success).toBe(false);
    expect(UnregisteredLoanInput.safeParse({ lenderName: 'x', amount: -1, monthlyPayment: 1 }).success).toBe(false);
  });
});
