import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankNameCheckResponse, BankReconcileResponse } from '@los/contracts';
import { actors, hasTestDb } from '../../test-utils/factories';
import { bootPayment, makeInvoice, paymentEvents, PaymentEnv, resetPayment, seedLoan, sumRows } from './payment.test-helpers';
import { PaymentService } from './payment.service';

describe.skipIf(!hasTestDb)('payment: банкны шилжүүлгийн тулгалт ба нэр-дугаар тулгалт (HTTP)', () => {
  let env: PaymentEnv;
  beforeAll(async () => { env = await bootPayment(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const reconcile = (headers: Record<string, string> = actors.admin(), body?: object) => env.http().post('/api/payments/bank-transfers/reconcile').set(headers).send(body ?? {});
  const bankInvoice = async (amount?: number) => {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'BANK_TRANSFER', ...(amount ? { amount } : {}) });
    return { ...loan, ...inv };
  };

  describe('POST payments/bank-transfers/reconcile', () => {
    it('зөвхөн ADMIN: нэвтрээгүй 401, ЗЭЗ/батлагч 403', async () => {
      expect((await reconcile(actors.anonymous())).status).toBe(401);
      expect((await reconcile(actors.officer())).status).toBe(403);
      expect((await reconcile(actors.approver())).status).toBe(403);
      expect((await reconcile(actors.admin())).status).toBe(200);
    });

    it('гүйлгээний утгын senderInvoiceNo-оор таарч Payment үүснэ; entry MATCHED; invoice PAID; event', async () => {
      const { app, view, rows } = await bankInvoice(50_000);
      env.bank.pushIncoming({ amount: 50_000, description: `Зээлийн төлбөр ${view.senderInvoiceNo} баярлалаа`, payerName: 'Бат Дорж', payerAccount: '5099887766' });

      const res = await reconcile();
      expect(res.status).toBe(200);
      expect(BankReconcileResponse.parse(res.body)).toEqual({ fetched: 1, matched: 1, duplicates: 0, unmatched: 0, errors: 0 });

      const [payment] = await env.t.prisma.payment.findMany({ include: { allocations: true } });
      expect(payment).toMatchObject({ applicationId: app.id, invoiceId: view.id, provider: 'BANK_TRANSFER', providerPaymentId: 'KHAN:MOCKTXN-0001', payerAccountMasked: '******7766', payerName: 'Бат Дорж', createdBy: 'admin-1' });
      expect(Number(payment.amount)).toBe(50_000);
      expect(payment.allocations.reduce((s, a) => s + Number(a.totalPaid), 0)).toBe(50_000);
      expect(payment.allocations[0].scheduleRowId).toBe(rows[0].id);

      const entry = await env.t.prisma.bankTransferEntry.findFirstOrThrow();
      expect(entry).toMatchObject({ bankCode: 'KHAN', bankReference: 'MOCKTXN-0001', status: 'MATCHED', paymentId: payment.id, payerAccountMasked: '******7766', orgId: 'org-test' });
      expect(JSON.stringify(entry.rawJson)).not.toContain('5099887766');
      expect(JSON.stringify(payment.rawJson)).not.toContain('5099887766');
      expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PAID');
      const events = await paymentEvents(env);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ provider: 'BANK_TRANSFER', amount: 50_000, applicationId: app.id });
    });

    it('давхар дуудахад дахин бүртгэхгүй (duplicates)', async () => {
      const { view } = await bankInvoice(50_000);
      env.bank.pushIncoming({ amount: 50_000, description: view.senderInvoiceNo });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 1, matched: 1, duplicates: 0, unmatched: 0, errors: 0 });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 1, matched: 0, duplicates: 1, unmatched: 0, errors: 0 });
      expect(await env.t.prisma.payment.count()).toBe(1);
      expect(await env.t.prisma.bankTransferEntry.count()).toBe(1);
      expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
    });

    it('олдохгүй бол UNMATCHED (мөр хадгалагдана, давтан дуудахад давхардахгүй)', async () => {
      await bankInvoice();
      env.bank.pushIncoming({ amount: 12_345, description: 'найзад мөнгө шилжүүлэв' });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 1, matched: 0, duplicates: 0, unmatched: 1, errors: 0 });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 1, matched: 0, duplicates: 0, unmatched: 1, errors: 0 });
      const entries = await env.t.prisma.bankTransferEntry.findMany();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: 'UNMATCHED', paymentId: null });
      expect(Number(entries[0].amount)).toBe(12_345);
      expect(await env.t.prisma.payment.count()).toBe(0);
    });

    it('гэрээний дугаараар таарна (invoice-гүй); дараа нь гэрээний дугаар нэмэгдвэл UNMATCHED мөр дахин оролдогдоно', async () => {
      const loan = await seedLoan(env);
      env.bank.pushIncoming({ amount: 30_000, description: 'Гэрээ B10026021501 сарын төлбөр' });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 1, matched: 0, duplicates: 0, unmatched: 1, errors: 0 });
      await env.t.prisma.loanApplication.update({ where: { id: loan.app.id }, data: { contractNo: 'B10026021501' } });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 1, matched: 1, duplicates: 0, unmatched: 0, errors: 0 });
      const [p] = await env.t.prisma.payment.findMany();
      expect(p).toMatchObject({ applicationId: loan.app.id, invoiceId: null, provider: 'BANK_TRANSFER' });
      expect(Number(p.unallocatedAmount)).toBe(0);
    });

    it('өөр байгууллагын invoice/гэрээг таньдаггүй', async () => {
      const loan = await seedLoan(env, { contractNo: 'B77777777' });
      await env.t.prisma.loanApplication.update({ where: { id: loan.app.id }, data: { orgId: 'other-org' } });
      env.bank.pushIncoming({ amount: 5000, description: 'B77777777' });
      expect(BankReconcileResponse.parse((await reconcile()).body).unmatched).toBe(1);
    });

    it('дүн invoice-тэй таарахгүй бол орж ирсэн дүнгээр бүртгэнэ', async () => {
      const { view } = await bankInvoice(50_000);
      env.bank.pushIncoming({ amount: 65_000, description: view.senderInvoiceNo });
      await reconcile();
      const [p] = await env.t.prisma.payment.findMany();
      expect(Number(p.amount)).toBe(65_000);
      expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PAID');
    });

    it('хугацаа дууссан invoice-д хожуу орсон шилжүүлгийг ч бүртгэнэ', async () => {
      const { view } = await bankInvoice(20_000);
      await env.t.prisma.paymentInvoice.update({ where: { id: view.id }, data: { status: 'EXPIRED' } });
      env.bank.pushIncoming({ amount: 20_000, description: view.senderInvoiceNo });
      expect(BankReconcileResponse.parse((await reconcile()).body).matched).toBe(1);
      expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PAID');
    });

    it('олон шилжүүлэг: тус бүр өөр invoice/хүсэлтэд', async () => {
      const a = await bankInvoice(10_000); const b = await bankInvoice(20_000);
      env.bank.pushIncoming({ amount: 10_000, description: a.view.senderInvoiceNo });
      env.bank.pushIncoming({ amount: 20_000, description: `төлбөр ${b.view.senderInvoiceNo}` });
      env.bank.pushIncoming({ amount: 777, description: 'тодорхойгүй' });
      expect(BankReconcileResponse.parse((await reconcile()).body)).toEqual({ fetched: 3, matched: 2, duplicates: 0, unmatched: 1, errors: 0 });
      expect((await env.t.prisma.payment.findMany({ where: { applicationId: a.app.id } })).length).toBe(1);
      expect((await env.t.prisma.payment.findMany({ where: { applicationId: b.app.id } })).length).toBe(1);
    });

    it('ЗЭРЭГЦЭЭ 3 тулгалт (Promise.all) → шилжүүлэг бүрт яг нэг Payment', async () => {
      const a = await bankInvoice(10_000); const b = await bankInvoice(20_000);
      env.bank.pushIncoming({ amount: 10_000, description: a.view.senderInvoiceNo });
      env.bank.pushIncoming({ amount: 20_000, description: b.view.senderInvoiceNo });
      env.bank.pushIncoming({ amount: 5, description: 'x' });
      const results = await Promise.all([reconcile(), reconcile(), reconcile()]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await env.t.prisma.payment.count()).toBe(2);
      expect(await env.t.prisma.bankTransferEntry.count()).toBe(3);
      expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(2);
      const totals = results.map((r) => BankReconcileResponse.parse(r.body));
      expect(totals.reduce((s, t) => s + t.matched, 0)).toBe(2); // яг 2 удаа "matched" болсон
    });

    it('since: огноогоор шүүнэ; анхдагч нь сүүлийн 30 хоног', async () => {
      const { view } = await bankInvoice(10_000);
      env.bank.pushIncoming({ amount: 1000, description: 'a', valueDate: new Date('2026-08-01T00:00:00Z') });
      env.bank.pushIncoming({ amount: 10_000, description: view.senderInvoiceNo, valueDate: new Date('2026-10-20T00:00:00Z') });
      expect(BankReconcileResponse.parse((await reconcile()).body).fetched).toBe(1); // 30 хоногоос өмнөх орхигдоно
      await env.t.prisma.bankTransferEntry.deleteMany();
      expect(BankReconcileResponse.parse((await reconcile(actors.admin(), { since: '2026-07-01T00:00:00Z' })).body).fetched).toBe(2);
    });

    it('since буруу формат → 400', async () => {
      expect((await reconcile(actors.admin(), { since: 'өчигдөр' })).status).toBe(400);
    });

    it('банкны gateway унтарсан → 502 PROVIDER_UNAVAILABLE', async () => {
      env.bank.failNext({ method: 'listIncomingTransfers' });
      const res = await reconcile();
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('зөвхөн эерэг дүнтэй (орлого) шилжүүлэг', async () => {
      env.bank.pushIncoming({ amount: -500, description: 'зарлага' });
      const res = BankReconcileResponse.parse((await reconcile()).body);
      expect(res).toEqual({ fetched: 1, matched: 0, duplicates: 0, unmatched: 0, errors: 0 });
      expect(await env.t.prisma.bankTransferEntry.count()).toBe(0);
    });

    describe('нэг гүйлгээний алдаа бусдыг хаахгүй (poison row)', () => {
      it('0.004₮ (2 оронд бөөрөнхийлөхөд 0) гүйлгээ алгасагдаж, дараагийн жинхэнэ гүйлгээ бүртгэгдэнэ — давтан дуудахад ч', async () => {
        const a = await bankInvoice(5000); const b = await bankInvoice(6000);
        env.bank.pushIncoming({ amount: 0.004, description: a.view.senderInvoiceNo, valueDate: new Date('2026-10-27T01:00:00Z') });
        env.bank.pushIncoming({ amount: 6000, description: b.view.senderInvoiceNo, valueDate: new Date('2026-10-27T02:00:00Z') });

        const first = await reconcile();
        expect(first.status).toBe(200);
        expect(BankReconcileResponse.parse(first.body)).toEqual({ fetched: 2, matched: 1, duplicates: 0, unmatched: 0, errors: 0 });
        expect(await env.t.prisma.payment.count()).toBe(1);
        expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: b.view.id } })).status).toBe('PAID');
        expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: a.view.id } })).status).toBe('PENDING');

        const second = await reconcile();
        expect(second.status).toBe(200);
        expect(BankReconcileResponse.parse(second.body)).toMatchObject({ matched: 0, errors: 0 });
        expect(await env.t.prisma.payment.count()).toBe(1);
      });

      it('recordPayment нэг гүйлгээнд унавал: errors=1, entry FAILED, бусад гүйлгээ бүртгэгдэнэ; дараагийн тулгалт FAILED-ийг дахин оролдож MATCHED болгоно', async () => {
        const a = await bankInvoice(5000); const b = await bankInvoice(6000);
        env.bank.pushIncoming({ amount: 5000, description: a.view.senderInvoiceNo, bankReference: 'BAD-1', valueDate: new Date('2026-10-27T01:00:00Z') });
        env.bank.pushIncoming({ amount: 6000, description: b.view.senderInvoiceNo, bankReference: 'GOOD-1', valueDate: new Date('2026-10-27T02:00:00Z') });
        const svc = env.t.app.get(PaymentService);
        const original = svc.recordPayment.bind(svc);
        const spy = vi.spyOn(svc, 'recordPayment').mockImplementation((actor, input, hook) => (input.providerPaymentId.endsWith(':BAD-1') ? Promise.reject(new Error('boom')) : original(actor, input, hook)));
        try {
          const res = await reconcile();
          expect(res.status).toBe(200);
          expect(BankReconcileResponse.parse(res.body)).toEqual({ fetched: 2, matched: 1, duplicates: 0, unmatched: 0, errors: 1 });
          expect(await env.t.prisma.payment.count()).toBe(1);
          const entries = await env.t.prisma.bankTransferEntry.findMany({ orderBy: { bankReference: 'asc' } });
          expect(entries.map((e) => [e.bankReference, e.status])).toEqual([['BAD-1', 'FAILED'], ['GOOD-1', 'MATCHED']]);
          expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
        } finally { spy.mockRestore(); }

        // алдаа арилсан: FAILED мөр дахин оролдогдож MATCHED болно, GOOD-1 давхардахгүй
        const retry = BankReconcileResponse.parse((await reconcile()).body);
        expect(retry).toEqual({ fetched: 2, matched: 1, duplicates: 1, unmatched: 0, errors: 0 });
        expect(await env.t.prisma.payment.count()).toBe(2);
        const after = await env.t.prisma.bankTransferEntry.findMany({ orderBy: { bankReference: 'asc' } });
        expect(after.map((e) => e.status)).toEqual(['MATCHED', 'MATCHED']);
        expect(after.every((e) => e.paymentId)).toBe(true);
      });

      it('алдааны лог-д дансны дугаар/нэр орохгүй', async () => {
        const a = await bankInvoice(5000);
        env.bank.pushIncoming({ amount: 5000, description: a.view.senderInvoiceNo, payerName: 'Нууц Нэр', payerAccount: '5099887766' });
        const svc = env.t.app.get(PaymentService);
        const spy = vi.spyOn(svc, 'recordPayment').mockRejectedValue(new Error('boom 5099887766'));
        const logged: string[] = [];
        const err = vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { logged.push(String(m)); });
        try {
          expect(BankReconcileResponse.parse((await reconcile()).body).errors).toBe(1);
        } finally { spy.mockRestore(); err.mockRestore(); }
        expect(logged.length).toBeGreaterThan(0);
        expect(logged.join('\n')).not.toContain('Нууц Нэр');
      });
    });

    it('төлбөр хуваарилагдсан: ЭТХ-ийн хамгийн эрт мөрөөс', async () => {
      const { view, rows } = await bankInvoice();
      const total = sumRows(rows, 0, 2);
      env.bank.pushIncoming({ amount: total, description: view.senderInvoiceNo });
      await reconcile();
      const allocs = await env.t.prisma.paymentAllocation.findMany();
      expect(allocs.map((a) => a.scheduleRowId).sort()).toEqual([rows[0].id, rows[1].id].sort());
    });
  });

  describe('POST payments/bank-accounts/name-check (FR-12.4)', () => {
    const check = (headers: Record<string, string>, body: object) => env.http().post('/api/payments/bank-accounts/name-check').set(headers).send(body);

    it('таарсан: registeredName, similarity=1', async () => {
      const res = await check(actors.officer(), { bankCode: 'KHAN', accountNo: '5012345673', holderName: 'үүрцайх  ТӨМӨР' });
      expect(res.status).toBe(200);
      expect(BankNameCheckResponse.parse(res.body)).toEqual({ matched: true, registeredName: 'Үүрцайх Төмөр', similarity: 1 });
    });

    it('таараагүй, данс олдоогүй', async () => {
      const bad = BankNameCheckResponse.parse((await check(actors.admin(), { bankCode: 'KHAN', accountNo: '5012345673', holderName: 'Номин Дашдорж' })).body);
      expect(bad).toMatchObject({ matched: false, registeredName: 'Үүрцайх Төмөр' });
      expect(bad.similarity).toBeLessThan(0.85);
      expect(BankNameCheckResponse.parse((await check(actors.admin(), { bankCode: 'KHAN', accountNo: '5012340000', holderName: 'Хэн ч' })).body)).toEqual({ matched: false, registeredName: null, similarity: 0 });
    });

    it('Ө/Ү-г хүндэтгэнэ', async () => {
      // 5012345672 → 'Өлзийбаяр Ганбат'
      const ok = BankNameCheckResponse.parse((await check(actors.officer(), { bankCode: 'KHAN', accountNo: '5012345672', holderName: 'Өлзийбаяр Ганбат' })).body);
      expect(ok.matched).toBe(true);
      const swapped = BankNameCheckResponse.parse((await check(actors.officer(), { bankCode: 'KHAN', accountNo: '5012345672', holderName: 'Олзийбаяр Ганбат' })).body);
      expect(swapped.similarity).toBeLessThan(1);
    });

    it('эрх: OFFICER/ADMIN; батлагч 403, нэвтрээгүй 401', async () => {
      const body = { bankCode: 'KHAN', accountNo: '5012345673', holderName: 'x' };
      expect((await check(actors.approver(), body)).status).toBe(403);
      expect((await check(actors.branchManager(), body)).status).toBe(403);
      expect((await check(actors.anonymous(), body)).status).toBe(401);
      expect((await check(actors.customer('c1'), body)).status).toBe(403);
    });

    it('validation 400; банк унтарсан 502', async () => {
      for (const bad of [{}, { bankCode: 'KHAN' }, { bankCode: '', accountNo: '123456', holderName: 'x' }, { bankCode: 'KHAN', accountNo: '12', holderName: 'x' }, { bankCode: 'KHAN', accountNo: '123456', holderName: '' }]) {
        expect((await check(actors.officer(), bad)).status, JSON.stringify(bad)).toBe(400);
      }
      env.bank.failNext({ method: 'nameCheck' });
      const res = await check(actors.officer(), { bankCode: 'KHAN', accountNo: '5012345673', holderName: 'x' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    });
  });
});
