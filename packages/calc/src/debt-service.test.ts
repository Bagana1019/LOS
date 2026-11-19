import { describe, expect, it } from 'vitest';
import { annuityPayment, buildSchedule, debtServicePayment, scheduleDebtService, ScheduleError, type ScheduleParams } from './schedule';

// M11 / BR-1, BR-2 (docs/01 §8): ӨОХ/ӨТЧХ-ийн "шинэ зээлийн сарын төлөлт" = ЭТХ-ийн мөр бүрийн сарын эквивалент төлбөрийн оргил.
// Мөрийн эквивалент = хүү ÷ өмнөх төлбөрөөс хойших сар + үндсэн ÷ өмнөх үндсэн төлбөр (эсвэл олголт)-оос хойших сар.
const base: ScheduleParams = { principal: 1_200_000, annualRate: 24, termMonths: 12, type: 'ANNUITY', startDate: '2026-01-05', firstPaymentDate: '2026-02-05', dayCount: '30/360' };
const payments = (p: ScheduleParams) => buildSchedule(p).slice(1);

describe('debtServicePayment · ЭТХ-ийн төрөл бүр', () => {
  it('annuity → тогтмол төлбөр (annuityPayment)', () => {
    expect(scheduleDebtService(base)).toBeCloseTo(annuityPayment(1_200_000, 24, 12), 0);
  });

  it('тэнцүү үндсэн → эхний (хамгийн их) мөр: 100,000 + 24,000', () => {
    const v = scheduleDebtService({ ...base, type: 'EQUAL_PRINCIPAL' });
    expect(v).toBe(124_000);
    expect(v).toBeGreaterThan(annuityPayment(1_200_000, 24, 12));
  });

  it('bullet → сарын хүү + үндсэн ÷ хугацаа (сүүлийн 1.2 сая-г "сарын" гэж үзэхгүй, хүү дангаар нь ч биш)', () => {
    expect(scheduleDebtService({ ...base, type: 'BULLET' })).toBe(124_000);
  });

  it('хөнгөлөлттэй (grace 3) annuity → хөнгөлөлтийн дараах 9 сарын annuity (эхний хүү-дангаар биш)', () => {
    const v = scheduleDebtService({ ...base, graceMonths: 3 })!;
    expect(v).toBeCloseTo(annuityPayment(1_200_000, 24, 9), 0);
    expect(v).toBeGreaterThan(annuityPayment(1_200_000, 24, 12));
  });

  it('хөнгөлөлттэй (grace 2) тэнцүү үндсэн → хөнгөлөлтийн дараах бүтэн мөр (1.2сая/10 + 1.08сая×2%)', () => {
    expect(scheduleDebtService({ ...base, type: 'EQUAL_PRINCIPAL', graceMonths: 2 })).toBe(120_000 + 21_600);
  });

  it('улирлын (эхний төлбөр 3 сарын дараа) → нийт ÷ 3', () => {
    expect(scheduleDebtService({ ...base, type: 'QUARTERLY', firstPaymentDate: '2026-04-05' })).toBe((300_000 + 72_000) / 3);
  });

  it('улирлын боловч эхний төлбөр 1 сарын дараа → тэр сард бодитоор төлөх 324,000', () => {
    expect(scheduleDebtService({ ...base, type: 'QUARTERLY' })).toBe(324_000);
  });

  it('хүү 0, тэнцүү үндсэн → дүн ÷ хугацаа', () => {
    expect(scheduleDebtService({ ...base, annualRate: 0, type: 'EQUAL_PRINCIPAL', termMonths: 3 })).toBe(400_000);
  });

  it('хугацаа 1 сар → нэг мөр', () => {
    expect(scheduleDebtService({ ...base, termMonths: 1, type: 'BULLET' })).toBe(1_224_000);
  });
});

describe('debtServicePayment · ирмэг ба алдаа', () => {
  it('мөргүй → null', () => {
    expect(debtServicePayment('2026-01-05', [])).toBeNull();
  });

  it('эрэмбэгүй оролт → ижил үр дүн, оролтыг өөрчлөхгүй', () => {
    const rows = payments({ ...base, type: 'EQUAL_PRINCIPAL' }).map(({ dueDate, principal, interest }) => ({ dueDate, principal, interest }));
    const reversed = [...rows].reverse();
    const copy = JSON.stringify(reversed);
    expect(debtServicePayment(base.startDate, reversed)).toBe(124_000);
    expect(JSON.stringify(reversed)).toBe(copy);
  });

  it('ижил өдрийн хоёр мөр → хуваагч доод тал нь 1 сар', () => {
    expect(debtServicePayment('2026-01-05', [{ dueDate: '2026-02-05', principal: 0, interest: 10 }, { dueDate: '2026-02-05', principal: 100, interest: 0 }])).toBe(100);
  });

  it('45 хоногийн эхний үе → 1 сар гэж бөөрөнхийлнө', () => {
    expect(debtServicePayment('2026-01-01', [{ dueDate: '2026-02-15', principal: 1_000, interest: 90 }])).toBe(1_090);
  });

  it('буруу огноо → INVALID_DATE', () => {
    expect(() => debtServicePayment('2026-13-01', [{ dueDate: '2026-02-05', principal: 1, interest: 0 }])).toThrow(ScheduleError);
    expect(() => debtServicePayment('2026-01-05', [{ dueDate: 'bad', principal: 1, interest: 0 }])).toThrow(expect.objectContaining({ code: 'INVALID_DATE' }));
  });

  it('сөрөг / тоо биш дүн → INVALID_PRINCIPAL', () => {
    expect(() => debtServicePayment('2026-01-05', [{ dueDate: '2026-02-05', principal: -1, interest: 0 }])).toThrow(expect.objectContaining({ code: 'INVALID_PRINCIPAL' }));
    expect(() => debtServicePayment('2026-01-05', [{ dueDate: '2026-02-05', principal: 1, interest: Number.NaN }])).toThrow(expect.objectContaining({ code: 'INVALID_PRINCIPAL' }));
  });

  it('олголтоос өмнөх төлбөр → FIRST_PAYMENT_BEFORE_START', () => {
    expect(() => debtServicePayment('2026-03-01', [{ dueDate: '2026-02-05', principal: 1, interest: 0 }])).toThrow(expect.objectContaining({ code: 'FIRST_PAYMENT_BEFORE_START' }));
  });

  it('scheduleDebtService буруу параметрт buildSchedule-ийн алдааг дамжуулна', () => {
    expect(() => scheduleDebtService({ ...base, termMonths: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_TERM' }));
  });
});
