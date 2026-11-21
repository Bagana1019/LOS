import { describe, expect, it } from 'vitest';
import { SaveLoanTermsRequest, type LoanTermsView } from '@los/contracts';
import { rateToPercent } from '../../lib/format';
import { toFormValues, toSaveRequest, type TermsFormValues } from './loanTerms.form';

// F2-17: шимтгэлийн хувь API-д БУТАРХАЙ (0.015 = 1.5%), хэрэглэгчид ХУВИАР (1.5). Хөрвүүлэлт нэг л газар, хоёр чиглэлд.
const base: TermsFormValues = { productId: 'p1', amount: 5_000_000, termMonths: 12, purpose: 'Хэрэглээ' };

describe('toSaveRequest: хувь → бутархай', () => {
  it.each([
    [1.5, 0.015],
    [2.5, 0.025],
    [1.25, 0.0125],
    [0.01, 0.0001],
    [100, 1],
  ])('шимтгэл %d%% → feeRate %d', (percent, fraction) => {
    expect(toSaveRequest({ ...base, feeRatePercent: percent }).feeRate).toBe(fraction);
  });

  it('0% нь тодорхой утга (хоосон биш): feeRate: 0 явна', () => {
    expect(toSaveRequest({ ...base, feeRatePercent: 0 })).toHaveProperty('feeRate', 0);
  });

  it('хоосон шимтгэл (undefined/null) → feeRate илгээхгүй (сервер анхдагчийг бөглөнө)', () => {
    expect(toSaveRequest(base)).not.toHaveProperty('feeRate');
    expect(toSaveRequest({ ...base, feeRatePercent: null as unknown as undefined })).not.toHaveProperty('feeRate');
  });

  it('форм-ын түр талбар feeRatePercent API рүү явахгүй', () => {
    expect(toSaveRequest({ ...base, feeRatePercent: 1.5 })).not.toHaveProperty('feeRatePercent');
  });

  it('хүү аль хэдийн хувиар: өөрчлөхгүй; хоосон/undefined талбарыг хаяна', () => {
    const req = toSaveRequest({ ...base, interestRate: 23.99, downPayment: undefined, purposeDetail: '' });
    expect(req).toMatchObject({ interestRate: 23.99, amount: 5_000_000 });
    expect(req).not.toHaveProperty('downPayment');
    expect(req).not.toHaveProperty('purposeDetail');
  });

  it('гэрээний SaveLoanTermsRequest-д таарна (4 оронтой бутархай)', () => {
    for (const percent of [0, 0.01, 1.5, 1.55, 2.5, 99.99, 100]) {
      expect(SaveLoanTermsRequest.safeParse(toSaveRequest({ ...base, feeRatePercent: percent })).success, `${percent}%`).toBe(true);
    }
  });

  it('0.0001 хүртэлх бүх бутархай хувиар явж ирээд яг эх утгаараа буцна (дугуйрал үгүй)', () => {
    for (let bp = 0; bp <= 10_000; bp++) {
      const fraction = bp / 10_000;
      expect(toSaveRequest({ ...base, feeRatePercent: rateToPercent(fraction) }).feeRate, `${bp} bp`).toBe(fraction);
    }
  });
});

describe('toFormValues: API → форм', () => {
  const view = (o: Partial<LoanTermsView>): LoanTermsView => ({
    applicationId: 'a1', editable: true, productId: 'p1', currency: 'MNT', amount: 5_000_000, termMonths: 12, interestRate: 24, feeRate: 0.015, feeAmount: 75_000,
    downPayment: null, charges: null, insurance: null, purpose: 'Хэрэглээ', purposeDetail: null, cibPurposeCode: null, cibSubCode: null, officerNote: null,
    limits: null, step: null, installmentStep: null, ...o,
  });

  it('бутархай шимтгэл → хувь: 0.015 → 1.5, 0.0125 → 1.25', () => {
    expect(toFormValues(view({ feeRate: 0.015 })).feeRatePercent).toBe(1.5);
    expect(toFormValues(view({ feeRate: 0.0125 })).feeRatePercent).toBe(1.25);
    expect(toFormValues(view({ feeRate: 0 })).feeRatePercent).toBe(0);
  });

  it('null → undefined (талбар хоосон)', () => {
    const v = toFormValues(view({ feeRate: null, interestRate: null, amount: null, downPayment: null, purposeDetail: null }));
    expect(v.feeRatePercent).toBeUndefined();
    expect(v.interestRate).toBeUndefined();
    expect(v.amount).toBeUndefined();
    expect(v.downPayment).toBeUndefined();
  });

  it('бусад талбар хэвээр, хүү хувиар хэвээр', () => {
    expect(toFormValues(view({ interestRate: 23.99 }))).toMatchObject({ productId: 'p1', amount: 5_000_000, termMonths: 12, interestRate: 23.99, purpose: 'Хэрэглээ' });
  });
});
