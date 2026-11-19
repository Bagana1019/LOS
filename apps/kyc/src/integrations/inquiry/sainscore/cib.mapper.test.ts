import { annuityPayment } from '@los/calc';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CIB_POLICY, mapCibRows } from './cib.mapper';

// SainScore inquiry[] мөр → LOS CIB summary/detail. Мөрийн талбарууд Python лавлагааны тестийн fixture-ээс (баталгаажсан):
// dutytype (LN зээл | LS лизинг | LINE зээлийн шугам), adv_amount, balance, closed_date, cls_status (0 хэвийн | 1 хугацаа хэтэрсэн ≤90 | 2 >90),
// curr_code, int_rate (жилийн %), maturity_date (YYYY-MM-DD | YYYY.MM.DD), colls[].sub_coll_type.
const TODAY = new Date('2025-01-15T00:00:00Z'); // 2025-11-08 хүртэл 10 сар
const open = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  adv_amount: 5_000_000, adv_date: '2024-05-22', balance: 3_500_000, clientname: 'ХААН БАНК', clientlastname: '', closed_date: null, cls_status: 0, cls_name: null,
  colls: [{ coll_regno: '', sub_coll_type: null }], curr_code: 'MNT', description: 'Test loan', dutytype: 'LN', dutytypename: 'Зээл', int_rate: 5, maturity_date: '2025-11-08', loancode: 'L-1', ...over,
});
const map = (rows: unknown[], policy = DEFAULT_CIB_POLICY) => mapCibRows({ decision: 'APPROVED', rows }, TODAY, policy);
const loans = (r: ReturnType<typeof map>) => (r.detail.loans as Array<Record<string, unknown>>);

describe('mapCibRows — хэвийн идэвхтэй зээл (LN, vendor-ийн хүүтэй)', () => {
  const r = map([open()]);
  it('summary-ийн түлхүүрүүд (docs/03 inquiry.summary_json)', () => {
    const expected = annuityPayment(3_500_000, 5, 10);
    expect(r.summary).toMatchObject({ active_loan_count: 1, open_loan_count: 1, closed_loan_count: 0, total_disbursed: 5_000_000, outstanding: 3_500_000, overdue_days_max: 0 });
    expect(r.summary.monthly_payment).toBe(expected);
    expect(expected).toBeGreaterThan(3_500_000 / 10); // хүүтэй тул зөвхөн үндсэн төлбөрөөс их
    expect(expected).toBeLessThan((3_500_000 / 10) * 1.1);
  });
  it('vendor хэмжээгүй зүйлийг зохиохгүй: overdue_months, inquiries_last_90d = null (мэдэгдэхгүй)', () => {
    expect(r.summary.overdue_months).toBeNull();
    expect(r.summary.inquiries_last_90d).toBeNull();
    expect(r.summary.payment_complete).toBe(true);
  });
  it('detail.loans мөр + түүхий хариуг (шифрлэгдэж хадгалагдах) хадгална', () => {
    expect(loans(r)[0]).toMatchObject({ lender: 'ХААН БАНК', kind: 'LN', status: 'ACTIVE', currency: 'MNT', disbursedAmount: 5_000_000, outstanding: 3_500_000, openedOn: '2024-05-22', maturityOn: '2025-11-08', annualRatePct: 5, rateSource: 'VENDOR', overdueClass: 0 });
    expect(r.detail.raw).toEqual({ decision: 'APPROVED', inquiry: [open()] });
    expect(r.warningLevel).toBe('NONE');
  });
});

