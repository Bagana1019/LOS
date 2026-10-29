import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { AllocatableInstallment } from '@los/calc';
import { resolveInvoiceAmount } from './invoice-amount';

const inst = (seq: number, dueDate: string, interest: number, principal: number, paidInterest = 0, paidPrincipal = 0): AllocatableInstallment => ({ id: `r${seq}`, seq, dueDate, interest, principal, paidInterest, paidPrincipal });
// 3 мөр, мөр бүр 100,000 (хүү 20,000 + үндсэн 80,000)
const rows = (over: Partial<Record<number, [number, number]>> = {}) => [
  inst(1, '2026-09-28', 20_000, 80_000, ...(over[1] ?? [0, 0])),
  inst(2, '2026-10-28', 20_000, 80_000, ...(over[2] ?? [0, 0])),
  inst(3, '2026-11-28', 20_000, 80_000, ...(over[3] ?? [0, 0])),
];
const ASOF = '2026-10-28';
const base = { minAmount: 1000, asOf: ASOF };

function fail(fn: () => unknown): { status: number; code: string; message: string } {
  try { fn(); } catch (e) {
    const ex = e as HttpException;
    const body = ex.getResponse() as { code: string; message: string };
    return { status: ex.getStatus(), ...body };
  }
  throw new Error('алдаа шидэх ёстой байсан');
}

