import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CreatePaymentInvoiceRequest, PaymentInvoiceView } from '@los/contracts';
import type { LoanApplication, PaymentInvoice } from '.prisma/client-origination';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { Clock } from '@los/nest-common';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { OrgSettings } from '../../shared/org-settings';
import { resolveInvoiceAmount } from './invoice-amount';
import { safeLogText, toHttpError, withProvider } from './payment.errors';
import { toInvoiceView } from './payment.mapper';
import { Actor, PaymentService, actorOf, systemActor } from './payment.service';
import { ProviderRegistry } from './provider-registry';
import { loadCurrentSchedule } from './schedule-state';
import { todayUB } from '../../shared/clock';

const Decimal = Prisma.Decimal;
/** createdBy/updatedBy: ажилтан бол userId, зээлдэгч (self-service) бол `customer:<id>`. */
const byWhom = (ctx: Pick<RequestContext, 'userId' | 'customerId'>): string | null => ctx.userId ?? (ctx.customerId ? `customer:${ctx.customerId}` : null);
/** Төлбөр хүлээн авах боломжтой хүсэлтийн төлөв: идэвхтэй зээл эсвэл эхний үлдэгдлээр шилжүүлсэн. */
export const PAYABLE_STATUSES = ['ACTIVE', 'MIGRATED'];
/**
 * Провайдераас шалгаж БАТАЛГААЖУУЛЖ ЧАДААГҮЙ (унасан, тохиргоогүй) хугацаа дууссан invoice-ийг EXPIRED болгохгүй — төлөгдсөн байж болно.
 * Харин хязгааргүй хүлээхгүй: хугацаа дууссанаас хойш энэ хугацаанд л PENDING үлдээнэ.
 */
export const UNVERIFIED_EXPIRY_GRACE_MS = 24 * 3_600_000;
/** EXPIRED болсон провайдерын invoice-д хожуу орсон төлбөрийг (callback алдагдсан үед) PaymentMaintenance дахин шалгах хугацаа (expiresAt-аас хойш). */
export const EXPIRED_RECHECK_WINDOW_MS = 48 * 3_600_000;

interface CreateResult { invoice: PaymentInvoice; created: boolean }
/** verified=false: провайдераас төлөгдсөн эсэхийг баталгаажуулж чадсангүй (шалгалт/бүртгэл унасан, эсвэл провайдер ашиглах боломжгүй). */
export interface SyncOutcome { invoice: PaymentInvoice; verified: boolean }

