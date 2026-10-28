import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { EXPIRED_RECHECK_WINDOW_MS, InvoiceService } from './invoice.service';
import { safeLogText } from './payment.errors';
import { Actor, systemActor } from './payment.service';

const describeError = (e: unknown): string => (e instanceof Error ? safeLogText(e.message, 120) : 'үл мэдэгдэх');

/**
 * Брифийн дүрэм 3: PENDING+хугацаа дууссан invoice-ийг EXPIRED болгох, алдагдсан callback-ийг (poll) нөхөх, BANK_TRANSFER тулгалт.
 * `PAYMENT_MAINTENANCE=off` бол ажиллахгүй. Интервал: `PAYMENT_MAINTENANCE_INTERVAL_SEC` (60), `PAYMENT_RECONCILE_INTERVAL_MIN` (10),
 * EXPIRED invoice-ийн дахин шалгалт `PAYMENT_EXPIRED_RECHECK_INTERVAL_MIN` (10).
 * Олон instance зэрэг ажиллахад аюулгүй — бүх үйлдэл idempotent.
 * Фоны timer-ийн алдаа ХЭЗЭЭ Ч unhandled rejection болохгүй (Node 15+ процессыг зогсооно): метод бүр өөрийн алдааг барьж логлоно,
 * timer callback нь нэмж `.catch`-тэй.
 */
