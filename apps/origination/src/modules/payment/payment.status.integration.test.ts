import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentView, RepaymentStatusView } from '@los/contracts';
import { actors, createBorrower, createCustomer, createSchedule, hasTestDb } from '../../test-utils/factories';
import { bootPayment, PaymentEnv, recordDirect, resetPayment, row, seedLoan, sumRows } from './payment.test-helpers';

describe.skipIf(!hasTestDb)('payment: repayment-status ба төлбөрийн жагсаалт (HTTP)', () => {
  let env: PaymentEnv;
  beforeAll(async () => { env = await bootPayment(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const status = (headers: Record<string, string>, id: string) => env.http().get(`/api/applications/${id}/repayment-status`).set(headers);
  const list = (headers: Record<string, string>, id: string) => env.http().get(`/api/applications/${id}/payments`).set(headers);

  describe('эрх', () => {
    it('нэвтрээгүй 401; үл мэдэгдэх 404; өөр ЗЭЗ 403; өөрийн ЗЭЗ, админ, батлагч (read), салбарын захирал OK', async () => {
      const { app } = await seedLoan(env);
      for (const fn of [status, list]) {
        expect((await fn(actors.anonymous(), app.id)).status).toBe(401);
        expect((await fn(actors.admin(), 'missing')).status).toBe(404);
        expect((await fn(actors.officer('officer-2'), app.id)).status).toBe(403);
        expect((await fn(actors.officer('officer-1'), app.id)).status).toBe(200);
        expect((await fn(actors.admin(), app.id)).status).toBe(200);
        expect((await fn(actors.approver(), app.id)).status).toBe(200);
        expect((await fn(actors.branchManager('bm', 'branch-1'), app.id)).status).toBe(200);
        expect((await fn(actors.branchManager('bm', 'branch-2'), app.id)).status).toBe(403);
      }
    });

    it('CUSTOMER: өөрийн (PRIMARY/CO_BORROWER) OK; өөр харилцагч, батлан даагч 403', async () => {
      const { app, customer } = await seedLoan(env);
      const co = await createCustomer(env.t.prisma);
      const guarantor = await createCustomer(env.t.prisma);
      const stranger = await createCustomer(env.t.prisma);
      await createBorrower(env.t.prisma, app.id, co.id, 'CO_BORROWER');
      await createBorrower(env.t.prisma, app.id, guarantor.id, 'GUARANTOR');
      for (const fn of [status, list]) {
        expect((await fn(actors.customer(customer.id), app.id)).status).toBe(200);
        expect((await fn(actors.customer(co.id), app.id)).status).toBe(200);
        expect((await fn(actors.customer(guarantor.id), app.id)).status).toBe(403);
        expect((await fn(actors.customer(stranger.id), app.id)).status).toBe(403);
      }
    });
  });

  describe('repayment-status', () => {
    it('одоогийн ЭТХ: мөр бүрийн төлөв, хоцролт, нийлбэр, payNowAmount, nextDue', async () => {
      const { app, rows } = await seedLoan(env);
      const res = await status(actors.officer(), app.id);
      expect(res.status).toBe(200);
      const v = RepaymentStatusView.parse(res.body);
      expect(v).toMatchObject({ applicationId: app.id, currency: 'MNT', asOf: '2026-10-28', applicationStatus: 'ACTIVE', payable: true });
      expect(v.installments).toHaveLength(12);
      expect(v.installments[0]).toMatchObject({ id: rows[0].id, seq: 1, dueDate: '2026-09-28', status: 'OVERDUE', daysOverdue: 30, paidTotal: 0, outstanding: row(rows, 0) });
      expect(v.installments[1]).toMatchObject({ seq: 2, dueDate: '2026-10-28', status: 'DUE', daysOverdue: 0 });
      expect(v.installments[2]).toMatchObject({ seq: 3, status: 'UPCOMING' });
      expect(v.payNowAmount).toBe(sumRows(rows, 0, 2));
      expect(v.nextDue).toEqual({ scheduleRowId: rows[0].id, dueDate: '2026-09-28', outstanding: row(rows, 0) });
      expect(v.totals.scheduled).toBe(sumRows(rows, 0, 12));
      expect(v.totals).toMatchObject({ paid: 0, outstanding: sumRows(rows, 0, 12), overdue: row(rows, 0) });
      expect(v.recentPayments).toEqual([]);
      expect(v.scheduleGeneratedAt).not.toBeNull();
    });

    it('төлбөрийн дараа: төлсөн хүү/үндсэн allocation-аас, PAID/PARTIAL, payNow, nextDue шинэчлэгдэнэ', async () => {
      const { app, rows } = await seedLoan(env);
      const extra = 1000;
      await recordDirect(env, app.id, row(rows, 0) + extra);
      const v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v.installments[0]).toMatchObject({ status: 'PAID', outstanding: 0, daysOverdue: 0, paidTotal: row(rows, 0), paidInterest: Number(rows[0].interest), paidPrincipal: Number(rows[0].principal) });
      expect(v.installments[1]).toMatchObject({ status: 'PARTIAL', paidInterest: extra, paidPrincipal: 0, paidTotal: extra });
      expect(v.payNowAmount).toBe(Math.round((row(rows, 1) - extra) * 100) / 100);
      expect(v.nextDue?.scheduleRowId).toBe(rows[1].id);
      expect(v.totals.paid).toBe(row(rows, 0) + extra);
      expect(v.totals.overdue).toBe(0);
      expect(v.recentPayments).toHaveLength(1);
      expect(v.recentPayments[0]).toMatchObject({ amount: row(rows, 0) + extra, unallocatedAmount: 0 });
      expect(v.recentPayments[0].allocations.map((a) => a.seq)).toEqual([1, 2]);
    });

    it('өдөр өнгөрвөл хоцролт нэмэгдэнэ (asOf = todayUB(clock))', async () => {
      const { app } = await seedLoan(env);
      env.t.clock.advanceMs(24 * 3_600_000);
      const v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v.asOf).toBe('2026-10-29');
      expect(v.installments[0]).toMatchObject({ status: 'OVERDUE', daysOverdue: 31 });
      expect(v.installments[1]).toMatchObject({ status: 'OVERDUE', daysOverdue: 1 });
    });

    it('бүх мөр төлөгдсөн: payNow 0, nextDue null, payable false', async () => {
      const { app, rows } = await seedLoan(env, { months: 2 });
      await recordDirect(env, app.id, sumRows(rows, 0, 2) + 500);
      const v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v.installments.every((i) => i.status === 'PAID')).toBe(true);
      expect(v).toMatchObject({ payNowAmount: 0, nextDue: null, payable: false });
      expect(v.totals.outstanding).toBe(0);
      expect(v.recentPayments[0].unallocatedAmount).toBe(500);
    });

    it('stale ЭТХ-г алгасч stale биш хамгийн сүүлийнхийг авна', async () => {
      const { app } = await seedLoan(env, { months: 12 });
      const newer = await createSchedule(env.t.prisma, app.id, { firstDue: '2026-10-28', principal: 300_000, months: 3 });
      let v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v.installments.map((i) => i.id)).toEqual(newer.rows.map((r) => r.id));
      await env.t.prisma.repaymentSchedule.update({ where: { id: newer.id }, data: { isStale: true } });
      v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v.installments).toHaveLength(12);
    });

    it('ЭТХ байхгүй/бүгд stale: 200, installments хоосон, payable=false; төлбөрүүд харагдана', async () => {
      const { app } = await seedLoan(env, { stale: true });
      await recordDirect(env, app.id, 7000);
      const v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v).toMatchObject({ installments: [], payable: false, scheduleGeneratedAt: null, payNowAmount: 0, nextDue: null, totals: { scheduled: 0, paid: 0, outstanding: 0, overdue: 0 } });
      expect(v.recentPayments).toHaveLength(1);
      expect(v.recentPayments[0].unallocatedAmount).toBe(7000);
    });

    it('ACTIVE/MIGRATED биш төлөвт payable=false боловч мэдээлэл өгнө', async () => {
      const { app } = await seedLoan(env, { status: 'CLOSED' });
      const v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v).toMatchObject({ applicationStatus: 'CLOSED', payable: false });
      expect(v.installments).toHaveLength(12);
      const m = await seedLoan(env, { status: 'MIGRATED' });
      expect(RepaymentStatusView.parse((await status(actors.officer(), m.app.id)).body).payable).toBe(true);
    });

    it('сүүлийн 10 төлбөр, шинэ нь эхэнд', async () => {
      const { app } = await seedLoan(env);
      for (let i = 1; i <= 12; i++) await recordDirect(env, app.id, 1000 + i, { id: `P${i}`, paidAt: new Date(Date.UTC(2026, 9, i, 5)) });
      const v = RepaymentStatusView.parse((await status(actors.officer(), app.id)).body);
      expect(v.recentPayments).toHaveLength(10);
      expect(v.recentPayments.map((p) => p.providerPaymentId)).toEqual(['P12', 'P11', 'P10', 'P9', 'P8', 'P7', 'P6', 'P5', 'P4', 'P3']);
    });

    it('өөр хүсэлтийн төлбөр хольцолддоггүй', async () => {
      const a = await seedLoan(env); const b = await seedLoan(env);
      await recordDirect(env, a.app.id, 5000);
      const v = RepaymentStatusView.parse((await status(actors.admin(), b.app.id)).body);
      expect(v.recentPayments).toEqual([]);
      expect(v.totals.paid).toBe(0);
    });
  });

  describe('GET applications/:id/payments', () => {
    it('шинэ нь эхэнд, allocation-тай, PaymentView-д нийцнэ', async () => {
      const { app, rows } = await seedLoan(env);
      await recordDirect(env, app.id, row(rows, 0), { id: 'A', paidAt: new Date('2026-10-20T05:00:00Z') });
      await recordDirect(env, app.id, 5000, { id: 'B', paidAt: new Date('2026-10-25T05:00:00Z') });
      const res = await list(actors.officer(), app.id);
      expect(res.status).toBe(200);
      const payments = (res.body as unknown[]).map((p) => PaymentView.parse(p));
      expect(payments.map((p) => p.providerPaymentId)).toEqual(['B', 'A']);
      expect(payments[1].allocations).toEqual([{ scheduleRowId: rows[0].id, seq: 1, dueDate: '2026-09-28', interestPaid: Number(rows[0].interest), principalPaid: Number(rows[0].principal), totalPaid: row(rows, 0) }]);
      expect(payments[0].allocations[0]).toMatchObject({ seq: 2, interestPaid: 5000, principalPaid: 0 });
    });

    it('хоосон жагсаалт', async () => {
      const { app } = await seedLoan(env);
      expect((await list(actors.officer(), app.id)).body).toEqual([]);
    });
  });
});
