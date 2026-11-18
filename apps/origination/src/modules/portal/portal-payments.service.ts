import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  PortalCreatePaymentCommand, PortalId, PortalPayment, PortalPaymentList, PortalPaymentListQuery, PortalPaymentMethodLimit,
  type PaymentProvider, type PortalPaymentAmountType, type PortalPaymentMethod, type RequestContext,
} from '@los/contracts';
import type { PaymentInvoice, Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { InvoiceService, PortalIdempotencyConflict } from '../payment/invoice.service';
import { actorOf } from '../payment/payment.service';
import { ProviderRegistry } from '../payment/provider-registry';
import { portalError } from './portal-errors';
import type { Ledger } from './portal-ledger';
import { PortalLoansService, type PortalLoan } from './portal-loans.service';

const METHOD_PROVIDER: Record<PortalPaymentMethod, PaymentProvider> = { QPAY: 'QPAY', SOCIALPAY: 'SOCIALPAY', BANK_ACCOUNT: 'BANK_TRANSFER' };
const PROVIDER_METHOD: Record<string, PortalPaymentMethod> = { QPAY: 'QPAY', SOCIALPAY: 'SOCIALPAY', BANK_TRANSFER: 'BANK_ACCOUNT' };
/** QPay, SocialPay зөвхөн MNT (InvoiceService CURRENCY_NOT_SUPPORTED). */
const MNT_ONLY = new Set<PaymentProvider>(['QPAY', 'SOCIALPAY']);

/**
 * Idempotency (PRT-FR-5.3, docs/05 §6 «(customerId, key)»): `payment_invoice.portal_idempotency_key` = sha256(org|customer|key)[:32],
 * UNIQUE (org_id, portal_idempotency_key). Мөрийг провайдер дуудахаас ӨМНӨ түлхүүртэй нь нөөцөлдөг тул олон pod зэрэг ирэхэд нэг л invoice,
 * нэг л провайдерын дуудлага; ялагдсан нь (P2002) ялагчийг уншина — провайдерын хариу хүлээгдэж байвал 409 REQUEST_IN_PROGRESS.
 * `portal_request_hash` = `<amountType>:<sha256(body)[:32]>` — өөр body → 422. Нэг процесс дотор нэмэлтээр single-flight (DECISIONS.md H8).
 */
const REQUEST_HASH = /^(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):[0-9a-f]{32}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const CURSOR = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

const INVOICE_INCLUDE = { payments: { select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 } } satisfies Prisma.PaymentInvoiceInclude;
type InvoiceRow = PaymentInvoice & { payments: Array<{ createdAt: Date }> };

@Injectable()
export class PortalPaymentsService {
  private readonly inflight = new Map<string, { bodyHash: string; run: Promise<PortalPayment> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly loans: PortalLoansService,
    private readonly invoices: InvoiceService,
    private readonly registry: ProviderRegistry,
    private readonly settings: OrgSettings,
  ) {}

  /** PRT-FR-5.1: идэвхтэй хэрэгсэл + доод (payment.min_amount) / дээд (зээлийн валютаар: portal.payment_max_amount[_usd]) — тохиргооноос. */
  async methods(ctx: RequestContext, loanId: string): Promise<PortalPaymentMethodLimit[]> {
    const loan = await this.loans.owned(ctx, loanId);
    return this.availableMethods(ctx.orgId, loan);
  }

  async create(ctx: RequestContext, loanId: string, body: unknown, idempotencyKey: string | undefined): Promise<PortalPayment> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw portalError.invalid('Idempotency-Key заавал');
    const parsed = PortalCreatePaymentCommand.safeParse(body);
    if (!parsed.success || parsed.data.loanId !== loanId) throw portalError.invalid();
    const cmd = parsed.data;
    const keyHash = sha(`${ctx.orgId}|${ctx.customerId}|${idempotencyKey}`);
    const bodyHash = `${cmd.amountType}:${sha(JSON.stringify([cmd.loanId, cmd.method, cmd.amountType, cmd.amount, cmd.currency]))}`;

    const running = this.inflight.get(keyHash);
    if (running) {
      if (running.bodyHash !== bodyHash) throw portalError.keyReused();
      return running.run;
    }
    const run = this.createOnce(ctx, cmd, keyHash, bodyHash).finally(() => this.inflight.delete(keyHash));
    this.inflight.set(keyHash, { bodyHash, run });
    return run;
  }

  async get(ctx: RequestContext, paymentId: string): Promise<PortalPayment> {
    if (!PortalId.safeParse(paymentId).success) throw portalError.paymentNotFound();
    const invoice = await this.prisma.paymentInvoice.findFirst({ where: { id: paymentId, orgId: ctx.orgId, application: this.loans.ownedFilter(ctx) } });
    if (!invoice) throw portalError.paymentNotFound();
    // PRT-FR-5.4: PENDING бол провайдераас шалгаж төлөвийг шинэчилнэ (провайдерын алдаа уншилтыг унагахгүй)
    await this.invoices.refresh(invoice, actorOf(ctx));
    return this.view(await this.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: invoice.id }, include: INVOICE_INCLUDE }));
  }

  /** PRT-FR-5.5: шинэ нь түрүүнд, cursor = base64url(`<createdAtMs>.<id>`). Мэдэхгүй cursor → 400 (эхний хуудас руу чимээгүй буцахгүй). */
  async list(ctx: RequestContext, loanId: string, rawQuery: Record<string, unknown>): Promise<PortalPaymentList> {
    const loan = await this.loans.owned(ctx, loanId);
    const q = PortalPaymentListQuery.safeParse(rawQuery);
    if (!q.success) throw portalError.invalid();
    const after = q.data.cursor ? await this.decodeCursor(loan.id, q.data.cursor) : null;
    const rows = await this.prisma.paymentInvoice.findMany({
      where: {
        applicationId: loan.id, orgId: ctx.orgId,
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.data.limit + 1, include: INVOICE_INCLUDE,
    });
    const page = rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > q.data.limit && last ? Buffer.from(`${last.createdAt.getTime()}.${last.id}`).toString('base64url') : null;
    return PortalPaymentList.parse({ items: page.map((r) => this.view(r)), nextCursor });
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async createOnce(ctx: RequestContext, cmd: PortalCreatePaymentCommand, keyHash: string, bodyHash: string): Promise<PortalPayment> {
    const existing = await this.byKey(ctx, keyHash);
    if (existing) return this.replay(existing, bodyHash);
    const loan = await this.loans.owned(ctx, cmd.loanId);
    // Зээлийн бодит валют (MNT/USD-ээс өөр бол портал төлбөр хүлээхгүй) — currencyOf()-ийн MNT fallback-д найдахгүй
    if (cmd.currency !== loan.currency) throw portalError.invalid('Валют таарахгүй');
    if (loan.status === 'CLOSED') throw portalError.notPayable();
    const amount = this.serverAmount(cmd, await this.loans.ledgerFor(loan));
    if (amount > (await this.maxAmount(ctx.orgId, cmd.currency))) throw portalError.amountOutOfRange();
    if (!(await this.availableMethods(ctx.orgId, loan)).some((m) => m.method === cmd.method)) throw portalError.methodNotAvailable();

    try {
      const { view } = await this.invoices.create(ctx, { applicationId: loan.id, provider: METHOD_PROVIDER[cmd.method], amount }, { key: keyHash, requestHash: bodyHash });
      return this.view(await this.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id }, include: INVOICE_INCLUDE }));
    } catch (e) {
      if (!(e instanceof PortalIdempotencyConflict)) throw e;
      // Өөр pod ижил түлхүүрийг түрүүлж нөөцөлсөн. Устгагдсан (провайдер унасан) бол түлхүүр суллагдсан — portal-bff дахин оролдоно.
      const winner = await this.byKey(ctx, keyHash);
      if (!winner) throw portalError.requestInProgress();
      return this.replay(winner, bodyHash);
    }
  }

  /** Ижил түлхүүрийн invoice: өөр body → 422; провайдерын хариу хараахан бичигдээгүй (нөөцлөгдсөн л) → 409 REQUEST_IN_PROGRESS. */
  private replay(invoice: InvoiceRow, bodyHash: string): PortalPayment {
    if (invoice.portalRequestHash !== bodyHash) throw portalError.keyReused();
    const awaitingProvider = invoice.provider !== 'BANK_TRANSFER' && !invoice.providerInvoiceId && invoice.status === 'PENDING';
    if (awaitingProvider) throw portalError.requestInProgress();
    return this.view(invoice);
  }

  /** portal.payment_max_amount нь ЗӨВХӨН MNT; USD зээлд portal.payment_max_amount_usd (PortalCurrency = MNT | USD). */
  private maxAmount(orgId: string, currency: PortalCreatePaymentCommand['currency']): Promise<number> {
    return currency === 'USD' ? this.settings.get(orgId, 'portal.payment_max_amount_usd') : this.settings.get(orgId, 'portal.payment_max_amount');
  }

  /**
   * PRT-FR-5.2: CUSTOM-оос бусад төрөлд дүнг СЕРВЕР тодорхойлно — portal-bff-ийн илгээсэн дүн тэр дүнтэй яг тэнцүү байх ёстой
   * (payment-options-оос хойш үлдэгдэл өөрчлөгдсөн бол 422 — харилцагч сонголтоо шинэчилнэ). Бүх төрөл ≤ бүрэн хаах дүн.
   * Доод хязгаарыг InvoiceService шалгана: PAYOFF нь нийт үлдэгдэлтэй тэнцүү тул түүний floor = min(min_amount, үлдэгдэл) → доод хязгаар үйлчлэхгүй.
   */
  private serverAmount(cmd: PortalCreatePaymentCommand, ledger: Ledger): number {
    const payoff = ledger.payoff.amount;
    if (payoff <= 0) throw portalError.notPayable();
    let expected: number;
    switch (cmd.amountType) {
      case 'CUSTOM':
        if (cmd.amount > payoff) throw portalError.amountOutOfRange('Бүрэн хаах дүнгээс их төлөх боломжгүй');
        return cmd.amount;
      case 'OVERDUE':
        if (ledger.overdue.total <= 0) throw portalError.noOverdue();
        expected = Math.min(ledger.overdue.total, payoff);
        break;
      case 'INSTALLMENT':
        if (!ledger.nextInstallment) throw portalError.notPayable();
        expected = Math.min(ledger.nextInstallment.amountDue, payoff);
        break;
      case 'PAYOFF':
        expected = payoff;
        break;
    }
    if (Math.round(expected * 100) !== Math.round(cmd.amount * 100)) throw portalError.amountOutOfRange('Төлөх дүн өөрчлөгдсөн байна, дахин сонгоно уу');
    return expected;
  }

  private async availableMethods(orgId: string, loan: PortalLoan): Promise<PortalPaymentMethodLimit[]> {
    const [info, minAmount, maxAmount] = await Promise.all([
      this.registry.info(orgId), this.settings.get(orgId, 'payment.min_amount'), this.maxAmount(orgId, loan.currency === 'USD' ? 'USD' : 'MNT'),
    ]);
    return info
      .filter((p) => p.enabled && (!MNT_ONLY.has(p.provider) || loan.currency === 'MNT'))
      .map((p) => PortalPaymentMethodLimit.parse({ method: PROVIDER_METHOD[p.provider], minAmount, maxAmount }));
  }

  private byKey(ctx: RequestContext, keyHash: string): Promise<InvoiceRow | null> {
    return this.prisma.paymentInvoice.findUnique({ where: { orgId_portalIdempotencyKey: { orgId: ctx.orgId, portalIdempotencyKey: keyHash } }, include: INVOICE_INCLUDE });
  }

  private async decodeCursor(applicationId: string, cursor: string): Promise<{ createdAt: Date; id: string }> {
    const m = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    const row = m ? await this.prisma.paymentInvoice.findFirst({ where: { id: m[2], applicationId }, select: { id: true, createdAt: true } }) : null;
    if (!m || !row || row.createdAt.getTime() !== Number(m[1])) throw portalError.invalid('cursor буруу');
    return row;
  }

  private view(inv: InvoiceRow): PortalPayment {
    const tag = inv.portalRequestHash ? REQUEST_HASH.exec(inv.portalRequestHash) : null;
    return PortalPayment.parse({
      paymentId: inv.id, loanId: inv.applicationId, method: PROVIDER_METHOD[inv.provider],
      amountType: (tag?.[1] as PortalPaymentAmountType | undefined) ?? 'CUSTOM',
      amount: Number(inv.amount), currency: inv.currency === 'USD' ? 'USD' : 'MNT', status: inv.status,
      createdAt: inv.createdAt.toISOString(), expiresAt: inv.expiresAt.toISOString(), paidAt: inv.paidAt?.toISOString() ?? null,
      postedAt: inv.status === 'PAID' ? (inv.payments[0]?.createdAt.toISOString() ?? null) : null,
      failureReason: null,
      checkout: inv.status === 'PENDING' ? checkoutOf(inv) : null,
    });
  }
}

/** Провайдерын deeplink-ийг гэрээний хязгаарт (≤32, link ≤2048) тааруулна; webUrl одоогоор провайдер өгдөггүй. */
function checkoutOf(inv: PaymentInvoice): PortalPayment['checkout'] {
  const raw = Array.isArray(inv.deeplinksJson) ? inv.deeplinksJson : [];
  const deeplinks = raw
    .map((d) => (d ?? {}) as { name?: unknown; description?: unknown; link?: unknown })
    .filter((d) => typeof d.name === 'string' && typeof d.link === 'string' && d.link.length <= 2048)
    .slice(0, 32)
    .map((d) => ({ name: d.name as string, description: typeof d.description === 'string' ? d.description : null, link: d.link as string }));
  return { qrText: inv.qrText && inv.qrText.length <= 4096 ? inv.qrText : null, deeplinks, webUrl: null };
}
