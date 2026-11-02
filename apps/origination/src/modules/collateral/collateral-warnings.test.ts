import { describe, expect, it } from 'vitest';
import { computeCollateralWarnings, type WarningSubject } from './collateral-warnings';
import { compareMonitoring, monitoringReasons } from './collateral-monitoring';

const TODAY = '2026-10-29';
const subject = (over: Partial<WarningSubject> = {}): WarningSubject => ({ id: 'c1', releasedAt: null, insuranceExpiresAt: null, nextRevaluationAt: null, ...over });
const run = (subjects: WarningSubject[], extra: { otherDrafts?: Record<string, string[]>; days?: number } = {}) =>
  computeCollateralWarnings({ subjects, today: TODAY, insuranceReminderDays: extra.days ?? 30, ...(extra.otherDrafts ? { otherDrafts: extra.otherDrafts } : {}) });

describe('computeCollateralWarnings', () => {
  it('анхааруулгагүй', () => {
    expect(run([subject()])).toEqual([]);
  });

  it('чөлөөлсөн барьцаа: зөвхөн RELEASED (бусад анхааруулга гарахгүй)', () => {
    const out = run([subject({ releasedAt: new Date(), insuranceExpiresAt: '2020-01-01', nextRevaluationAt: '2020-01-01' })], { otherDrafts: { c1: ['APP-1'] } });
    expect(out.map((w) => w.code)).toEqual(['RELEASED']);
  });

  it('өөр ноорогт бүртгэгдсэн: IN_OTHER_DRAFT нь хүсэлтийн дугаартай', () => {
    const out = run([subject()], { otherDrafts: { c1: ['APP-00002', 'APP-00003'], other: ['APP-9'] } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'IN_OTHER_DRAFT', collateralId: 'c1' });
    expect(out[0]!.message).toContain('APP-00002, APP-00003');
  });

  it('даатгал: reminder өдрийн дотор (inclusive) -> дуусна; хэтэрсэн -> анхааруулахгүй; өнгөрсөн -> дууссан', () => {
    expect(run([subject({ insuranceExpiresAt: '2026-11-28' })]).map((w) => w.code)).toEqual(['INSURANCE_EXPIRING']); // today + 30
    expect(run([subject({ insuranceExpiresAt: '2026-11-29' })])).toEqual([]); // today + 31
    expect(run([subject({ insuranceExpiresAt: TODAY })])[0]!.message).toContain('дуусна');
    const expired = run([subject({ insuranceExpiresAt: '2026-10-28' })]);
    expect(expired[0]).toMatchObject({ code: 'INSURANCE_EXPIRING' });
    expect(expired[0]!.message).toContain('дууссан');
  });

  it('insurance_reminder_days setting-ийг хүндэтгэнэ', () => {
    expect(run([subject({ insuranceExpiresAt: '2026-11-10' })], { days: 7 })).toEqual([]);
    expect(run([subject({ insuranceExpiresAt: '2026-11-10' })], { days: 14 })).toHaveLength(1);
  });

  it('дахин үнэлэх хугацаа: өнөөдөр болон өнгөрсөн -> REVALUATION_DUE; маргааш -> үгүй', () => {
    expect(run([subject({ nextRevaluationAt: TODAY })]).map((w) => w.code)).toEqual(['REVALUATION_DUE']);
    expect(run([subject({ nextRevaluationAt: '2026-01-01' })]).map((w) => w.code)).toEqual(['REVALUATION_DUE']);
    expect(run([subject({ nextRevaluationAt: '2026-10-30' })])).toEqual([]);
  });

  it('олон анхааруулга нэг барьцаанд (ноорог + даатгал + үнэлгээ), барьцаа бүр тус тусдаа', () => {
    const out = run([subject({ insuranceExpiresAt: '2026-11-01', nextRevaluationAt: '2026-10-01' }), subject({ id: 'c2' })], { otherDrafts: { c1: ['APP-1'] } });
    expect(out.map((w) => `${w.collateralId}:${w.code}`)).toEqual(['c1:IN_OTHER_DRAFT', 'c1:INSURANCE_EXPIRING', 'c1:REVALUATION_DUE']);
  });
});

describe('monitoringReasons', () => {
  const base = { today: TODAY, withinDays: 30, nextRevaluationAt: null, insuranceExpiresAt: null, ltvPass: true as boolean | null };

  it('шалтгаангүй', () => {
    expect(monitoringReasons(base)).toEqual([]);
  });

  it('REVALUATION_DUE: today + withinDays inclusive', () => {
    expect(monitoringReasons({ ...base, nextRevaluationAt: '2026-11-28' })).toEqual(['REVALUATION_DUE']);
    expect(monitoringReasons({ ...base, nextRevaluationAt: '2026-11-29' })).toEqual([]);
    expect(monitoringReasons({ ...base, nextRevaluationAt: '2025-01-01' })).toEqual(['REVALUATION_DUE']);
  });

  it('INSURANCE_EXPIRED (өнгөрсөн) vs INSURANCE_EXPIRING (өнөөдөр ... withinDays)', () => {
    expect(monitoringReasons({ ...base, insuranceExpiresAt: '2026-10-28' })).toEqual(['INSURANCE_EXPIRED']);
    expect(monitoringReasons({ ...base, insuranceExpiresAt: TODAY })).toEqual(['INSURANCE_EXPIRING']);
    expect(monitoringReasons({ ...base, insuranceExpiresAt: '2026-11-28' })).toEqual(['INSURANCE_EXPIRING']);
    expect(monitoringReasons({ ...base, insuranceExpiresAt: '2026-11-29' })).toEqual([]);
  });

  it('LTV_BREACH зөвхөн ltvPass === false; null (тооцох боломжгүй) бол үгүй', () => {
    expect(monitoringReasons({ ...base, ltvPass: false })).toEqual(['LTV_BREACH']);
    expect(monitoringReasons({ ...base, ltvPass: null })).toEqual([]);
  });

  it('бүх шалтгаан зэрэг: тогтсон дараалал', () => {
    expect(monitoringReasons({ ...base, nextRevaluationAt: TODAY, insuranceExpiresAt: '2020-01-01', ltvPass: false })).toEqual(['REVALUATION_DUE', 'INSURANCE_EXPIRED', 'LTV_BREACH']);
  });
});

describe('compareMonitoring', () => {
  const item = (nextRevaluationAt: string | null, appNo: string, collateralId = 'c') => ({ nextRevaluationAt, appNo, collateralId });
  it('дахин үнэлэх огноо ойр нь эхэнд, огноогүй нь сүүлд, дараа нь дугаараар', () => {
    const list = [item(null, 'APP-1'), item('2026-12-01', 'APP-3'), item('2026-11-01', 'APP-9'), item('2026-11-01', 'APP-2', 'z'), item('2026-11-01', 'APP-2', 'a')];
    expect(list.sort(compareMonitoring).map((i) => `${i.nextRevaluationAt}:${i.appNo}:${i.collateralId}`)).toEqual([
      '2026-11-01:APP-2:a', '2026-11-01:APP-2:z', '2026-11-01:APP-9:c', '2026-12-01:APP-3:c', 'null:APP-1:c',
    ]);
  });
});