describe('mapCibRows — хүүгүй LN: таамагласан хүү (Python: 2.5%/сар, ≥50 сая бол 1.6%/сар)', () => {
  it.each([[null], [0], ['0'], ['abc']])('int_rate=%j → 30% жил, rateSource=ASSUMED (0% = үндсэн төлбөр л, дутуу төлбөр)', (rate) => {
    const r = map([open({ int_rate: rate })]);
    expect(r.summary.monthly_payment).toBe(annuityPayment(3_500_000, 30, 10));
    expect(loans(r)[0]).toMatchObject({ annualRatePct: 30, rateSource: 'ASSUMED' });
    expect(r.warningLevel).toBe('NONE');
  });
  it('том зээл (adv_amount ≥ босго) → 19.2% жил', () => {
    const r = map([open({ int_rate: null, adv_amount: 60_000_000, balance: 40_000_000 })]);
    expect(loans(r)[0]).toMatchObject({ annualRatePct: 19.2, rateSource: 'ASSUMED' });
    expect(r.summary.monthly_payment).toBe(annuityPayment(40_000_000, 19.2, 10));
  });
  it('adv_amount байхгүй бол үлдэгдлээр хэмжээг тодорхойлно', () => {
    const r = map([open({ int_rate: null, adv_amount: null, balance: 55_000_000 })]);
    expect(loans(r)[0]).toMatchObject({ annualRatePct: 19.2 });
  });
  it('политик (хүү, босго) тохиргооноос — hardcode биш', () => {
    const r = map([open({ int_rate: null })], { assumedMonthlyRatePct: 3, largeLoanMonthlyRatePct: 2, largeLoanThresholdMnt: 1_000_000 });
    expect(loans(r)[0]).toMatchObject({ annualRatePct: 24 }); // adv 5 сая ≥ 1 сая → том зээлийн 2%/сар
  });
  it('LS (лизинг) хүүгүй бол 0% (Python-той ижил), rateSource=UNKNOWN → WARNING (дутуу төлбөр байж болзошгүй)', () => {
    const r = map([open({ dutytype: 'LS', int_rate: null })]);
    expect(r.summary.monthly_payment).toBe(annuityPayment(3_500_000, 0, 10));
    expect(loans(r)[0]).toMatchObject({ kind: 'LS', rateSource: 'UNKNOWN' });
    expect(r.warningLevel).toBe('WARNING');
  });
});

describe('mapCibRows — зээлийн шугам (LINE), хаагдсан, тэг үлдэгдэл', () => {
  it('LINE: лимит (adv_amount) бүхлээрээ сарын үүрэг; үлдэгдэл тэг ч идэвхтэй; maturity шаардахгүй', () => {
    const r = map([open({ dutytype: 'LINE', adv_amount: 2_000_000, balance: 0, maturity_date: null, int_rate: null })]);
    expect(r.summary).toMatchObject({ active_loan_count: 1, monthly_payment: 2_000_000, outstanding: 0, total_disbursed: 2_000_000 });
    expect(loans(r)[0]).toMatchObject({ kind: 'LINE', monthlyPayment: 2_000_000 });
  });
  it('хаагдсан LINE → closed; үүрэг тооцохгүй', () => {
    const r = map([open({ dutytype: 'LINE', adv_amount: 2_000_000, balance: 0, closed_date: '2024-12-01' })]);
    expect(r.summary).toMatchObject({ active_loan_count: 0, closed_loan_count: 1, monthly_payment: 0 });
  });
  it.each([[-5], ['abc'], [null]])('LINE adv_amount=%j (үнэлэх боломжгүй/сөрөг) → алгасаж, payment_complete=false, WARNING (үүргийг дутуу тооцохгүйн тулд)', (adv) => {
    const r = map([open({ dutytype: 'LINE', adv_amount: adv, balance: 0 })]);
    expect(r.summary.payment_complete).toBe(false);
    expect(r.warningLevel).toBe('WARNING');
    expect(r.detail.skipped).toEqual([{ loancode: 'L-1', dutytype: 'LINE', reason: 'UNPARSEABLE_ADV_AMOUNT' }]);
  });
  it('closed_date-тэй LN → closed_loan_count; нийлбэрт орохгүй', () => {
    const r = map([open({ closed_date: '2024-12-01', balance: 0 })]);
    expect(r.summary).toMatchObject({ active_loan_count: 0, closed_loan_count: 1, total_disbursed: 0, outstanding: 0, monthly_payment: 0 });
    expect(loans(r)[0]).toMatchObject({ status: 'CLOSED' });
  });
  it('LN-ийн үлдэгдэл ≤ 0 (closed_date байхгүй) → хаагдсан гэж үзнэ', () => {
    expect(map([open({ balance: 0 })]).summary).toMatchObject({ active_loan_count: 0, closed_loan_count: 1 });
  });
  // Review M2: closed_date байгаа ч үлдэгдэл > 0 (дахин бүтэцлэсэн / шилжүүлсэн зээл г.м.) = зөрчилтэй өгөгдөл → хаагдсан гэж таамаглахгүй.
  it('closed_date-тэй ч үлдэгдэл > 0: идэвхтэй гэж тоолж, төлбөрийг оруулна, closedDateWithBalance + WARNING', () => {
    const r = map([open({ closed_date: '2026-10-01' })]);
    expect(r.summary).toMatchObject({ active_loan_count: 1, closed_loan_count: 0, outstanding: 3_500_000 });
    expect(r.summary.monthly_payment as number).toBeGreaterThan(0);
    expect(loans(r)[0]).toMatchObject({ status: 'ACTIVE', closedDateWithBalance: true });
    expect(r.warningLevel).toBe('WARNING');
  });
  it('closed_date-тэй, үлдэгдэл задлагдахгүй (null) → хаагдсан (өөр мэдээлэл байхгүй)', () => {
    expect(map([open({ closed_date: '2024-12-01', balance: null })]).summary).toMatchObject({ active_loan_count: 0, closed_loan_count: 1 });
  });
});