/** `LOS-<appNo>-<base36 seq>` — тогтвортой, богино, давтагдашгүй; банкны гүйлгээний утга болгон ашиглана. */
export function makeSenderInvoiceNo(appNo: string, appId: string, seq: number): string {
  const base = appNo.toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+|-+$/g, '') || appId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
  return `LOS-${base}-${seq.toString(36).toUpperCase()}`;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger('InvoiceService');
  /** Нэг процесс доторх ижил хүсэлтүүдийг нэгтгэнэ (single-flight) — давхар дарахад нэг invoice. */
  private readonly inflight = new Map<string, Promise<CreateResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly settings: OrgSettings,
    private readonly clock: Clock,
    private readonly registry: ProviderRegistry,
    private readonly payments: PaymentService,
  ) {}

  // ── Үүсгэх ──────────────────────────────────────────────────────────────────────

  async create(ctx: RequestContext, dto: CreatePaymentInvoiceRequest): Promise<{ view: PaymentInvoiceView; created: boolean }> {
    const app = await this.access.load(ctx, dto.applicationId, 'pay');
    if (!PAYABLE_STATUSES.includes(app.status)) throw new ConflictException({ code: 'LOAN_NOT_PAYABLE', message: 'Энэ зээл төлбөр хүлээн авах төлөвт биш байна (идэвхтэй зээл байх ёстой)' });
    const schedule = await loadCurrentSchedule(this.prisma, app.id);
    if (!schedule) throw new ConflictException({ code: 'SCHEDULE_NOT_FOUND', message: 'Одоогийн эргэн төлөлтийн хуваарь олдсонгүй' });

    const minAmount = await this.settings.get(ctx.orgId, 'payment.min_amount');
    const amount = resolveInvoiceAmount({ installments: schedule.installments, scheduleRowId: dto.scheduleRowId, amount: dto.amount, minAmount, asOf: todayUB(this.clock) });

    if (dto.provider === 'BANK_TRANSFER') {
      if (!this.registry.bank.isAvailable()) throw this.unavailable(this.registry.bank.unavailableReason());
      if (!(await this.registry.collectionAccount(ctx.orgId))) throw new HttpException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'Банкны шилжүүлгийн хүлээн авах данс тохируулаагүй байна. Админтай холбогдоно уу.' }, 503);
    } else {
      const port = this.registry.port(dto.provider);
      if (!port.isAvailable()) throw this.unavailable(port.unavailableReason());
      if (app.currency !== 'MNT') throw new HttpException({ code: 'CURRENCY_NOT_SUPPORTED', message: 'QPay, SocialPay нь зөвхөн төгрөгийн (MNT) зээлд ашиглагдана' }, 422);
    }

    const key = [app.id, dto.provider, amount.toFixed(2), dto.scheduleRowId ?? ''].join('|');
    let run = this.inflight.get(key);
    const leader = !run; // нэгтгэгдсэн (хоёр дахь, гурав дахь…) хүсэлт нь шинэ invoice үүсгээгүй тул created=false
    if (!run) {
      run = this.createOrReuse(ctx, app, dto, amount).finally(() => this.inflight.delete(key));
      this.inflight.set(key, run);
    }
    const { invoice, created } = await run;
    return { view: toInvoiceView(invoice), created: leader && created };
  }

  /** Real горимд тохиргоо дутуу → 503 PROVIDER_NOT_CONFIGURED; хэрэгжээгүй skeleton → 501 PROVIDER_NOT_IMPLEMENTED. */
  private unavailable(reason: 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' | null): HttpException {
    return reason === 'NOT_IMPLEMENTED'
      ? new HttpException({ code: 'PROVIDER_NOT_IMPLEMENTED', message: 'Энэ төлбөрийн хэлбэрийн бодит холболт хараахан хэрэгжээгүй байна' }, 501)
      : new HttpException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'Төлбөрийн үйлчилгээний тохиргоо дутуу байна. Админтай холбогдоно уу.' }, 503);
  }

  private async createOrReuse(ctx: RequestContext, app: LoanApplication, dto: CreatePaymentInvoiceRequest, amount: number): Promise<CreateResult> {
    const now = this.clock.now();
    // Брифийн дүрэм 2: адил app+provider+дүн+мөр, PENDING, хугацаа дуусаагүй, үүсгэж дууссан invoice байвал шинээр үүсгэхгүй.
    const existing = await this.prisma.paymentInvoice.findFirst({
      where: {
        applicationId: app.id, provider: dto.provider, amount, scheduleRowId: dto.scheduleRowId ?? null, status: 'PENDING', expiresAt: { gt: now },
        ...(dto.provider === 'BANK_TRANSFER' ? {} : { providerInvoiceId: { not: null } }),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { invoice: existing, created: false };

    const ttl = await this.settings.get(ctx.orgId, 'payment.invoice_ttl_minutes');
    const expiresAt = new Date(now.getTime() + ttl * 60_000);
    const account = dto.provider === 'BANK_TRANSFER' ? await this.registry.collectionAccount(ctx.orgId) : null;

    const reserved = await this.reserve(ctx, app, dto, amount, expiresAt, account);
    if (dto.provider === 'BANK_TRANSFER') return { invoice: reserved, created: true };

    // Гадаад дуудлага DB транзакцийн ГАДНА. Амжилтгүй бол нөөцөлсөн мөрийг устгана — DB-д хагас invoice үлдээхгүй.
    const port = this.registry.port(dto.provider);
    let provided;
    try {
      provided = await withProvider(() => port.createInvoice({
        senderInvoiceNo: reserved.senderInvoiceNo, amount, currency: app.currency, receiverCode: app.appNo.slice(0, 45), expiresAt,
        description: `Зээлийн эргэн төлөлт ${app.appNo}${dto.note ? ` · ${dto.note}` : ''}`.slice(0, 200),
      }));
    } catch (e) {
      await this.prisma.paymentInvoice.delete({ where: { id: reserved.id } }).catch((err) => this.logger.error(`Нөөцөлсөн invoice устгаж чадсангүй: ${String(err)}`));
      throw e;
    }
    try {
      const invoice = await this.prisma.paymentInvoice.update({
        where: { id: reserved.id },
        data: {
          providerInvoiceId: provided.providerInvoiceId, qrText: provided.qrText, qrImage: provided.qrImage,
          deeplinksJson: provided.deeplinks as unknown as Prisma.InputJsonValue, providerResponseJson: provided.raw as Prisma.InputJsonValue,
        },
      });
      return { invoice, created: true };
    } catch (e) {
      await port.cancelInvoice({ providerInvoiceId: provided.providerInvoiceId, senderInvoiceNo: reserved.senderInvoiceNo }).catch(() => undefined);
      await this.prisma.paymentInvoice.delete({ where: { id: reserved.id } }).catch(() => undefined);
      throw e;
    }
  }

  /** senderInvoiceNo-г unique constraint-аар атомаар нөөцөлнө (application мөрийн түгжээгээр дараалуулсан, давхцвал дахин оролдоно). */
  private async reserve(ctx: RequestContext, app: LoanApplication, dto: CreatePaymentInvoiceRequest, amount: number, expiresAt: Date, account: { bankCode: string; accountNo: string; accountName: string } | null): Promise<PaymentInvoice> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "origination"."loan_application" WHERE id = ${app.id} FOR UPDATE`;
          const seq = (await tx.paymentInvoice.count({ where: { applicationId: app.id } })) + 1 + attempt;
          const senderInvoiceNo = makeSenderInvoiceNo(app.appNo, app.id, seq);
          return tx.paymentInvoice.create({
            data: {
              orgId: app.orgId, applicationId: app.id, scheduleRowId: dto.scheduleRowId ?? null, provider: dto.provider, status: 'PENDING', amount: new Decimal(amount), currency: app.currency,
              senderInvoiceNo, expiresAt, note: dto.note ?? null, createdBy: byWhom(ctx), updatedBy: byWhom(ctx),
              bankTransferJson: account ? { bankCode: account.bankCode, accountNo: account.accountNo, accountName: account.accountName, reference: senderInvoiceNo } : undefined,
            },
          });
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 5) continue;
        throw e;
      }
    }
    throw new ConflictException({ code: 'INVOICE_NUMBER_CONFLICT', message: 'Invoice-ийн дугаар үүсгэж чадсангүй, дахин оролдоно уу' });
  }

  // ── Унших / шинэчлэх ────────────────────────────────────────────────────────────

  async get(ctx: RequestContext, id: string): Promise<PaymentInvoiceView> {
    const invoice = await this.load(ctx.orgId, id);
    await this.access.load(ctx, invoice.applicationId, 'read');
    return toInvoiceView(await this.refresh(invoice, actorOf(ctx)));
  }

  async load(orgId: string, id: string): Promise<PaymentInvoice> {
    const invoice = await this.prisma.paymentInvoice.findFirst({ where: { id, orgId } });
    if (!invoice) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Төлбөрийн invoice олдсонгүй' });
    return invoice;
  }

  /**
   * PENDING invoice-ийг провайдераас шалгаж (callback алдагдсан үед), хугацаа дууссан бол EXPIRED болгоно. Провайдерын алдаа уншихыг унагахгүй.
   * Шалгалт БАТАЛГААЖААГҮЙ (алдаа) бол EXPIRED болгохгүй: төлөгдсөн мөнгө бүртгэгдэхгүй үлдэх эрсдэлтэй. UNVERIFIED_EXPIRY_GRACE_MS-ээс хойш л хүчээр.
   */
  async refresh(invoice: PaymentInvoice, actor: Actor): Promise<PaymentInvoice> {
    if (invoice.status !== 'PENDING') return invoice;
    const { invoice: current, verified } = await this.sync(invoice, actor, { includeClosed: false, swallowErrors: true });
    if (current.status !== 'PENDING') return current;
    const now = this.clock.now().getTime();
    const expiresAt = current.expiresAt.getTime();
    if (expiresAt > now) return current;
    if (!verified && now < expiresAt + UNVERIFIED_EXPIRY_GRACE_MS) return current;
    if (!verified) this.logger.warn(`Invoice ${safeLogText(current.senderInvoiceNo)}: провайдераас баталгаажуулж чадаагүй ч хүлээх хугацаа дууссан тул EXPIRED болгов`);
    return this.expire(current, actor);
  }

  /**
   * Провайдераас checkInvoice хийж, төлөгдсөн бол PaymentService.recordPayment-ээр бүртгэнэ (idempotent).
   * includeClosed: EXPIRED/CANCELLED invoice-д хожуу орж ирсэн төлбөрийг ч бүртгэнэ (мөнгө алдахгүй). PAID бол дахин дуудахгүй.
   */
  async syncWithProvider(invoice: PaymentInvoice, actor: Actor, opts: { includeClosed: boolean; swallowErrors: boolean }): Promise<PaymentInvoice> {
    return (await this.sync(invoice, actor, opts)).invoice;
  }

  /** syncWithProvider + шалгалт амжилттай болсон эсэх (verified). Шалгах шаардлагагүй invoice (банк, PAID, провайдергүй) verified=true. */
  async sync(invoice: PaymentInvoice, actor: Actor, opts: { includeClosed: boolean; swallowErrors: boolean }): Promise<SyncOutcome> {
    if (invoice.provider === 'BANK_TRANSFER' || !invoice.providerInvoiceId) return { invoice, verified: true };
    if (invoice.status === 'PAID' || (invoice.status !== 'PENDING' && !opts.includeClosed)) return { invoice, verified: true };
    const port = this.registry.port(invoice.provider as 'QPAY' | 'SOCIALPAY');
    if (!port.isAvailable()) return { invoice, verified: false };
    let verified = true;
    try {
      const result = await withProvider(() => port.checkInvoice({ providerInvoiceId: invoice.providerInvoiceId as string, senderInvoiceNo: invoice.senderInvoiceNo }));
      for (const p of result.payments) {
        await this.payments.recordPayment({ ...actor, orgId: invoice.orgId }, {
          applicationId: invoice.applicationId, invoiceId: invoice.id, provider: invoice.provider as 'QPAY' | 'SOCIALPAY', providerPaymentId: p.providerPaymentId,
          amount: p.amount, currency: p.currency, paidAt: p.paidAt, payerName: p.payerName, payerAccount: p.payerAccount, raw: p.raw,
        });
      }
    } catch (e) {
      if (!opts.swallowErrors) throw toHttpError(e);
      verified = false;
      this.logger.warn(`Invoice ${safeLogText(invoice.senderInvoiceNo)} шалгаж чадсангүй: ${e instanceof Error ? safeLogText(e.message, 120) : 'алдаа'}`);
    }
    return { invoice: (await this.prisma.paymentInvoice.findUnique({ where: { id: invoice.id } })) ?? invoice, verified };
  }

  /**
   * PENDING → EXPIRED (нөхцөлт update), дараа нь провайдерт best-effort цуцлалт (хугацаа дууссан invoice-ийг төлөх боломжгүй болгоно).
   * Цуцлалт амжилтгүй бол (жишээ нь шалгалт ба цуцлалтын завсар төлөгдсөн → "төлөгдсөн" гэж татгалзсан) провайдер дээр invoice идэвхтэй
   * хэвээр байж болох тул дахин шалгаж, төлөгдсөн бол бүртгэнэ (мөнгө алдахгүй).
   */
  async expire(invoice: PaymentInvoice, actor: Actor = systemActor(invoice.orgId)): Promise<PaymentInvoice> {
    const { count } = await this.prisma.paymentInvoice.updateMany({ where: { id: invoice.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    let fresh = (await this.prisma.paymentInvoice.findUnique({ where: { id: invoice.id } })) ?? invoice;
    if (count > 0 && invoice.provider !== 'BANK_TRANSFER' && invoice.providerInvoiceId) {
      const port = this.registry.port(invoice.provider as 'QPAY' | 'SOCIALPAY');
      if (port.isAvailable()) {
        try {
          await port.cancelInvoice({ providerInvoiceId: invoice.providerInvoiceId, senderInvoiceNo: invoice.senderInvoiceNo });
        } catch (e) {
          this.logger.warn(`Хугацаа дууссан invoice-ийг провайдерт цуцалж чадсангүй: ${e instanceof Error ? safeLogText(e.message, 120) : 'алдаа'}`);
          fresh = (await this.sync(fresh, actor, { includeClosed: true, swallowErrors: true })).invoice;
        }
      }
    }
    return fresh;
  }

  // ── Цуцлах ──────────────────────────────────────────────────────────────────────

  async cancel(ctx: RequestContext, id: string): Promise<PaymentInvoiceView> {
    let invoice = await this.load(ctx.orgId, id);
    await this.access.load(ctx, invoice.applicationId, 'pay');
    if (invoice.status === 'CANCELLED') return toInvoiceView(invoice); // idempotent
    if (invoice.status === 'PAID') throw new ConflictException({ code: 'INVOICE_ALREADY_PAID', message: 'Энэ invoice төлөгдсөн тул цуцлах боломжгүй' });
    if (invoice.status === 'EXPIRED') throw new ConflictException({ code: 'INVOICE_NOT_PENDING', message: 'Энэ invoice-ийн хугацаа дууссан байна' });

    const actor = actorOf(ctx);
    // Цуцлахын өмнө төлөгдсөн эсэхийг провайдераас баталгаажуулна (callback хараахан ирээгүй байж болно).
    invoice = await this.syncWithProvider(invoice, actor, { includeClosed: false, swallowErrors: false });
    if (invoice.status === 'PAID') throw new ConflictException({ code: 'INVOICE_ALREADY_PAID', message: 'Энэ invoice төлөгдсөн тул цуцлах боломжгүй' });

    if (invoice.provider !== 'BANK_TRANSFER' && invoice.providerInvoiceId) {
      const port = this.registry.port(invoice.provider as 'QPAY' | 'SOCIALPAY');
      try {
        await withProvider(() => port.cancelInvoice({ providerInvoiceId: invoice.providerInvoiceId as string, senderInvoiceNo: invoice.senderInvoiceNo }));
      } catch (e) {
        // Провайдер "аль хэдийн төлөгдсөн" гэвэл нөхцөл байдлыг дахин шалгаж 409 буцаана.
        const cause = e instanceof HttpException ? (e.getResponse() as { code?: string }).code : undefined;
        if (cause === 'PROVIDER_REJECTED') {
          const again = await this.syncWithProvider(invoice, actor, { includeClosed: false, swallowErrors: true });
          if (again.status === 'PAID') throw new ConflictException({ code: 'INVOICE_ALREADY_PAID', message: 'Энэ invoice төлөгдсөн тул цуцлах боломжгүй' });
        }
        throw e;
      }
    }
    const { count } = await this.prisma.paymentInvoice.updateMany({ where: { id: invoice.id, status: 'PENDING' }, data: { status: 'CANCELLED', updatedBy: byWhom(ctx) } });
    const fresh = await this.load(ctx.orgId, id);
    if (count === 0 && fresh.status === 'PAID') throw new ConflictException({ code: 'INVOICE_ALREADY_PAID', message: 'Энэ invoice төлөгдсөн тул цуцлах боломжгүй' });
    return toInvoiceView(fresh);
  }

  // ── Callback ────────────────────────────────────────────────────────────────────

  /**
   * Брифийн §API callback: callback-ийн агуулгад ИТГЭХГҮЙ. Зөвхөн senderInvoiceNo-оор invoice олж checkInvoice-ээр баталгаажуулсны дараа бүртгэнэ.
   * Үл мэдэгдэх invoice-д PII-гүй лог бичээд чимээгүй буцна.
   */
  async handleCallback(provider: 'QPAY' | 'SOCIALPAY', senderInvoiceNo: string): Promise<void> {
    const invoice = await this.prisma.paymentInvoice.findUnique({ where: { senderInvoiceNo } });
    if (!invoice || invoice.provider !== provider) {
      this.logger.warn(`${provider} callback: үл мэдэгдэх invoice (${safeLogText(senderInvoiceNo)})`);
      return;
    }
    if (invoice.status === 'PAID') return;
    await this.syncWithProvider(invoice, systemActor(invoice.orgId), { includeClosed: true, swallowErrors: true });
  }
}
