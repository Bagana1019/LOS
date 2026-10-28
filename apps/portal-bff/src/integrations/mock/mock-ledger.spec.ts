import { annuityPayment } from '@los/calc';
import { PortalLoanBalance, PortalPayment, PortalSchedule, PortalLoanSummary } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../testing/test-app';
import { MockLedger } from './mock-ledger';
import { buildMockPdf } from './mock-pdf';

const C1 = 'cust_demo_001';
const C2 = 'cust_demo_002';
const make = (confirmMs = 1000) => {
  const clock = new FakeClock(new Date('2026-10-28T04:00:00Z'));
  return { clock, ledger: new MockLedger(clock, { timezone: 'Asia/Ulaanbaatar', paymentConfirmMs: confirmMs }) };
};
const cmd = (loanId: string, amount: number, amountType: 'CUSTOM' | 'PAYOFF' | 'OVERDUE' | 'INSTALLMENT' = 'CUSTOM') => ({ loanId, method: 'QPAY' as const, amountType, amount, currency: 'MNT' as const });

describe('MockLedger fixtures', () => {
  it('every fixture response satisfies the shared contract schemas', () => {
    const { ledger } = make();
    for (const cid of [C1, C2]) {
      for (const l of ledger.listLoans(cid)) {
        expect(() => PortalLoanSummary.parse(l)).not.toThrow();
        expect(() => PortalLoanBalance.parse(ledger.getBalance(cid, l.loanId))).not.toThrow();
        expect(() => PortalSchedule.parse(ledger.getSchedule(cid, l.loanId))).not.toThrow();
      }
    }
  });

  it('annuity schedule matches docs/04 M07 AC: 30,000,000 @ 23.99% / 36 → ≈1,176,828 and ends at zero', () => {
    const { ledger } = make();
    const s = ledger.getSchedule(C1, 'loan_demo_001');
    expect(Math.abs(s.rows[0].total - 1_176_828)).toBeLessThan(2);
    expect(Math.abs(s.rows[0].total - annuityPayment(30_000_000, 23.99, 36))).toBeLessThan(0.02);
    expect(s.rows).toHaveLength(36);
    expect(s.rows.at(-1)?.balance).toBe(0);
    expect(s.totals.principal).toBe(30_000_000);
    expect(s.rows.reduce((a, r) => a + r.principal, 0)).toBeCloseTo(30_000_000, 2);
    for (const r of s.rows) expect(r.principal + r.interest).toBeCloseTo(r.total, 2);
  });

  it('classifies schedule rows by date: PAID / OVERDUE / DUE / PARTIALLY_PAID / UPCOMING', () => {
    const { ledger, clock } = make();
    const st = (cid: string, loan: string) => ledger.getSchedule(cid, loan).rows.map((r) => r.status);
    expect(st(C2, 'loan_demo_003').slice(0, 6)).toEqual(['PAID', 'PAID', 'OVERDUE', 'OVERDUE', 'OVERDUE', 'UPCOMING']);
    // 5-р мөрийн төлөх өдөр (2026-10-23) биш, 6-р (2026-11-23) өдөр DUE болно
    clock.current = new Date('2026-11-23T04:00:00Z');
    expect(st(C2, 'loan_demo_003')[5]).toBe('DUE');
    clock.current = new Date('2026-11-24T04:00:00Z');
    expect(st(C2, 'loan_demo_003')[5]).toBe('OVERDUE');
  });

  it('uses the Ulaanbaatar business date: 16:00Z is already the next day', () => {
    const { ledger, clock } = make();
    clock.current = new Date('2026-10-22T16:00:00Z'); // УБ-т 10-23 00:00 → 5-р мөрийн өдөр DUE (хэтрээгүй)
    const rows = ledger.getSchedule(C2, 'loan_demo_003').rows;
    expect(rows[4].status).toBe('DUE');
    clock.current = new Date('2026-10-23T16:00:00Z');
    expect(ledger.getSchedule(C2, 'loan_demo_003').rows[4].status).toBe('OVERDUE');
  });

  it('scopes every read by customer', () => {
    const { ledger } = make();
    expect(() => ledger.getLoan(C1, 'loan_demo_003')).toThrow(expect.objectContaining({ code: 'LOAN_NOT_FOUND' }));
    expect(() => ledger.contractPdf(C2, 'loan_demo_001')).toThrow(expect.objectContaining({ code: 'LOAN_NOT_FOUND' }));
    expect(() => ledger.methods(C2, 'loan_demo_001')).toThrow(expect.objectContaining({ code: 'LOAN_NOT_FOUND' }));
    expect(() => ledger.getPayment(C1, 'pay_unknown')).toThrow(expect.objectContaining({ code: 'PAYMENT_NOT_FOUND' }));
    expect(ledger.findCustomer('УБ90010112', '99112233')).toEqual({ customerId: C1, displayName: 'Б. Болд' });
    expect(ledger.findCustomer('УБ90010112', '99999999')).toBeNull();
  });
});