describe('mapCibRows — бусад хоцрогдол', () => {
  it('MNT биш идэвхтэй зээл: тоо, detail-д орно; MNT нийлбэрт ОРОХГҮЙ ГЭХДЭЭ чимээгүй орхихгүй — payment_complete=false + WARNING (FX хөрвүүлэлтгүй)', () => {
    const r = map([open({ curr_code: 'USD', adv_amount: 15_000, balance: 8_000 }), open({ loancode: 'L-2' })]);
    expect(r.summary).toMatchObject({ active_loan_count: 2, total_disbursed: 5_000_000, outstanding: 3_500_000, payment_complete: false });
    expect(loans(r)[0]).toMatchObject({ currency: 'USD', excludedFromTotals: 'NON_MNT' });
    expect(r.warningLevel).toBe('WARNING');
  });
  it('зөвхөн MNT идэвхтэй зээлтэй бол payment_complete=true (FX шалгалт буруу анхааруулахгүй)', () => {
    expect(map([open()]).summary.payment_complete).toBe(true);
  });
  // Python лавлагаа хадгаламж барьцаатай зээлийг DTI-аас хасдаг боловч энэ нь бизнесийн батлагдаагүй политик; бодит үүрэг нь сарын төлбөр хэвээр → тоолно.
  it('хадгаламж барьцаатай зээлийн сарын төлбөрийг ХАСАХГҮЙ (үүргийг дутуу тооцохгүй), ямар ч тусгай тэмдэглэгээгүй', () => {
    const r = map([open({ colls: [{ coll_regno: 'X', sub_coll_type: 'Банкин дахь хадгаламж' }] })]);
    expect(r.summary).toMatchObject({ active_loan_count: 1, outstanding: 3_500_000, monthly_payment: annuityPayment(3_500_000, 5, 10) });
    expect(loans(r)[0]).not.toHaveProperty('excludedFromPayment');
    expect(r.warningLevel).toBe('NONE');
  });
  it('maturity_date задлах боломжгүй → төлбөр тооцоогүй, payment_complete=false, WARNING', () => {
    const r = map([open({ maturity_date: 'tomorrow' })]);
    expect(r.summary).toMatchObject({ active_loan_count: 1, monthly_payment: 0, payment_complete: false });
    expect(r.warningLevel).toBe('WARNING');
    expect(r.detail.skipped).toEqual([{ loancode: 'L-1', dutytype: 'LN', reason: 'UNPARSEABLE_MATURITY_DATE' }]);
  });
  it('YYYY.MM.DD хэлбэрийг зөвшөөрнө', () => {
    expect(map([open({ maturity_date: '2025.11.08' })]).summary.monthly_payment).toBe(annuityPayment(3_500_000, 5, 10));
  });
  // Review H2: хугацаа дууссан / энэ сард дуусах зээлийн үлдэгдэл ЯГ ОДОО төлөгдөх ёстой → 0 гэж тоолохгүй; дараа сарын (үлдсэн 1 сар) дүнтэй тасралтгүй.
  it('хугацаа хэтэрсэн (matured) боловч үлдэгдэлтэй: үлдэгдлийг 1 сарын дотор төлөх үүрэг (0 БИШ), matured=true, WARNING', () => {
    const r = map([open({ maturity_date: '2024-12-31' })]);
    expect(r.summary).toMatchObject({ active_loan_count: 1, outstanding: 3_500_000, monthly_payment: annuityPayment(3_500_000, 5, 1) });
    expect(r.summary.monthly_payment as number).toBeGreaterThanOrEqual(3_500_000);
    expect(loans(r)[0]).toMatchObject({ matured: true });
    expect(r.warningLevel).toBe('WARNING');
  });
  it('энэ сард дуусах зээл (үлдсэн 0 сар) нь дараа сарын (үлдсэн 1 сар) зээлтэй ижил дүнтэй — сарын хил дээр огцом үсрэлтгүй', () => {
    const thisMonth = map([open({ maturity_date: '2025-01-31' })]);
    const nextMonth = map([open({ maturity_date: '2025-02-28' })]);
    expect(thisMonth.summary.monthly_payment).toBe(nextMonth.summary.monthly_payment);
    expect(loans(thisMonth)[0]).toMatchObject({ matured: true });
    expect(loans(nextMonth)[0]).not.toHaveProperty('matured');
  });
  it('зээл биш dutytype (жишээ нь карт) → тоолохгүй, detail.skipped-д', () => {
    const r = map([open({ dutytype: 'CARD' })]);
    expect(r.summary).toMatchObject({ active_loan_count: 0, closed_loan_count: 0, outstanding: 0 });
    expect(r.detail.skipped).toEqual([{ loancode: 'L-1', dutytype: 'CARD', reason: 'INELIGIBLE_DUTYTYPE' }]);
    expect(r.warningLevel).toBe('NONE');
  });
  it('тоон талбарын тоон string-ийг хүлээн авна', () => {
    const r = map([open({ adv_amount: '5000000', balance: '3500000', int_rate: '5' })]);
    expect(r.summary).toMatchObject({ total_disbursed: 5_000_000, outstanding: 3_500_000, monthly_payment: annuityPayment(3_500_000, 5, 10) });
  });
});

