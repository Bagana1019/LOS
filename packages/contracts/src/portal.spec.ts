import { describe, expect, it } from 'vitest';
import { PortalAmountInput, PortalCreatePayment, PortalId, PortalOtpRequest, PortalOtpVerify, PortalPaymentCheckout, PortalPaymentList, PortalPaymentListQuery, PortalPhone, PortalRegisterNo } from './portal';

describe('portal request schemas', () => {
  it('normalises register numbers and phones', () => {
    expect(PortalRegisterNo.parse(' уб90010112 ')).toBe('УБ90010112');
    expect(PortalRegisterNo.parse('ӨӨ12345678')).toBe('ӨӨ12345678');
    expect(PortalPhone.parse('+976 9911-2233')).toBe('99112233');
    expect(PortalPhone.parse('97699112233')).toBe('99112233');
    expect(PortalPhone.parse('99112233')).toBe('99112233');
  });

  it.each(['UB90010112', 'УБ9001011', 'УБ900101123', '1234567890', '', 'УБ 90010112'])('rejects register %j', (v) => {
    expect(PortalRegisterNo.safeParse(v).success).toBe(false);
  });
  it.each(['9911223', '991122334', 'abcdefgh', '+97699', ''])('rejects phone %j', (v) => {
    expect(PortalPhone.safeParse(v).success).toBe(false);
  });

  it('OTP request/verify are strict', () => {
    expect(PortalOtpRequest.safeParse({ registerNo: 'УБ90010112', phone: '99112233', extra: 1 }).success).toBe(false);
    expect(PortalOtpVerify.safeParse({ challengeId: 'a'.repeat(22), code: '123456' }).success).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef', '12 456']) expect(PortalOtpVerify.safeParse({ challengeId: 'a'.repeat(22), code }).success).toBe(false);
    expect(PortalOtpVerify.safeParse({ challengeId: 'short', code: '123456' }).success).toBe(false);
  });

  it('amounts: positive, ≤2 decimals, bounded', () => {
    for (const ok of [0.01, 1, 1234.5, 99999999.99]) expect(PortalAmountInput.safeParse(ok).success).toBe(true);
    for (const bad of [0, -1, 1.001, Number.NaN, Number.POSITIVE_INFINITY, 1e13, '5' as unknown as number]) expect(PortalAmountInput.safeParse(bad).success).toBe(false);
  });

  it('CreatePayment: amount only for CUSTOM', () => {
    expect(PortalCreatePayment.safeParse({ amountType: 'CUSTOM', amount: 10, method: 'QPAY' }).success).toBe(true);
    expect(PortalCreatePayment.safeParse({ amountType: 'PAYOFF', method: 'SOCIALPAY' }).success).toBe(true);
    expect(PortalCreatePayment.safeParse({ amountType: 'CUSTOM', method: 'QPAY' }).success).toBe(false);
    expect(PortalCreatePayment.safeParse({ amountType: 'OVERDUE', amount: 10, method: 'QPAY' }).success).toBe(false);
    expect(PortalCreatePayment.safeParse({ amountType: 'PAYOFF', method: 'CASH' }).success).toBe(false);
  });

  it('ids cannot carry path or query characters', () => {
    for (const bad of ['../x', 'a/b', 'a b', 'a?b', 'a%2fb', '', 'x'.repeat(65)]) expect(PortalId.safeParse(bad).success).toBe(false);
    expect(PortalId.safeParse('loan_demo-001').success).toBe(true);
  });

  it('payment list query has defaults and bounds', () => {
    expect(PortalPaymentListQuery.parse({})).toEqual({ limit: 20 });
    expect(PortalPaymentListQuery.parse({ limit: '50', cursor: 'pay_abc-1' })).toEqual({ limit: 50, cursor: 'pay_abc-1' });
    expect(PortalPaymentListQuery.safeParse({ limit: '51' }).success).toBe(false);
    expect(PortalPaymentListQuery.safeParse({ cursor: 'a b' }).success).toBe(false);
  });

  it('a next cursor returned in a list is always accepted back as a query cursor', () => {
    for (const cursor of ['pay_abc', 'eyJhIjoxfQ==', 'dGVzdA', '2026-10-28T04.00.00.000Z_pay-1']) {
      const list = PortalPaymentList.parse({ items: [], nextCursor: cursor });
      expect(PortalPaymentListQuery.parse({ cursor: list.nextCursor }).cursor).toBe(cursor);
    }
    // origination-ий хүчингүй cursor (стандарт base64 '+', '/', '|', хоосон) шууд гэрээний зөрчил болно — клиентэд 400 болж очихгүй
    for (const bad of ['a+b', 'a/b', 'x|y', '', 'a b', 'x'.repeat(257)]) {
      expect(PortalPaymentList.safeParse({ items: [], nextCursor: bad }).success).toBe(false);
    }
  });

  it('checkout web URLs must be https', () => {
    const base = { qrText: null, deeplinks: [] };
    expect(PortalPaymentCheckout.safeParse({ ...base, webUrl: 'https://pay.example.mn/x' }).success).toBe(true);
    expect(PortalPaymentCheckout.safeParse({ ...base, webUrl: 'http://pay.example.mn/x' }).success).toBe(false);
    expect(PortalPaymentCheckout.safeParse({ ...base, webUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
});