describe('MockLedger payments', () => {
  it('allocates to the oldest installments first (interest, then principal) and conserves money', () => {
    const { ledger, clock } = make();
    const before = ledger.getBalance(C2, 'loan_demo_003');
    const rows = ledger.getSchedule(C2, 'loan_demo_003').rows;
    const one = rows[2].total; // 1 мөрийг яг хаах дүн
    const p = ledger.createPayment(C2, cmd('loan_demo_003', one), 'k-0000001');
    clock.advance(1500);
    expect(ledger.getPayment(C2, p.paymentId).status).toBe('PAID');
    const after = ledger.getBalance(C2, 'loan_demo_003');
    expect(after.overdue.total).toBeCloseTo(before.overdue.total - one, 2);
    expect(ledger.getSchedule(C2, 'loan_demo_003').rows.slice(0, 4).map((r) => r.status)).toEqual(['PAID', 'PAID', 'PAID', 'OVERDUE']);
    // Хэсэгчилсэн төлөлт: хүүнд эхэлж
    const p2 = ledger.createPayment(C2, cmd('loan_demo_003', 100), 'k-0000002');
    clock.advance(1500);
    ledger.getPayment(C2, p2.paymentId);
    const r4 = ledger.getSchedule(C2, 'loan_demo_003').rows[3];
    expect(r4.paidAmount).toBe(100);
    expect(r4.status).toBe('OVERDUE');
    const paidTotal = ledger.getSchedule(C2, 'loan_demo_003').totals.paid;
    expect(paidTotal).toBeCloseTo(rows[0].total + rows[1].total + one + 100, 2);
  });

  it('PAYOFF closes the loan, waives future interest, and later payments are refused', () => {
    const { ledger, clock } = make();
    const payoff = ledger.getBalance(C2, 'loan_demo_003').payoff.amount;
    const p = ledger.createPayment(C2, cmd('loan_demo_003', payoff, 'PAYOFF'), 'k-0000003');
    clock.advance(1500);
    expect(ledger.getPayment(C2, p.paymentId)).toMatchObject({ status: 'PAID' });
    const loan = ledger.listLoans(C2)[0];
    expect(loan).toMatchObject({ status: 'CLOSED', outstandingPrincipal: 0, overdueAmount: 0, nextInstallment: null });
    const sched = ledger.getSchedule(C2, 'loan_demo_003');
    expect(sched.rows.every((r) => r.status === 'PAID')).toBe(true);
    expect(sched.totals.paid).toBeCloseTo(sched.totals.total, 2);
    expect(sched.totals.principal).toBe(10_000_000);
    expect(sched.totals.interest).toBeLessThan(ledger.getSchedule(C1, 'loan_demo_001').totals.interest); // ирээдүйн хүү уучлагдсан
    expect(() => ledger.createPayment(C2, cmd('loan_demo_003', 1000), 'k-0000004')).toThrow(expect.objectContaining({ code: 'LOAN_NOT_PAYABLE' }));
  });

  it('is idempotent on (customer, key) and detects key reuse with a different body', () => {
    const { ledger } = make();
    const a = ledger.createPayment(C2, cmd('loan_demo_003', 1000), 'k-0000005');
    const b = ledger.createPayment(C2, cmd('loan_demo_003', 1000), 'k-0000005');
    expect(b.paymentId).toBe(a.paymentId);
    expect(() => ledger.createPayment(C2, cmd('loan_demo_003', 2000), 'k-0000005')).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    // өөр харилцагч ижил түлхүүрийг ашиглаж болно
    expect(ledger.createPayment(C1, cmd('loan_demo_001', 1000), 'k-0000005').paymentId).not.toBe(a.paymentId);
  });

  it('PENDING exposes checkout details only while pending; expires after 15 minutes', () => {
    const { ledger, clock } = make(3_600_000);
    const p = ledger.createPayment(C2, cmd('loan_demo_003', 1000), 'k-0000006');
    expect(PortalPayment.parse(p).checkout?.webUrl).toMatch(/^https:\/\//);
    clock.advance(14 * 60_000);
    expect(ledger.getPayment(C2, p.paymentId).status).toBe('PENDING');
    clock.advance(2 * 60_000);
    const expired = ledger.getPayment(C2, p.paymentId);
    expect(expired).toMatchObject({ status: 'EXPIRED', checkout: null, paidAt: null });
    // Үлдэгдэл өөрчлөгдөөгүй
    expect(ledger.getBalance(C2, 'loan_demo_003').overdue.total).toBe(2924613.81);
  });

  it('failNextPayment makes exactly the next payment fail without touching balances', () => {
    const { ledger, clock } = make();
    ledger.failNextPayment('CARD_DECLINED');
    const bad = ledger.createPayment(C2, cmd('loan_demo_003', 5000), 'k-0000007');
    const good = ledger.createPayment(C2, cmd('loan_demo_003', 5000), 'k-0000008');
    clock.advance(1500);
    expect(ledger.getPayment(C2, bad.paymentId)).toMatchObject({ status: 'FAILED', failureReason: 'CARD_DECLINED' });
    expect(ledger.getPayment(C2, good.paymentId).status).toBe('PAID');
    const rows = ledger.getSchedule(C2, 'loan_demo_003').rows;
    expect(ledger.getSchedule(C2, 'loan_demo_003').totals.paid).toBeCloseTo(rows[0].total + rows[1].total + 5000, 2); // зөвхөн амжилттай нь тусна
  });

  it('pages history newest first with a stable cursor', () => {
    const { ledger, clock } = make();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      ids.push(ledger.createPayment(C2, cmd('loan_demo_003', 1000 + i), `k-100000${i}`).paymentId);
    }
    const p1 = ledger.listPayments(C2, 'loan_demo_003', { limit: 2 });
    const p2 = ledger.listPayments(C2, 'loan_demo_003', { limit: 2, cursor: p1.nextCursor as string });
    const p3 = ledger.listPayments(C2, 'loan_demo_003', { limit: 2, cursor: p2.nextCursor as string });
    expect([...p1.items, ...p2.items, ...p3.items].map((p) => p.paymentId)).toEqual([...ids].reverse());
    expect(p3.nextCursor).toBeNull();
  });

  it('refuses an unknown cursor instead of silently restarting from page 1 (a client would loop forever)', () => {
    const { ledger, clock } = make();
    ledger.createPayment(C2, cmd('loan_demo_003', 1000), 'k-cursor-1');
    clock.advance(1000);
    expect(() => ledger.listPayments(C2, 'loan_demo_003', { limit: 2, cursor: 'pay_does_not_exist' })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});

describe('MockLedger payments across the Ulaanbaatar midnight', () => {
  it('a PAYOFF created at 23:50 and confirmed at 00:05 still closes the loan at the quoted amount', () => {
    const { ledger, clock } = make(12 * 60 * 1000); // баталгаажилт 12 минутын дараа (хугацаа 15 мин)
    clock.current = new Date('2026-10-28T15:50:00Z'); // УБ 23:50
    const payoff = ledger.getBalance(C1, 'loan_demo_001').payoff.amount;
    const created = ledger.createPayment(C1, cmd('loan_demo_001', payoff, 'PAYOFF'), 'k-midnight-1');
    expect(created.status).toBe('PENDING');
    clock.current = new Date('2026-10-28T16:05:00Z'); // УБ 00:05 маргааш
    const paid = ledger.getPayment(C1, created.paymentId);
    expect(paid.status).toBe('PAID');
    const after = ledger.getBalance(C1, 'loan_demo_001');
    expect(after.payoff.amount).toBe(0);
    expect(after.outstandingPrincipal).toBe(0);
    expect(ledger.listLoans(C1).find((l) => l.loanId === 'loan_demo_001')?.status).toBe('CLOSED');
  });
});

describe('buildMockPdf', () => {
  it('produces a structurally valid PDF with correct xref offsets and escapes text', () => {
    const pdf = buildMockPdf(['Hello (World) \\ ñ', 'line 2']);
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(text).toContain('Hello \\(World\\) \\\\ ?');
  });
});
