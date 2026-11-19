// M9: interval sweeper-ууд олон pod-д зэрэг tick хийхэд ажлыг НЭГ л удаа хийнэ (pg_try_advisory_xact_lock, бодит PostgreSQL).
// "Хоёр pod" = хоёр тусдаа PrismaService (тусдаа connection pool). Ажлын хамаарлыг (Core/SMS/провайдер) удаан fake-ээр сольж,
// эхний tick түгжээг барьж байх үед хоёр дахь tick ажлыг алгасаж буйг шалгана. TEST_DATABASE_URL байхгүй бол алгасагдана.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '@los/nest-common';
import { PrismaService } from '../prisma.service';
import { BlacklistExpirySweeper } from './blacklist/blacklist-expiry.sweeper';
import type { BlacklistService } from './blacklist/blacklist.service';
import { DisbursementReconcileSweeper } from './disbursement/disbursement-reconcile.sweeper';
import type { DisbursementService } from './disbursement/disbursement.service';
import type { DeliveryProcessor } from './notification/delivery.processor';
import { NotificationRuntime } from './notification/notification.runtime';
import type { NotificationQueue } from './notification/notification.queue';
import type { ReminderService } from './notification/reminder.service';
import type { BankReconciliationService } from './payment/bank-reconciliation.service';
import type { InvoiceService } from './payment/invoice.service';
import { PaymentMaintenance } from './payment/payment-maintenance.service';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

/** Ажлыг гараар суллах хүртэл барина; хэдэн удаа эхэлснийг тоолно */
function gate<T>(value: T) {
  let release!: () => void;
  let markEntered!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { markEntered = r; });
  const state = { calls: 0 };
  const work = async (): Promise<T> => { state.calls++; markEntered(); await released; return value; };
  return { work, entered, release, state };
}
type Gate = ReturnType<typeof gate>;

const settle = (p: Promise<unknown>, ms = 1500) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/** A tick түгжээг барьж байх үед B tick-ийг ажиллуулна; ажил хэдэн удаа эхэлснийг буцаана */
async function concurrentTicks(g: Gate, tickA: () => Promise<unknown>, tickB: () => Promise<unknown>): Promise<number> {
  const a = tickA();
  await g.entered;
  const b = tickB();
  await settle(b);
  const calls = g.state.calls;
  g.release();
  await Promise.all([a, b]);
  return calls;
}