describe('resolveInvoiceAmount (бизнес дүрэм 1)', () => {
  it('юу ч өгөөгүй: payNowAmount (хэтэрсэн + өнөөдөр)', () => {
    expect(resolveInvoiceAmount({ ...base, installments: rows() })).toBe(200_000);
  });

  it('юу ч өгөөгүй, хугацаа хэтрээгүй бол дараагийн мөрийн үлдэгдэл', () => {
    expect(resolveInvoiceAmount({ ...base, installments: rows(), asOf: '2026-09-01' })).toBe(100_000);
  });

  it('scheduleRowId: тэр мөрийн үлдэгдэл (хэсэгчлэн төлсөн бол үлдэгдэл)', () => {
    expect(resolveInvoiceAmount({ ...base, installments: rows(), scheduleRowId: 'r2' })).toBe(100_000);
    expect(resolveInvoiceAmount({ ...base, installments: rows({ 2: [20_000, 30_000] }), scheduleRowId: 'r2' })).toBe(50_000);
  });

  it('scheduleRowId + amount ≤ мөрийн үлдэгдэл', () => {
    expect(resolveInvoiceAmount({ ...base, installments: rows(), scheduleRowId: 'r2', amount: 40_000 })).toBe(40_000);
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: rows(), scheduleRowId: 'r2', amount: 100_000.01 }))).toMatchObject({ status: 422, code: 'AMOUNT_OUT_OF_RANGE' });
  });

  it('бүрэн төлөгдсөн мөр → 409 INSTALLMENT_PAID', () => {
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: rows({ 1: [20_000, 80_000] }), scheduleRowId: 'r1' }))).toMatchObject({ status: 409, code: 'INSTALLMENT_PAID' });
  });

  it('мөр олдохгүй → 404 SCHEDULE_ROW_NOT_FOUND', () => {
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: rows(), scheduleRowId: 'nope' }))).toMatchObject({ status: 404, code: 'SCHEDULE_ROW_NOT_FOUND' });
  });

  it('amount: нийт үлдэгдэл хүртэл (урьдчилсан төлөлт), түүнээс их бол 422', () => {
    expect(resolveInvoiceAmount({ ...base, installments: rows(), amount: 250_000 })).toBe(250_000);
    expect(resolveInvoiceAmount({ ...base, installments: rows(), amount: 300_000 })).toBe(300_000);
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: rows(), amount: 300_000.01 }))).toMatchObject({ status: 422, code: 'AMOUNT_OUT_OF_RANGE' });
  });

  it('payment.min_amount-аас бага дүн → 422, мессежэд хязгаар', () => {
    const err = fail(() => resolveInvoiceAmount({ ...base, installments: rows(), amount: 999 }));
    expect(err).toMatchObject({ status: 422, code: 'AMOUNT_OUT_OF_RANGE' });
    expect(err.message).toContain('1,000');
    expect(err.message).toContain('300,000');
    expect(resolveInvoiceAmount({ ...base, installments: rows(), amount: 1000 })).toBe(1000);
  });

  it('нийт үлдэгдэл 0 → 409 LOAN_FULLY_PAID', () => {
    const paid = rows({ 1: [20_000, 80_000], 2: [20_000, 80_000], 3: [20_000, 80_000] });
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: paid }))).toMatchObject({ status: 409, code: 'LOAN_FULLY_PAID' });
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: [] }))).toMatchObject({ status: 409, code: 'LOAN_FULLY_PAID' });
  });

  it('үлдэгдэл min_amount-аас бага бол яг үлдэгдлийг төлж болно (барьцаалагдахгүй)', () => {
    const almost = [inst(1, '2026-10-01', 300, 200, 0, 0)]; // үлдэгдэл 500
    expect(resolveInvoiceAmount({ ...base, installments: almost })).toBe(500);
    expect(resolveInvoiceAmount({ ...base, installments: almost, amount: 500 })).toBe(500);
    expect(fail(() => resolveInvoiceAmount({ ...base, installments: almost, amount: 400 }))).toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
  });

  it('ЭТХ-ийн мөрийн үлдэгдэл min-ээс бага: мөрийн үлдэгдлийг яг төлнө', () => {
    const r = rows({ 2: [20_000, 79_500] }); // мөр 2-ын үлдэгдэл 500
    expect(resolveInvoiceAmount({ ...base, installments: r, scheduleRowId: 'r2' })).toBe(500);
  });

  describe('"Одоо төлөх" дүн min_amount-аас бага үед (регресс)', () => {
    // Мөр 1 (хугацаа хэтэрсэн)-ийн 300₮ л үлдсэн; бусад мөр хараахан болоогүй. payNowAmount = 300, min_amount = 1000.
    const almostPaid = () => [inst(1, '2026-09-28', 20_000, 80_000, 20_000, 79_700), inst(2, '2026-11-28', 20_000, 80_000), inst(3, '2026-12-28', 20_000, 80_000)];

    it('дүн/мөр заагаагүй: хугацаа болсон 300₮-ийн үлдэгдлийг яг төлж болно (422 биш)', () => {
      expect(resolveInvoiceAmount({ ...base, installments: almostPaid() })).toBe(300);
    });

    it('мөр сонгох горим ижил үр дүн (ROW)', () => {
      expect(resolveInvoiceAmount({ ...base, installments: almostPaid(), scheduleRowId: 'r1' })).toBe(300);
    });

    it('хэд хэдэн мөрийн нийлбэр үлдэгдэл min-ээс бага ч яг нийлбэрээр', () => {
      const r = [inst(1, '2026-10-01', 100, 100, 0, 0), inst(2, '2026-10-20', 100, 100, 0, 0), inst(3, '2026-12-01', 20_000, 80_000)]; // хэтэрсэн 400
      expect(resolveInvoiceAmount({ ...base, installments: r })).toBe(400);
    });

    it('харин ӨӨРИЙН заасан дүн (мөргүй) min_amount-аас бага бол 422 хэвээр', () => {
      expect(fail(() => resolveInvoiceAmount({ ...base, installments: almostPaid(), amount: 300 }))).toMatchObject({ status: 422, code: 'AMOUNT_OUT_OF_RANGE' });
    });
  });

  it('дүнг 2 оронд бөөрөнхийлнө', () => {
    expect(resolveInvoiceAmount({ ...base, installments: rows(), amount: 1234.5 })).toBe(1234.5);
  });
});
