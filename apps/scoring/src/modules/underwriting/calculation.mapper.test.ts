// Цэвэр функцүүд (DB-гүй): calculation мөр ⇄ CalculationRecord. Гэрээний zod схемээр шалгана.
import type { Calculation } from '.prisma/client-scoring';
import { underwrite } from '@los/calc';
import { CalculationRecord, type UnderwriteResult } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { businessRequest, mixedRequest, noIncomeRequest, scoreRequest } from './testing/m8';
import { policyCheckOf, resultOf, selectionKindOf, stressJsonOf, toCreateData, toRecord } from './calculation.mapper';

const NOW = new Date('2026-10-29T03:00:00.000Z');

/** toCreateData-аас DB мөр шиг (id, created_at … нэмсэн) */
function rowFrom(over: Partial<Parameters<typeof toCreateData>[0]> = {}, patch: Partial<Calculation> = {}): Calculation {
  const request = over.request ?? scoreRequest();
  const result = over.result ?? underwrite(request);
  const data = toCreateData({ orgId: 'org-1', customerId: 'cust-1', computedAt: NOW, actorId: 'user-1', request, result, selection: null, ...over });
  return {
    id: 'calc-1', createdAt: NOW, updatedAt: NOW, isStale: false, staleReason: null, selectedAt: null, selectedReason: null, selectedBy: null, selectedMethod: null,
    ...data, ...patch,
  } as unknown as Calculation;
}

describe('policyCheckOf (docs/03 policy_check_json: dti, dscr, ltv = value, limit, pass)', () => {
  it('dti = A (BR-1), dscr = B, dscrCombined = C (BR-2), ltv = BR-3; limits come from the request policy (not hard-coded)', () => {
    const request = scoreRequest({ policy: { maxDti: 0.4, minDscr: 1.5, maxLtv: 0.6, weightThreshold: 0.7 } });
    const result = underwrite(request);
    const check = policyCheckOf(result);
    expect(check.dti).toEqual({ value: result.methods[0]!.ratio, limit: 0.4, pass: result.methods[0]!.pass });
    expect(check.dscr.limit).toBe(1.5);
    expect(check.dscrCombined.limit).toBe(1.5);
    expect(check.ltv).toEqual({ value: result.collateral.ltv, limit: 0.6, pass: result.collateral.pass });
    // 1.25M / 3M = 41.67% > 40% → A хангахгүй
    expect(check.dti.pass).toBe(false);
  });

  it('a method without an income base reports value null and pass false', () => {
    const check = policyCheckOf(underwrite(scoreRequest()));
    expect(check.dscr).toMatchObject({ value: null, pass: false }); // B: бизнесийн ЦМУ 0
  });
});

describe('stressJsonOf (FR-8.5)', () => {
  it('is undefined without a stress policy; otherwise the summary plus per-method outcomes keyed by method', () => {
    expect(stressJsonOf(underwrite(scoreRequest({ stress: undefined })))).toBeUndefined();
    const result = underwrite(scoreRequest());
    const json = stressJsonOf(result) as { rateDeltaPoints: number; incomeChange: number; stressedMonthlyPayment: number; outcomes: Record<string, unknown> };
    expect(json).toMatchObject({ rateDeltaPoints: 5, incomeChange: -0.2, stressedMonthlyPayment: result.stress!.stressedMonthlyPayment });
    expect(Object.keys(json.outcomes)).toEqual(['A_SALARY', 'B_BUSINESS', 'C_COMBINED']);
    expect(json.outcomes.A_SALARY).toEqual(result.methods[0]!.stress);
  });
});