/** Бодит DB клиент дээр `$transaction` (түгжээ)-г үлдээж, заасан model delegate-уудыг fake-ээр сольсон прокси */
function withFakeModels(real: PrismaService, models: Record<string, unknown>): PrismaService {
  return new Proxy(real, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in models) return models[prop];
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe.skipIf(!HAS_DB)('M9 cross-pod locks for interval sweepers (PostgreSQL)', () => {
  let podA: PrismaService;
  let podB: PrismaService;
  beforeAll(async () => {
    podA = new PrismaService();
    podB = new PrismaService();
    await Promise.all([podA.$connect(), podB.$connect()]);
  });
  afterAll(async () => { await Promise.all([podA?.$disconnect(), podB?.$disconnect()]); });

  it('blacklist expiry: two pods ticking at once expire due rows once', async () => {
    const g = gate(0);
    const svc = { expireDue: g.work } as unknown as BlacklistService;
    const a = new BlacklistExpirySweeper(svc, podA);
    const b = new BlacklistExpirySweeper(svc, podB);
    expect(await concurrentTicks(g, () => a.tick(), () => b.tick())).toBe(1);
  });

  it('disbursement reconcile: Core lookups run on one pod only', async () => {
    const g = gate(0);
    const svc = { reconcileStale: g.work } as unknown as DisbursementService;
    const a = new DisbursementReconcileSweeper(svc, podA);
    const b = new DisbursementReconcileSweeper(svc, podB);
    expect(await concurrentTicks(g, () => a.tick(), () => b.tick())).toBe(1);
  });

  it('notification sweep: QUEUED rows are re-enqueued (SMS) by one pod only', async () => {
    const g = gate(0);
    const processor = { sweep: g.work } as unknown as DeliveryProcessor;
    const queue = {} as NotificationQueue;
    const reminders = {} as ReminderService;
    const a = new NotificationRuntime(queue, processor, reminders, podA);
    const b = new NotificationRuntime(queue, processor, reminders, podB);
    expect(await concurrentTicks(g, () => a.sweepOnce(), () => b.sweepOnce())).toBe(1);
  });

  describe('payment maintenance (provider polls)', () => {
    const clock = { now: () => new Date() } as unknown as Clock;
    const pending = [{ id: 'inv-1', orgId: 'org-1', status: 'PENDING' }];
    const noRec = {} as BankReconciliationService;

    it('sweepInvoices: provider refresh happens once across pods', async () => {
      const g = gate(pending);
      const models = { paymentInvoice: { findMany: g.work } };
      const invoices = { refresh: async () => ({ status: 'PENDING' }) } as unknown as InvoiceService;
      const a = new PaymentMaintenance(withFakeModels(podA, models), invoices, noRec, clock);
      const b = new PaymentMaintenance(withFakeModels(podB, models), invoices, noRec, clock);
      expect(await concurrentTicks(g, () => a.sweepInvoices(), () => b.sweepInvoices())).toBe(1);
    });

    it('recheckExpired: once across pods', async () => {
      const g = gate([] as unknown[]);
      const models = { paymentInvoice: { findMany: g.work } };
      const a = new PaymentMaintenance(withFakeModels(podA, models), {} as InvoiceService, noRec, clock);
      const b = new PaymentMaintenance(withFakeModels(podB, models), {} as InvoiceService, noRec, clock);
      expect(await concurrentTicks(g, () => a.recheckExpired(), () => b.recheckExpired())).toBe(1);
    });

    it('reconcileAll: bank reconciliation once across pods', async () => {
      const g = gate([] as unknown[]);
      const models = { paymentInvoice: { findMany: g.work }, setting: { findMany: async () => [] } };
      const a = new PaymentMaintenance(withFakeModels(podA, models), {} as InvoiceService, noRec, clock);
      const b = new PaymentMaintenance(withFakeModels(podB, models), {} as InvoiceService, noRec, clock);
      expect(await concurrentTicks(g, () => a.reconcileAll(), () => b.reconcileAll())).toBe(1);
    });

    it('the three jobs use distinct locks (a long sweep does not block reconciliation)', async () => {
      const g = gate(pending);
      const invoices = { refresh: async () => ({ status: 'PENDING' }) } as unknown as InvoiceService;
      const sweeper = new PaymentMaintenance(withFakeModels(podA, { paymentInvoice: { findMany: g.work } }), invoices, noRec, clock);
      const running = sweeper.sweepInvoices();
      await g.entered;
      let reconcileCalls = 0;
      const recModels = { paymentInvoice: { findMany: async () => { reconcileCalls++; return []; } }, setting: { findMany: async () => [] } };
      await new PaymentMaintenance(withFakeModels(podB, recModels), {} as InvoiceService, noRec, clock).reconcileAll();
      g.release();
      await running;
      expect(reconcileCalls).toBe(1);
    });
  });

  it('after the first pod finishes, the next tick runs again (lock released)', async () => {
    let n = 0;
    const svc = { expireDue: async () => { n++; return 0; } } as unknown as BlacklistService;
    await new BlacklistExpirySweeper(svc, podA).tick();
    await new BlacklistExpirySweeper(svc, podB).tick();
    expect(n).toBe(2);
  });
});

describe('sweepers without a database (memory-store mode) still run', () => {
  it('blacklist / disbursement / notification run the work directly', async () => {
    let n = 0;
    const count = async () => { n++; return 0; };
    await new BlacklistExpirySweeper({ expireDue: count } as unknown as BlacklistService).tick();
    await new DisbursementReconcileSweeper({ reconcileStale: count } as unknown as DisbursementService).tick();
    await new NotificationRuntime({} as NotificationQueue, { sweep: count } as unknown as DeliveryProcessor, {} as ReminderService).sweepOnce();
    expect(n).toBe(3);
  });
});
