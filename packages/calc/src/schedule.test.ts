import { describe, it, expect } from 'vitest';
import { annuityPayment, buildSchedule, summarizeSchedule, ScheduleError, type ScheduleParams } from './schedule';

const base: ScheduleParams = { principal: 30_000_000, annualRate: 23.99, termMonths: 36, type: 'ANNUITY', startDate: '2026-01-01', firstPaymentDate: '2026-02-01' };
const pay = (p: Partial<ScheduleParams>) => buildSchedule({ ...base, ...p }).filter((r) => r.seq > 0);
const code = (p: Partial<ScheduleParams>) => { try { buildSchedule({ ...base, ...p }); } catch (e) { return (e as ScheduleError).code; } return null; };

describe('annuityPayment', () => {
  it('30,000,000 @ 23.99% / 36 сар ≈ 1,176,828 (docs/04 M07 AC)', () => {
    expect(Math.abs(annuityPayment(30_000_000, 23.99, 36) - 1_176_828)).toBeLessThan(2);
  });
  it('0% хүүтэй бол тэнцүү хуваана', () => expect(annuityPayment(1200, 0, 12)).toBe(100));
});

describe('buildSchedule · ANNUITY (30/360)', () => {
  const rows = buildSchedule(base);
  it('AC: 36 төлбөр, сарын төлбөр ≈ 1,176,828 (±1₮), сүүлийн мөрөнд үлдэгдэл 0', () => {
    expect(rows).toHaveLength(37);
    expect(Math.abs(rows[1]!.total - 1_176_828)).toBeLessThanOrEqual(1);
    expect(rows[36]!.balance).toBe(0);
  });
  it('seq 0 = олголтын мөр; үлдэгдэл буурна, нийт = үндсэн + хүү', () => {
    expect(rows[0]).toMatchObject({ seq: 0, dueDate: '2026-01-01', disbursement: 30_000_000, total: 0, balance: 30_000_000 });
    for (let i = 1; i <= 36; i++) {
      expect(rows[i]!.total).toBeCloseTo(rows[i]!.principal + rows[i]!.interest, 2);
      expect(rows[i]!.balance).toBeLessThan(rows[i - 1]!.balance);
    }
    expect(rows[1]).toMatchObject({ dueDate: '2026-02-01', days: 30, interest: 599_750 });
    expect(rows[36]!.dueDate).toBe('2029-01-01');
  });
  it('нийлбэр: үндсэн = зээлийн дүн', () => {
    const s = summarizeSchedule(rows);
    expect(s).toMatchObject({ installments: 36, totalPrincipal: 30_000_000, firstDueDate: '2026-02-01', endDate: '2029-01-01' });
    expect(s.totalPayment).toBeCloseTo(s.totalPrincipal + s.totalInterest, 2);
  });
  it('0% хүү: интервал 0', () => {
    const r = pay({ annualRate: 0, principal: 1200, termMonths: 12 });
    expect(r.every((x) => x.interest === 0 && x.principal === 100)).toBe(true);
  });
  it('чөлөөлөх сар: эхний N сард зөвхөн хүү, дараа нь annuity', () => {
    const r = pay({ graceMonths: 3 });
    expect(r.slice(0, 3).every((x) => x.principal === 0 && x.balance === 30_000_000)).toBe(true);
    expect(r[3]!.principal).toBeGreaterThan(0);
    expect(r[35]!.balance).toBe(0);
    expect(Math.abs(r[3]!.total - annuityPayment(30_000_000, 23.99, 33))).toBeLessThanOrEqual(1);
  });
  it('хүү төлбөрөөс их болох урт эхний үе: үндсэн 0-ээс буурахгүй', () => {
    const r = pay({ principal: 1_000_000, annualRate: 60, termMonths: 6, startDate: '2026-01-01', firstPaymentDate: '2026-06-01' });
    expect(r[0]!.principal).toBe(0);
    expect(r[5]!.balance).toBe(0);
  });
});

