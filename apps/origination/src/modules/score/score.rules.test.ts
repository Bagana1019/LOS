import { describe, expect, it } from 'vitest';
import type { ScoreRequest } from '@los/contracts';
import { buildSnapshot, isEditableStatus, laterOf, overlayStale, planScoreStep, readSnapshot, reconcileSnapshot, toSoscoSummary } from './score.rules';
import { calculationRecord, soscoResponse } from './testing/scoring-fixtures';

const request: ScoreRequest = {
  applicationId: 'app-1', amount: 10_000_000, termMonths: 12, interestRate: 24, monthlyPayment: 945_598.69, salaryMonthly: 3_000_000, businessNcfMonthly: 0, householdExpenseMonthly: 0,
  existingDebtServiceMonthly: 500_000, collateralValueTotal: 20_000_000, collateralRequired: true, policy: { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 },
};

describe('isEditableStatus', () => {
  it('зөвхөн DRAFT / RETURNED', () => {
    for (const s of ['DRAFT', 'RETURNED']) expect(isEditableStatus(s)).toBe(true);
    for (const s of ['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'ACTIVE', 'CLOSED', 'MIGRATED', '']) expect(isEditableStatus(s)).toBe(false);
  });
});

describe('buildSnapshot · calc_snapshot_json', () => {
  it('сонгосон аргын харьцаа/хязгаар/хангасан, LTV, Sosco, цагууд', () => {
    const record = calculationRecord(request, { id: 'calc-9', selectedMethod: 'A_SALARY', computedAt: '2026-10-29T10:00:00.000Z', pass: { A_SALARY: false }, ltv: 0.5 });
    expect(buildSnapshot(record, { score: 720, grade: 'B' })).toEqual({
      calculationId: 'calc-9', selectedMethod: 'A_SALARY', selection: 'AUTO', ratioKind: 'DTI', ratio: 0.3, limit: 0.55, pass: false, eligible: false, ltv: 0.5,
      soscoScore: 720, soscoGrade: 'B', computedAt: '2026-10-29T10:00:00.000Z', syncedAt: '2026-10-29T10:00:00.000Z',
    });
  });

  it('B аргын ӨТЧХ (DSCR) ба гараар сонгосон; syncedAt = сонголтын цаг (хожим нь)', () => {
    const record = calculationRecord(request, { selectedMethod: 'B_BUSINESS', selection: 'MANUAL', selectedAt: '2026-10-29T10:05:00.000Z' });
    expect(buildSnapshot(record, null)).toMatchObject({ selectedMethod: 'B_BUSINESS', selection: 'MANUAL', ratioKind: 'DSCR', limit: 1.25, soscoScore: null, soscoGrade: null, syncedAt: '2026-10-29T10:05:00.000Z' });
  });

  it('арга сонгогдоогүй (орлого байхгүй) → арга-тусгай талбар null, LTV хэвээр; барьцаагүй бол ltv null', () => {
    const record = calculationRecord(request, { selectedMethod: null, autoSelected: null, ltv: null });
    expect(buildSnapshot(record, null)).toMatchObject({ selectedMethod: null, selection: null, ratioKind: null, ratio: null, limit: null, pass: null, eligible: null, ltv: null });
  });

  it('хувийн мэдээлэл агуулахгүй: зөвхөн хоёр дахь түвшний хураангуй талбарууд', () => {
    const json = JSON.stringify(buildSnapshot(calculationRecord(request), { score: 700, grade: 'B' }));
    expect(json).not.toContain('salaryMonthly');
    expect(json).not.toContain('customerId');
  });
});

describe('readSnapshot / reconcileSnapshot', () => {
  const snapshot = buildSnapshot(calculationRecord(request, { id: 'calc-1', selectedMethod: 'A_SALARY' }), { score: 700, grade: 'B' });

  it('buildSnapshot-ийн гаралтыг бүтнээр уншина', () => {
    expect(readSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it.each([[null], [undefined], ['x'], [1], [{}], [{ computedAt: 'not a date' }]])('хүчингүй JSON (%j) → null', (json) => {
    expect(readSnapshot(json)).toBeNull();
  });

  it('муу талбарыг null болгоно; syncedAt байхгүй бол computedAt', () => {
    expect(readSnapshot({ computedAt: '2026-10-29T10:00:00.000Z', selectedMethod: 'Z', ratio: 'x', pass: 'yes', soscoGrade: 'Q' })).toMatchObject({
      selectedMethod: null, ratio: null, pass: null, soscoGrade: null, syncedAt: '2026-10-29T10:00:00.000Z', calculationId: null,
    });
  });

  it('арга солигдсон event: арга-тусгай дэлгэрэнгүйг хүчингүй болгож reconciled тэмдэглэнэ', () => {
    const r = reconcileSnapshot(snapshot, { selectedMethod: 'B_BUSINESS', soscoScore: 650, occurredAt: '2026-10-29T10:30:00.000Z' });
    expect(r).toMatchObject({
      calculationId: 'calc-1', selectedMethod: 'B_BUSINESS', selection: null, ratioKind: null, ratio: null, limit: null, pass: null, eligible: null,
      soscoScore: 650, soscoGrade: null, ltv: snapshot.ltv, computedAt: snapshot.computedAt, syncedAt: '2026-10-29T10:30:00.000Z', reconciled: true,
    });
  });

  it('арга ижил бол дэлгэрэнгүй хадгалагдана; оноо ижил бол зэрэг хадгалагдана', () => {
    const r = reconcileSnapshot(snapshot, { selectedMethod: 'A_SALARY', soscoScore: 700, occurredAt: '2026-10-29T10:30:00.000Z' });
    expect(r).toMatchObject({ ratio: snapshot.ratio, pass: snapshot.pass, soscoGrade: 'B', selection: 'AUTO' });
  });

  it('snapshot байхгүй үед үүсгэнэ (calculationId=null)', () => {
    expect(reconcileSnapshot(null, { selectedMethod: 'C_COMBINED', soscoScore: null, occurredAt: '2026-10-29T10:30:00.000Z' })).toEqual({
      calculationId: null, selectedMethod: 'C_COMBINED', selection: null, ratioKind: null, ratio: null, limit: null, pass: null, eligible: null, ltv: null,
      soscoScore: null, soscoGrade: null, computedAt: '2026-10-29T10:30:00.000Z', syncedAt: '2026-10-29T10:30:00.000Z', reconciled: true,
    });
  });
});

describe('planScoreStep', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  it('арга сонгогдсон → COMPLETED (completed_at = одоо); сонгогдоогүй → PENDING', () => {
    expect(planScoreStep({ id: 's', status: 'PENDING' }, 'A_SALARY', now)).toEqual({ kind: 'update', id: 's', status: 'COMPLETED', completedAt: now });
    expect(planScoreStep({ id: 's', status: 'COMPLETED' }, null, now)).toEqual({ kind: 'update', id: 's', status: 'PENDING', completedAt: null });
    expect(planScoreStep({ id: 's', status: 'STALE' }, 'B_BUSINESS', now)).toMatchObject({ kind: 'update', status: 'COMPLETED' });
  });
  it('мөр байхгүй бол үүсгэнэ; LOCKED мөрийг хөндөхгүй', () => {
    expect(planScoreStep(null, 'A_SALARY', now)).toEqual({ kind: 'create', status: 'COMPLETED', completedAt: now });
    expect(planScoreStep(null, null, now)).toEqual({ kind: 'create', status: 'PENDING', completedAt: null });
    expect(planScoreStep({ id: 's', status: 'LOCKED' }, 'A_SALARY', now)).toEqual({ kind: 'skip' });
  });
});

describe('overlayStale', () => {
  const record = calculationRecord(request, { computedAt: '2026-10-29T10:00:00.000Z' });
  const step = (status: string, updatedAt: string) => ({ status, staleReason: 'LOAN_TERMS_CHANGED', updatedAt: new Date(updatedAt) });

  it('алхам STALE, тооцоолол түүнээс ӨМНӨ хийгдсэн, scoring мэдээгүй → хуучирсан гэж харуулна', () => {
    expect(overlayStale(record, step('STALE', '2026-10-29T11:00:00.000Z'))).toMatchObject({ isStale: true, staleReason: 'LOAN_TERMS_CHANGED' });
  });
  it('тооцоолол алхмыг хуучруулсны ДАРАА хийгдсэн бол хэвээр', () => {
    expect(overlayStale(record, step('STALE', '2026-10-29T09:00:00.000Z'))).toBe(record);
  });
  it('алхам STALE биш / scoring өөрөө хуучирсан гэсэн / тооцоолол байхгүй бол өөрчлөхгүй', () => {
    expect(overlayStale(record, step('COMPLETED', '2026-10-29T11:00:00.000Z'))).toBe(record);
    expect(overlayStale(record, null)).toBe(record);
    const stale = { ...record, isStale: true, staleReason: 'X' };
    expect(overlayStale(stale, step('STALE', '2026-10-29T11:00:00.000Z'))).toBe(stale);
    expect(overlayStale(null, step('STALE', '2026-10-29T11:00:00.000Z'))).toBeNull();
  });
});

describe('laterOf / toSoscoSummary', () => {
  it('миллисекундийн оронгоос үл хамааран хожим нь', () => {
    expect(laterOf('2026-10-29T10:00:00Z', '2026-10-29T10:00:00.500Z')).toBe('2026-10-29T10:00:00.500Z');
    expect(laterOf('2026-10-29T10:00:01.000Z', '2026-10-29T10:00:00.999Z')).toBe('2026-10-29T10:00:01.000Z');
    expect(laterOf('2026-10-29T10:00:00.000Z', null)).toBe('2026-10-29T10:00:00.000Z');
  });
  it('SoscoScoreResponse → SoscoSummary (modelId хасагдаж, customerId нэмэгдэнэ)', () => {
    const r = soscoResponse({ score: 640, grade: 'C' });
    const summary = toSoscoSummary(r, 'cust-1');
    expect(summary).toMatchObject({ customerId: 'cust-1', score: 640, grade: 'C', resultId: r.resultId, modelVersion: r.modelVersion });
    expect('modelId' in summary).toBe(false);
  });
});