describe('mapCibRows — хугацаа хэтрэлт (cls_status), анхааруулга', () => {
  it('cls_status=1 → overdue_days_max=1 (доод хязгаар: vendor хоног өгдөггүй), WARNING', () => {
    const r = map([open({ cls_status: 1 })]);
    expect(r.summary.overdue_days_max).toBe(1);
    expect(r.warningLevel).toBe('WARNING');
    expect(loans(r)[0]).toMatchObject({ overdueClass: 1 });
  });
  it.each([[2], ['2']])('cls_status=%j (>90 хоног) → overdue_days_max=91, RED', (cls) => {
    const r = map([open({ cls_status: cls })]);
    expect(r.summary.overdue_days_max).toBe(91);
    expect(r.warningLevel).toBe('RED');
  });
  it('cls_status задлагдахгүй бол хоцрогдолгүй гэж таамаглахгүй → WARNING', () => {
    expect(map([open({ cls_status: 'invalid' })]).warningLevel).toBe('WARNING');
  });
  it('хамгийн хүнд зээл нь тодорхойлно (хэвийн + RED = RED)', () => {
    expect(map([open(), open({ loancode: 'L-2', cls_status: 2 })]).warningLevel).toBe('RED');
  });
});

describe('mapCibRows — буруу хэлбэр', () => {
  it('объект биш мөр → алгасаж, WARNING (дутуу өгөгдөл)', () => {
    const r = map([null, 'x', 7, open()]);
    expect(r.summary).toMatchObject({ active_loan_count: 1, payment_complete: false });
    expect(r.detail.skipped).toHaveLength(3);
    expect(r.warningLevel).toBe('WARNING');
  });
  it('мөр байхгүй → бүгд 0, NONE', () => {
    const r = map([]);
    expect(r.summary).toMatchObject({ active_loan_count: 0, closed_loan_count: 0, total_disbursed: 0, outstanding: 0, monthly_payment: 0, overdue_days_max: 0, payment_complete: true });
    expect(r.warningLevel).toBe('NONE');
  });
  it('оруулсан `today`-ээр үлдсэн сарыг тооцно', () => {
    const later = mapCibRows({ decision: null, rows: [open()] }, new Date('2025-06-15T00:00:00Z'), DEFAULT_CIB_POLICY);
    expect(later.summary.monthly_payment).toBe(annuityPayment(3_500_000, 5, 5)); // 2025-11 − 2025-06 = 5 сар
  });
});
