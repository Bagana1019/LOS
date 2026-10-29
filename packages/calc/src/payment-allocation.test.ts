import { describe, it, expect } from 'vitest';
import { allocatePayment, installmentState, outstandingOf, payNowAmount, type AllocatableInstallment } from './payment-allocation';

const inst = (o: Partial<AllocatableInstallment> & { id: string; seq: number; dueDate: string }): AllocatableInstallment => ({
  interest: 100, principal: 900, paidInterest: 0, paidPrincipal: 0, ...o,
});
const schedule = [
  inst({ id: 'r3', seq: 3, dueDate: '2026-12-10' }),
  inst({ id: 'r1', seq: 1, dueDate: '2026-10-10' }),
  inst({ id: 'r2', seq: 2, dueDate: '2026-11-10' }),
];

describe('allocatePayment', () => {
  it('хамгийн эрт мөрөөс, хүү → үндсэн зээл дарааллаар', () => {
    const r = allocatePayment(schedule, 1050);
    expect(r.lines).toEqual([
      { installmentId: 'r1', interestPaid: 100, principalPaid: 900, totalPaid: 1000 },
      { installmentId: 'r2', interestPaid: 50, principalPaid: 0, totalPaid: 50 },
    ]);
    expect(r.allocated).toBe(1050);
    expect(r.unallocated).toBe(0);
  });
  it('өмнө нь хэсэгчлэн төлсөн мөрийн үлдэгдлээс үргэлжлүүлнэ', () => {
    const s = [inst({ id: 'a', seq: 1, dueDate: '2026-10-10', paidInterest: 100, paidPrincipal: 400 }), inst({ id: 'b', seq: 2, dueDate: '2026-11-10' })];
    const r = allocatePayment(s, 600);
    expect(r.lines).toEqual([
      { installmentId: 'a', interestPaid: 0, principalPaid: 500, totalPaid: 500 },
      { installmentId: 'b', interestPaid: 100, principalPaid: 0, totalPaid: 100 },
    ]);
  });
  it('бүх хуваарь төлөгдсөний дараах илүүг unallocated гэнэ', () => {
    const r = allocatePayment(schedule, 3500.5);
    expect(r.allocated).toBe(3000);
    expect(r.unallocated).toBe(500.5);
    expect(r.lines).toHaveLength(3);
  });
  it('бүрэн төлөгдсөн мөрийг алгасна; хоосон хуваарьт бүгд unallocated', () => {
    const paid = [inst({ id: 'p', seq: 1, dueDate: '2026-09-10', paidInterest: 100, paidPrincipal: 900 })];
    expect(allocatePayment(paid, 10)).toEqual({ lines: [], allocated: 0, unallocated: 10 });
    expect(allocatePayment([], 10)).toEqual({ lines: [], allocated: 0, unallocated: 10 });
  });
  it('хоёр орны нарийвчлал: 0.1 + 0.2 төрлийн алдаагүй', () => {
    const s = [inst({ id: 'x', seq: 1, dueDate: '2026-10-10', interest: 0.1, principal: 0.2 })];
    const r = allocatePayment(s, 0.3);
    expect(r.lines[0].totalPaid).toBe(0.3);
    expect(r.unallocated).toBe(0);
  });
  it('ижил өдөртэй мөрүүдийг seq-ээр эрэмбэлнэ', () => {
    const s = [inst({ id: 'b', seq: 2, dueDate: '2026-10-10' }), inst({ id: 'a', seq: 1, dueDate: '2026-10-10' })];
    expect(allocatePayment(s, 10).lines[0].installmentId).toBe('a');
  });
  it('эерэг биш дүнг татгалзана', () => {
    expect(() => allocatePayment(schedule, 0)).toThrow();
    expect(() => allocatePayment(schedule, -5)).toThrow();
    expect(() => allocatePayment(schedule, NaN)).toThrow();
  });
});

describe('installmentState / outstanding / payNow', () => {
  const base = inst({ id: 'r', seq: 1, dueDate: '2026-10-28' });
  it('статус', () => {
    expect(installmentState(base, '2026-10-20')).toMatchObject({ status: 'UPCOMING', daysOverdue: 0, outstanding: 1000 });
    expect(installmentState(base, '2026-10-28')).toMatchObject({ status: 'DUE' });
    expect(installmentState(base, '2026-11-02')).toMatchObject({ status: 'OVERDUE', daysOverdue: 5 });
    expect(installmentState({ ...base, paidInterest: 100 }, '2026-10-20')).toMatchObject({ status: 'PARTIAL', paidTotal: 100, outstanding: 900 });
    expect(installmentState({ ...base, paidInterest: 100 }, '2026-12-01')).toMatchObject({ status: 'OVERDUE' });
    expect(installmentState({ ...base, paidInterest: 100, paidPrincipal: 900 }, '2026-12-01')).toMatchObject({ status: 'PAID', outstanding: 0 });
  });
  it('outstandingOf илүү төлөлтөд сөрөг болохгүй', () => {
    expect(outstandingOf({ ...base, paidInterest: 150, paidPrincipal: 900 })).toBe(0);
  });
  it('payNowAmount: хэтэрсэн + өнөөдөр; үгүй бол дараагийн; бүгд төлөгдсөн бол 0', () => {
    expect(payNowAmount(schedule, '2026-11-10')).toBe(2000); // r1 (хэтэрсэн) + r2 (өнөөдөр)
    expect(payNowAmount(schedule, '2026-10-01')).toBe(1000); // дараагийн мөр
    expect(payNowAmount([inst({ id: 'p', seq: 1, dueDate: '2026-09-10', paidInterest: 100, paidPrincipal: 900 })], '2026-10-01')).toBe(0);
    expect(payNowAmount([], '2026-10-01')).toBe(0);
  });
});