@Injectable()
export class PaymentMaintenance implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PaymentMaintenance');
  private timers: NodeJS.Timeout[] = [];
  private sweeping = false;
  private reconciling = false;
  private rechecking = false;
  private lastRecheckAt = 0;

  constructor(private readonly prisma: PrismaService, private readonly invoices: InvoiceService, private readonly reconciliation: BankReconciliationService, private readonly clock: Clock) {}

  onModuleInit(): void {
    if (process.env.PAYMENT_MAINTENANCE === 'off') return;
    const sweepSec = Math.max(5, Number(process.env.PAYMENT_MAINTENANCE_INTERVAL_SEC) || 60);
    const reconcileMin = Math.max(1, Number(process.env.PAYMENT_RECONCILE_INTERVAL_MIN) || 10);
    this.timers.push(setInterval(() => this.fireAndLog('sweep', () => this.sweepTick()), sweepSec * 1000).unref());
    this.timers.push(setInterval(() => this.fireAndLog('reconcile', () => this.reconcileAll()), reconcileMin * 60_000).unref());
  }

  onModuleDestroy(): void { this.timers.forEach(clearInterval); this.timers = []; }

  /** Timer-ийн ажлыг promise-ийн алдаа (мөн синхрон throw)-тай нь барьж логлоно — `void promise` нь reject-ийг unhandled болгодог. */
  private fireAndLog(name: string, fn: () => Promise<unknown>): void {
    void Promise.resolve().then(fn).catch((e) => this.logger.error(`Фоны ажил (${name}) амжилтгүй: ${describeError(e)}`));
  }

  /** Sweep + (интервал нь болсон бол) EXPIRED invoice-ийн дахин шалгалт. */
  private async sweepTick(): Promise<void> {
    await this.sweepInvoices();
    const everyMs = Math.max(1, Number(process.env.PAYMENT_EXPIRED_RECHECK_INTERVAL_MIN) || 10) * 60_000;
    if (Date.now() - this.lastRecheckAt < everyMs) return;
    this.lastRecheckAt = Date.now();
    await this.recheckExpired();
  }

  /** PENDING invoice бүрийг (шинэчлэх: провайдераас шалгах → хугацаа дууссан бол EXPIRED). DB-ийн алдаанд reject хийхгүй. */
  async sweepInvoices(): Promise<{ checked: number; expired: number }> {
    if (this.sweeping) return { checked: 0, expired: 0 };
    this.sweeping = true;
    let checked = 0;
    let expired = 0;
    try {
      const pending = await this.prisma.paymentInvoice.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200 });
      checked = pending.length;
      for (const invoice of pending) {
        try {
          const fresh = await this.invoices.refresh(invoice, systemActor(invoice.orgId));
          if (fresh.status === 'EXPIRED') expired++;
        } catch (e) { this.logger.error(`Invoice шинэчлэхэд алдаа: ${describeError(e)}`); }
      }
    } catch (e) {
      this.logger.error(`Invoice-ийн sweep амжилтгүй: ${describeError(e)}`);
    } finally { this.sweeping = false; }
    return { checked, expired };
  }

  /**
   * Саяхан (EXPIRED_RECHECK_WINDOW_MS дотор) EXPIRED болсон QPay/SocialPay invoice-ийг дахин шалгаж, хожуу төлөгдсөн (callback алдагдсан,
   * цуцлалт амжилтгүй байсан, провайдер удаан унасан үед хүчээр хаагдсан) төлбөрийг бүртгэнэ. PAID болсон нь дахин шалгагдахгүй.
   */
  async recheckExpired(): Promise<{ checked: number; recovered: number }> {
    if (this.rechecking) return { checked: 0, recovered: 0 };
    this.rechecking = true;
    let checked = 0;
    let recovered = 0;
    try {
      const since = new Date(this.clock.now().getTime() - EXPIRED_RECHECK_WINDOW_MS);
      const expired = await this.prisma.paymentInvoice.findMany({
        where: { status: 'EXPIRED', provider: { in: ['QPAY', 'SOCIALPAY'] }, providerInvoiceId: { not: null }, expiresAt: { gte: since } },
        orderBy: { expiresAt: 'desc' }, take: 200,
      });
      checked = expired.length;
      for (const invoice of expired) {
        try {
          const fresh = await this.invoices.syncWithProvider(invoice, systemActor(invoice.orgId), { includeClosed: true, swallowErrors: true });
          if (fresh.status === 'PAID') recovered++;
        } catch (e) { this.logger.error(`EXPIRED invoice дахин шалгахад алдаа: ${describeError(e)}`); }
      }
    } catch (e) {
      this.logger.error(`EXPIRED invoice-ийн дахин шалгалт амжилтгүй: ${describeError(e)}`);
    } finally { this.rechecking = false; }
    return { checked, recovered };
  }

  /** Банкны шилжүүлгийн тулгалтыг холбогдох байгууллага бүрт ажиллуулна. Амжилттай ажилласан байгууллагын тоо; DB-ийн алдаанд reject хийхгүй. */
  async reconcileAll(): Promise<number> {
    if (this.reconciling) return 0;
    this.reconciling = true;
    let ran = 0;
    try {
      const orgs = new Set<string>();
      for (const r of await this.prisma.paymentInvoice.findMany({ where: { provider: 'BANK_TRANSFER' }, distinct: ['orgId'], select: { orgId: true } })) orgs.add(r.orgId);
      // Module 0-ийн seed бүх байгууллагад хоосон `payment.collection_account` мөр үүсгэдэг — зөвхөн данс нь тохируулагдсан байгууллагыг тулгана.
      for (const r of await this.prisma.setting.findMany({ where: { key: 'payment.collection_account' }, select: { orgId: true, valueJson: true } })) {
        if (String((r.valueJson as { accountNo?: unknown } | null)?.accountNo ?? '').trim()) orgs.add(r.orgId);
      }
      for (const orgId of orgs) {
        const actor: Actor = systemActor(orgId);
        try { await this.reconciliation.reconcile(actor); ran++; } catch (e) { this.logger.warn(`Банкны тулгалт (${safeLogText(orgId)}) амжилтгүй: ${describeError(e)}`); }
      }
    } catch (e) {
      this.logger.error(`Банкны тулгалтын байгууллагуудыг олж чадсангүй: ${describeError(e)}`);
    } finally { this.reconciling = false; }
    return ran;
  }
}