describe('buildSchedule · бусад төрөл', () => {
  it('EQUAL_PRINCIPAL: тэнцүү үндсэн, хүү буурна, сүүлийн үлдэгдэл 0', () => {
    const r = pay({ type: 'EQUAL_PRINCIPAL', principal: 1_000_000, termMonths: 3 });
    expect(r.map((x) => x.principal)).toEqual([333_333.33, 333_333.33, 333_333.34]);
    expect(r[0]!.interest).toBeGreaterThan(r[1]!.interest);
    expect(r[2]!.balance).toBe(0);
  });
  it('EQUAL_PRINCIPAL + чөлөөлөх: чөлөөлөлтийн дараа тэнцүү үндсэн', () => {
    const r = pay({ type: 'EQUAL_PRINCIPAL', principal: 1_200_000, termMonths: 6, graceMonths: 2 });
    expect(r.map((x) => x.principal)).toEqual([0, 0, 300_000, 300_000, 300_000, 300_000]);
  });
  it('QUARTERLY: 3 сар тутамд, хүү улирлын хоногоор', () => {
    const r = pay({ type: 'QUARTERLY', principal: 1_200_000, termMonths: 12, firstPaymentDate: '2026-04-01' });
    expect(r.map((x) => x.dueDate)).toEqual(['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01']);
    expect(r.map((x) => x.principal)).toEqual([300_000, 300_000, 300_000, 300_000]);
    expect(r[1]!.days).toBe(90);
    expect(r[3]!.balance).toBe(0);
  });
  it('QUARTERLY: хугацаа 3-ын үржвэр биш бол алдаа', () => expect(code({ type: 'QUARTERLY', termMonths: 10 })).toBe('INVALID_TERM'));
  it('BULLET: хүү сар бүр, үндсэн сүүлд нь', () => {
    const r = pay({ type: 'BULLET', principal: 1_000_000, termMonths: 4 });
    expect(r.slice(0, 3).every((x) => x.principal === 0 && x.balance === 1_000_000 && x.interest > 0)).toBe(true);
    expect(r[3]).toMatchObject({ principal: 1_000_000, balance: 0 });
  });
  it('1 сарын хугацаа: нэг төлбөр', () => expect(pay({ termMonths: 1, principal: 100_000 })).toHaveLength(1));
});

describe('хоног тооцох арга', () => {
  it('ACT/365: хоног = бодит, хүү = үлдэгдэл × хүү × хоног/365', () => {
    const r = pay({ dayCount: 'ACT/365', principal: 1_000_000, annualRate: 36.5, termMonths: 2, startDate: '2026-01-01', firstPaymentDate: '2026-02-01' });
    expect(r[0]).toMatchObject({ days: 31, interest: 31_000 });
    expect(r[1]!.days).toBe(28);
    expect(r[1]!.balance).toBe(0);
  });
  it('30/360: сарын сүүлийн өдөр 2-р сард ч дараагийн үе 30 хоног', () => {
    const r = pay({ principal: 1_000_000, annualRate: 36, termMonths: 3, startDate: '2026-01-31', firstPaymentDate: '2026-02-28' });
    expect(r.map((x) => x.days)).toEqual([28, 30, 30]);
    expect(r.map((x) => x.dueDate)).toEqual(['2026-02-28', '2026-03-28', '2026-04-28']);
  });
  it('эхний төлбөрийн өдөр 31: сар богино бол сарын сүүлийн өдөр, дараа нь буцаж 31', () => {
    const r = pay({ termMonths: 3, startDate: '2026-01-15', firstPaymentDate: '2026-01-31' });
    expect(r.map((x) => x.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('жил дамжих', () => expect(pay({ termMonths: 3, startDate: '2026-11-01', firstPaymentDate: '2026-12-01' }).map((x) => x.dueDate)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']));
});

describe('шалгалт', () => {
  it.each([
    [{ principal: 0 }, 'INVALID_PRINCIPAL'], [{ principal: Number.NaN }, 'INVALID_PRINCIPAL'],
    [{ annualRate: -1 }, 'INVALID_RATE'], [{ annualRate: 101 }, 'INVALID_RATE'],
    [{ termMonths: 0 }, 'INVALID_TERM'], [{ termMonths: 1.5 }, 'INVALID_TERM'],
    [{ graceMonths: 36 }, 'INVALID_GRACE'], [{ graceMonths: -1 }, 'INVALID_GRACE'],
    [{ startDate: '2026-13-01' }, 'INVALID_DATE'], [{ firstPaymentDate: '2026-02-30' }, 'INVALID_DATE'], [{ firstPaymentDate: 'x' }, 'INVALID_DATE'],
    [{ firstPaymentDate: '2026-01-01' }, 'FIRST_PAYMENT_BEFORE_START'],
  ] as const)('%j → %s', (over, expected) => expect(code(over as Partial<ScheduleParams>)).toBe(expected));
  it('summarize: мөргүй бол хоосон огноо', () => expect(summarizeSchedule([])).toMatchObject({ installments: 0, firstDueDate: '', endDate: '' }));
});
