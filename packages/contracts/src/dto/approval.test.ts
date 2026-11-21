import { describe, expect, it } from 'vitest';
import { DecisionView, MyApprovalItem, VoteRequest } from './approval';

// FR-1.5 / FR-10.2 (M3 review): санал өгөгч харсан түвшин, хувилбар дээрээ л санал өгнө — хоцрогдсон жагсаалтаас өөр шийдвэрт санал өгөхгүй.
describe('VoteRequest: хүлээгдэж буй levelNo / version', () => {
  it('хоёулаа заавал биш (одоогийн DecisionStep-ийн дуудлага хэвээр)', () => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE' }).success).toBe(true);
  });
  it('levelNo, version-тэй хүчинтэй; RETURN-ийн тайлбар заавал хэвээр', () => {
    expect(VoteRequest.parse({ decision: 'APPROVE', levelNo: 2, version: 3 })).toEqual({ decision: 'APPROVE', levelNo: 2, version: 3 });
    expect(VoteRequest.safeParse({ decision: 'RETURN', levelNo: 1, version: 1 }).success).toBe(false);
    expect(VoteRequest.safeParse({ decision: 'RETURN', comment: 'Дутуу', levelNo: 1, version: 1 }).success).toBe(true);
  });
  it('нэг нь л байж болно', () => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE', levelNo: 1 }).success).toBe(true);
    expect(VoteRequest.safeParse({ decision: 'APPROVE', version: 1 }).success).toBe(true);
  });
  it.each([[0], [-1], [1.5], ['1'], [null], [Number.NaN]])('буруу levelNo %j татгалзана', (levelNo) => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE', levelNo }).success).toBe(false);
  });
  it.each([[0], [-1], [2.5], ['2'], [null], [Number.NaN]])('буруу version %j татгалзана', (version) => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE', version }).success).toBe(false);
  });
});

describe('MyApprovalItem: version', () => {
  const base = {
    applicationId: 'a', appNo: 'LA-1', borrowerName: null, amount: 1, currency: 'MNT', levelNo: 1, levelName: 'Салбар', totalLevels: 2,
    startedAt: '2026-11-18T00:00:00.000Z', dueAt: null, overdue: false,
  };
  it('version-тэй хүчинтэй', () => expect(MyApprovalItem.safeParse({ ...base, version: 2 }).success).toBe(true));
  it('version-гүй бол татгалзана (жагсаалтын мөр санал өгөхдөө хувилбараа дамжуулах ёстой)', () => expect(MyApprovalItem.safeParse(base).success).toBe(false));
});

describe('VoteRequest (FR-10.3)', () => {
  it('APPROVE тайлбаргүй болно', () => expect(VoteRequest.safeParse({ decision: 'APPROVE' }).success).toBe(true));
  it('RETURN тайлбаргүй бол буруу', () => { expect(VoteRequest.safeParse({ decision: 'RETURN' }).success).toBe(false); expect(VoteRequest.safeParse({ decision: 'RETURN', comment: '   ' }).success).toBe(false); });
  it('RETURN тайлбартай болно; нөхцөл засах талбар хориотой (strict)', () => {
    expect(VoteRequest.safeParse({ decision: 'RETURN', comment: 'Дутуу' }).success).toBe(true);
    expect(VoteRequest.safeParse({ decision: 'APPROVE', amount: 1 }).success).toBe(false);
  });
});

// F3-1: шийдвэрийн хуудасны хураангуйд эрсдэлийн блок (`summary.risk`) нэмэгдэнэ — нэмэлт, хоосон байж болно (тооцоолол хадгалагдаагүй).
describe('DecisionView.summary.risk (F3-1)', () => {
  const risk = {
    method: 'A_SALARY', selection: 'AUTO', computedAt: '2026-11-20T03:00:00.000Z', stale: false,
    ratio: { kind: 'DTI', value: 0.4321, limit: 0.55, pass: true },
    ltv: { value: 0.5, limit: 0.7, pass: true },
    sosco: { score: 712, grade: 'B' },
    collateral: { count: 2, totalValue: 80_000_000, required: true },
    income: { salaryMonthly: 2_500_000, businessNcfMonthly: 0, householdExpenseMonthly: 400_000 },
    flags: [{ code: 'LTV_EXCEEDED', level: 'error', message: 'LTV хэтэрсэн' }],
  };
  const view = (summaryExtra: Record<string, unknown>) => ({
    applicationId: 'a', appNo: 'LA-1', status: 'IN_APPROVAL', version: 1,
    summary: { borrowerName: 'Б', registerNoMasked: null, productName: 'P', currency: 'MNT', amount: 5_000_000, termMonths: 12, interestRate: 28, monthlyPayment: 482_529.94, collateralCount: 2, selectedMethod: 'A_SALARY', ...summaryExtra },
    progress: { completed: 8, total: 8, missing: [] }, canSubmit: false,
    approval: { currentLevel: 1, totalLevels: 1, levels: [] }, versions: [], decisionRecord: null, canVote: true,
  });

  it('хадгалагдсан үзүүлэлтүүдтэй risk блокыг хадгална (устгахгүй)', () => {
    expect(DecisionView.parse(view({ risk })).summary.risk).toEqual(risk);
  });
  it('risk байхгүй / null байсан ч хүчинтэй (хуучин хариу, тооцоолол хадгалагдаагүй)', () => {
    expect(DecisionView.safeParse(view({})).success).toBe(true);
    expect(DecisionView.parse(view({ risk: null })).summary.risk).toBeNull();
  });
  it.each([['method', 'X_UNKNOWN'], ['sosco', { score: 1.5, grade: 'B' }], ['flags', [{ code: 'X', level: 'fatal', message: 'm' }]]])('буруу %s татгалзана', (key, bad) => {
    expect(DecisionView.safeParse(view({ risk: { ...risk, [key]: bad } })).success).toBe(false);
  });
  it('одоо байгаа summary талбарууд хэвээр (нэмэлт өөрчлөлт)', () => {
    const s = DecisionView.parse(view({ risk })).summary;
    expect(s).toMatchObject({ amount: 5_000_000, monthlyPayment: 482_529.94, collateralCount: 2, selectedMethod: 'A_SALARY' });
  });
});