describe('toCreateData', () => {
  it('stores the request, the full result, the three verdicts and the auto selection candidate', () => {
    const request = scoreRequest();
    const result = underwrite(request);
    const data = toCreateData({ orgId: 'org-1', customerId: 'cust-1', computedAt: NOW, actorId: 'user-1', request, result, selection: null });
    expect(data).toMatchObject({ orgId: 'org-1', applicationId: 'app-m8-1', customerId: 'cust-1', computedAt: NOW, autoSelectedMethod: 'A_SALARY', createdBy: 'user-1', updatedBy: 'user-1' });
    expect(data.inputsJson).toEqual(request);
    expect(data.resultJson).toEqual(result);
    expect([data.methodAJson, data.methodBJson, data.methodCJson]).toEqual(result.methods);
    expect(data).toMatchObject({ selectedMethod: null, selectedBy: null, selectedAt: null });
  });

  it('AUTO selection: selected_by null, selected_at = computed_at; MANUAL: selected_by = actor + reason', () => {
    const request = scoreRequest();
    const result = underwrite(request);
    const base = { orgId: 'o', customerId: 'c', computedAt: NOW, actorId: 'user-1', request, result };
    expect(toCreateData({ ...base, selection: { method: 'A_SALARY', manual: false, reason: null } })).toMatchObject({ selectedMethod: 'A_SALARY', selectedBy: null, selectedReason: null, selectedAt: NOW });
    expect(toCreateData({ ...base, selection: { method: 'C_COMBINED', manual: true, reason: 'ЗЭЗ-ийн санал' } })).toMatchObject({ selectedMethod: 'C_COMBINED', selectedBy: 'user-1', selectedReason: 'ЗЭЗ-ийн санал', selectedAt: NOW });
  });

  it('a request without an income base keeps autoSelectedMethod null', () => {
    const request = noIncomeRequest();
    const data = toCreateData({ orgId: 'o', customerId: 'c', computedAt: NOW, actorId: null, request, result: underwrite(request), selection: null });
    expect(data.autoSelectedMethod).toBeNull();
    expect(data.createdBy).toBeNull();
  });
});

describe('toRecord (validated against the CalculationRecord contract)', () => {
  it.each([
    ['salary', scoreRequest()],
    ['business', businessRequest()],
    ['mixed', mixedRequest()],
    ['no income', noIncomeRequest()],
    ['without stress / collateral not required', scoreRequest({ stress: undefined, collateralRequired: false, collateralValueTotal: 0 })],
  ])('%s: the record satisfies CalculationRecord', (_name, request) => {
    const record = toRecord(rowFrom({ request }));
    expect(CalculationRecord.safeParse(record).success, JSON.stringify(CalculationRecord.safeParse(record))).toBe(true);
    expect(record.inputs).toEqual(request);
    expect(record.computedAt).toBe(NOW.toISOString());
  });

  it('selection kind is derived: none / AUTO (selected_by null) / MANUAL (selected_by set)', () => {
    expect(selectionKindOf({ selectedMethod: null, selectedBy: null })).toBeNull();
    expect(selectionKindOf({ selectedMethod: 'A_SALARY', selectedBy: null })).toBe('AUTO');
    expect(selectionKindOf({ selectedMethod: 'A_SALARY', selectedBy: 'u' })).toBe('MANUAL');
    const record = toRecord(rowFrom({}, { selectedMethod: 'B_BUSINESS', selectedBy: 'user-9', selectedReason: 'тайлбар', selectedAt: NOW }));
    expect(record).toMatchObject({ selectedMethod: 'B_BUSINESS', selection: 'MANUAL', selectedBy: 'user-9', selectionReason: 'тайлбар', selectedAt: NOW.toISOString() });
    expect(CalculationRecord.safeParse(record).success).toBe(true);
  });

  it('carries the stale flag and reason', () => {
    expect(toRecord(rowFrom({}, { isStale: true, staleReason: 'Хүү өөрчлөгдсөн' }))).toMatchObject({ isStale: true, staleReason: 'Хүү өөрчлөгдсөн' });
  });

  it('a row without result_json is recomputed from the stored inputs (pure function — same value)', () => {
    const request = scoreRequest();
    const row = rowFrom({ request }, { resultJson: null });
    const recomputed: UnderwriteResult = resultOf(row);
    expect(recomputed).toEqual(underwrite(request));
    expect(CalculationRecord.safeParse(toRecord(row)).success).toBe(true);
  });
});
