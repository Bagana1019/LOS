import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actors, hasTestDb } from '../../test-utils/factories';
import { PaymentMaintenance } from './payment-maintenance.service';
import { bootPayment, makeInvoice, PaymentEnv, resetPayment, seedLoan } from './payment.test-helpers';

describe.skipIf(!hasTestDb)('payment: PaymentMaintenance (бизнес дүрэм 3)', () => {
  let env: PaymentEnv;
  let m: PaymentMaintenance;
  beforeAll(async () => { env = await bootPayment(); m = env.t.app.get(PaymentMaintenance); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const officer = actors.officer();
  const status = async (id: string) => (await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id } })).status;

  it('PENDING + хугацаа дууссан invoice-ийг EXPIRED болгож провайдерт цуцална; шинийг хөндөхгүй', async () => {
    const loan = await seedLoan(env);
    const old = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
    const bank = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 6000 });
    env.t.clock.advanceMs(30 * 60_000);
    const fresh = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 7000 });
    env.t.clock.advanceMs(31 * 60_000); // old, bank: 61 минут; fresh: 31 минут

    const res = await m.sweepInvoices();
    expect(res).toEqual({ checked: 3, expired: 2 });
    expect(await status(old.view.id)).toBe('EXPIRED');
    expect(await status(bank.view.id)).toBe('EXPIRED');
    expect(await status(fresh.view.id)).toBe('PENDING');
    expect(env.qpay.statusOf(old.db.providerInvoiceId as string)).toBe('CANCELLED');
    expect(env.qpay.statusOf(fresh.db.providerInvoiceId as string)).toBe('OPEN');
    // давтахад шинэчлэх зүйлгүй
    expect(await m.sweepInvoices()).toEqual({ checked: 1, expired: 0 });
  });

  it('алдагдсан callback-ийг нөхнө: провайдерт төлөгдсөн PENDING invoice-ийг poll хийж бүртгэнэ', async () => {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 9000 });
    env.qpay.simulatePayment(inv.db.providerInvoiceId as string);
    expect(await env.t.prisma.payment.count()).toBe(0);
    await m.sweepInvoices();
    expect(await status(inv.view.id)).toBe('PAID');
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
    await m.sweepInvoices();
    expect(await env.t.prisma.payment.count()).toBe(1);
  });

  it('хугацаа дуусах мөчид төлөгдсөн бол EXPIRED биш PAID', async () => {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 9000 });
    env.qpay.simulatePayment(inv.db.providerInvoiceId as string);
    env.t.clock.advanceMs(2 * 3_600_000);
    await m.sweepInvoices();
    expect(await status(inv.view.id)).toBe('PAID');
  });

  it('провайдер унтарсан үед sweep унахгүй; хугацаа дууссан ч EXPIRED болгохгүй (төлөгдсөн байж болно) — дараагийн sweep-д PAID', async () => {
    const loan = await seedLoan(env);
    const a = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
    env.qpay.simulatePayment(a.db.providerInvoiceId as string); // callback алдагдсан
    env.qpay.failNext({ method: 'checkInvoice', times: 1 });
    env.t.clock.advanceMs(2 * 3_600_000);

    await expect(m.sweepInvoices()).resolves.toEqual({ checked: 1, expired: 0 });
    expect(await status(a.view.id)).toBe('PENDING');
    expect(env.qpay.statusOf(a.db.providerInvoiceId as string)).toBe('PAID'); // провайдерт цуцлаагүй
    expect(await env.t.prisma.payment.count()).toBe(0);

    await m.sweepInvoices();
    expect(await status(a.view.id)).toBe('PAID');
    expect(await env.t.prisma.payment.count()).toBe(1);
  });

  it('провайдер унтарсан ч төлөгдөөгүй invoice: TTL+24 цагийн дотор PENDING, дараа нь хүчээр EXPIRED', async () => {
    const loan = await seedLoan(env);
    const a = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
    env.qpay.failNext({ method: 'checkInvoice', times: 100 });
    env.t.clock.advanceMs(2 * 3_600_000);
    await expect(m.sweepInvoices()).resolves.toEqual({ checked: 1, expired: 0 });
    expect(await status(a.view.id)).toBe('PENDING');
    env.t.clock.advanceMs(24 * 3_600_000);
    await expect(m.sweepInvoices()).resolves.toEqual({ checked: 1, expired: 1 });
    expect(await status(a.view.id)).toBe('EXPIRED');
  });

  describe('recheckExpired: хожуу төлөгдсөн EXPIRED invoice-ийг нөхнө', () => {
    it('хугацаа дуусгахад провайдерт цуцалж чадаагүй (идэвхтэй үлдсэн) invoice хожуу төлөгдвөл бүртгэнэ', async () => {
      const loan = await seedLoan(env);
      const a = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
      env.qpay.failNext({ method: 'cancelInvoice', times: 1 });
      env.t.clock.advanceMs(2 * 3_600_000);
      await m.sweepInvoices();
      expect(await status(a.view.id)).toBe('EXPIRED');
      expect(env.qpay.statusOf(a.db.providerInvoiceId as string)).toBe('OPEN'); // цуцлалт амжилтгүй → төлөгдөх боломжтой

      env.qpay.simulatePayment(a.db.providerInvoiceId as string); // callback алдагдсан
      await expect(m.recheckExpired()).resolves.toEqual({ checked: 1, recovered: 1 });
      expect(await status(a.view.id)).toBe('PAID');
      expect(await env.t.prisma.payment.count()).toBe(1);
      expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
      // PAID болсон тул дахин шалгахгүй, давхар бүртгэхгүй
      await expect(m.recheckExpired()).resolves.toEqual({ checked: 0, recovered: 0 });
      expect(await env.t.prisma.payment.count()).toBe(1);
    });

    it('шалгалтын алдаанаас болж хүчээр EXPIRED болсон invoice: провайдер сэргэсний дараа нөхнө', async () => {
      const loan = await seedLoan(env);
      const a = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
      env.qpay.simulatePayment(a.db.providerInvoiceId as string);
      env.qpay.failNext({ method: 'checkInvoice', times: 3 }); // sweep#1, sweep#2, expire доторх дахин шалгалт
      env.t.clock.advanceMs(2 * 3_600_000);
      await m.sweepInvoices();
      env.t.clock.advanceMs(24 * 3_600_000);
      await m.sweepInvoices();
      expect(await status(a.view.id)).toBe('EXPIRED');
      expect(await env.t.prisma.payment.count()).toBe(0);

      await expect(m.recheckExpired()).resolves.toEqual({ checked: 1, recovered: 1 });
      expect(await status(a.view.id)).toBe('PAID');
      expect(await env.t.prisma.payment.count()).toBe(1);
    });

    it('провайдер унтарсан үед унахгүй; 48 цагаас өмнө хугацаа дууссан, банкны, CANCELLED invoice-ийг шалгахгүй', async () => {
      const loan = await seedLoan(env);
      const old = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
      const bank = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 6000 });
      const cancelled = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 7000 });
      await env.t.prisma.paymentInvoice.updateMany({ where: { id: { in: [old.view.id, bank.view.id] } }, data: { status: 'EXPIRED' } });
      await env.t.prisma.paymentInvoice.update({ where: { id: cancelled.view.id }, data: { status: 'CANCELLED' } });
      env.t.clock.advanceMs(50 * 3_600_000); // old/bank-ийн хугацаа дууссанаас 49 цаг
      await expect(m.recheckExpired()).resolves.toEqual({ checked: 0, recovered: 0 });

      const recent = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'SOCIALPAY', amount: 8000 });
      await env.t.prisma.paymentInvoice.update({ where: { id: recent.view.id }, data: { status: 'EXPIRED' } });
      env.socialpay.failNext({ method: 'checkInvoice', times: 1 });
      await expect(m.recheckExpired()).resolves.toEqual({ checked: 1, recovered: 0 });
      expect(await status(recent.view.id)).toBe('EXPIRED');
    });
  });

  it('зэрэг ажиллахаас хамгаална (давхар sweep)', async () => {
    const loan = await seedLoan(env);
    await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
    const [a, b] = await Promise.all([m.sweepInvoices(), m.sweepInvoices()]);
    expect([a.checked, b.checked].sort()).toEqual([0, 1]);
  });

  it('reconcileAll: банкны invoice-той байгууллага бүрт тулгалт ажиллуулна', async () => {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 12_000 });
    env.bank.pushIncoming({ amount: 12_000, description: inv.view.senderInvoiceNo });
    expect(await m.reconcileAll()).toBe(1);
    expect(await status(inv.view.id)).toBe('PAID');
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await m.reconcileAll()).toBe(1);
    expect(await env.t.prisma.payment.count()).toBe(1);
  });

  it('reconcileAll: банк унтарсан үед унахгүй, амжилттай байгууллагын тоо 0', async () => {
    const loan = await seedLoan(env);
    await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 12_000 });
    env.bank.failNext({ method: 'listIncomingTransfers' });
    expect(await m.reconcileAll()).toBe(0);
  });

  it('reconcileAll: payment.collection_account setting-тэй байгууллага ч орно', async () => {
    await env.t.prisma.setting.create({ data: { orgId: 'org-x', key: 'payment.collection_account', valueJson: { bankCode: 'KHAN', accountNo: '5000000001', accountName: 'X' } } });
    expect(await m.reconcileAll()).toBe(1);
  });

  it('PAYMENT_MAINTENANCE=off бол timer үүсэхгүй; идэвхтэй үед 2 timer (unref), destroy-д цэвэрлэнэ', () => {
    const timers = () => (m as unknown as { timers: NodeJS.Timeout[] }).timers;
    expect(timers()).toHaveLength(0); // тестийн орчинд унтраалттай
    process.env.PAYMENT_MAINTENANCE = 'on';
    try {
      m.onModuleInit();
      expect(timers()).toHaveLength(2);
      expect(timers().every((t) => t.hasRef() === false)).toBe(true); // .unref() — процессыг барихгүй
      m.onModuleDestroy();
      expect(timers()).toHaveLength(0);
      process.env.PAYMENT_MAINTENANCE = 'off';
      m.onModuleInit();
      expect(timers()).toHaveLength(0);
    } finally { m.onModuleDestroy(); process.env.PAYMENT_MAINTENANCE = 'off'; }
  });

  describe('фоны timer: алдаа процессыг унагахгүй (unhandled rejection гарахгүй)', () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    beforeEach(() => {
      unhandled.length = 0;
      process.on('unhandledRejection', onUnhandled);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // prisma/pg-ийн жинхэнэ timer-д хүрэхгүй
      process.env.PAYMENT_MAINTENANCE = 'on';
    });
    afterEach(() => {
      m.onModuleDestroy();
      process.env.PAYMENT_MAINTENANCE = 'off';
      vi.useRealTimers();
      vi.restoreAllMocks();
      process.off('unhandledRejection', onUnhandled);
    });
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
    /** Prisma delegate-ийг spyOn хийвэл restore хийхэд устдаг тул maintenance-ийн prisma-г DB унасан stub-аар түр солино. */
    const breakDb = (): (() => void) => {
      const holder = m as unknown as { prisma: unknown };
      const real = holder.prisma;
      const down = () => Promise.reject(new Error('db down'));
      holder.prisma = { paymentInvoice: { findMany: down }, setting: { findMany: down } };
      return () => { holder.prisma = real; };
    };

    it('DB унасан: sweepInvoices/reconcileAll findMany reject хийхэд timer-ээс unhandled rejection гарахгүй, алдааг логлоно', async () => {
      const restoreDb = breakDb();
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        m.onModuleInit();
        await vi.advanceTimersByTimeAsync(11 * 60_000); // sweep (60с) ба reconcile (10 мин) хоёулаа ажиллана
        await flush();
        expect(unhandled).toEqual([]);
        expect(logged).toHaveBeenCalled();
      } finally { restoreDb(); logged.mockRestore(); }
      // timer-ийн дараа ч үйлчилгээ ажиллагаатай (guard түгжигдээгүй)
      const loan = await seedLoan(env);
      await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 5000 });
      await expect(m.sweepInvoices()).resolves.toMatchObject({ checked: 1 });
    });

    it('шууд дуудахад ч sweepInvoices/reconcileAll/recheckExpired DB алдаанд reject хийхгүй', async () => {
      const restoreDb = breakDb();
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await expect(m.sweepInvoices()).resolves.toEqual({ checked: 0, expired: 0 });
        await expect(m.reconcileAll()).resolves.toBe(0);
        await expect(m.recheckExpired()).resolves.toEqual({ checked: 0, recovered: 0 });
      } finally { restoreDb(); }
    });

    it('метод өөрөө reject хийсэн ч (гэнэтийн алдаа) timer callback барьж логлоно', async () => {
      vi.spyOn(m, 'sweepInvoices').mockRejectedValue(new Error('unexpected'));
      vi.spyOn(m, 'recheckExpired').mockRejectedValue(new Error('unexpected'));
      vi.spyOn(m, 'reconcileAll').mockRejectedValue(new Error('unexpected'));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      m.onModuleInit();
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await flush();
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalled();
    });
  });
});
