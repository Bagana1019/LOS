import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import type { IntegrationMode, PaymentDeeplink } from '@los/contracts';
import {
  CreateProviderInvoiceRequest, FailNextOptions, InvoiceProvider, PaymentProviderPort, ProviderCheckResult, ProviderInvoice,
  ProviderInvoiceRef, ProviderMethod, ProviderPayment, SimulatableProvider,
} from './payment-provider.port';
import { ProviderRejectedError, ProviderUnavailableError } from './provider-errors';

interface LedgerInvoice {
  request: CreateProviderInvoiceRequest;
  invoice: ProviderInvoice;
  status: 'OPEN' | 'PAID' | 'CANCELLED';
  payment: ProviderPayment | null;
}

export interface MockProviderOptions { now?: () => Date }

/**
 * QPay / SocialPay mock-ийн нийтлэг үндэс: процесс доторх (in-memory) ledger, deterministic ID.
 * Тестээс: `simulatePayment(providerInvoiceId)` — төлөгдсөн болгоно; `failNext()` — дараагийн дуудлагыг алдаатай болгоно.
 * Ижил senderInvoiceNo-той createInvoice нь ижил invoice буцаана (бодит провайдерын idempotency-г дуурайна).
 */
export abstract class MockInvoiceProvider implements PaymentProviderPort, SimulatableProvider {
  abstract readonly provider: InvoiceProvider;
  readonly mode: IntegrationMode = 'mock';
  protected abstract readonly idPrefix: string;
  protected abstract qrPayload(providerInvoiceId: string, req: CreateProviderInvoiceRequest): string;
  protected abstract deeplinksFor(qrText: string, providerInvoiceId: string): PaymentDeeplink[];

  protected readonly ledger = new Map<string, LedgerInvoice>();
  private readonly failures: Array<{ method?: ProviderMethod; error: Error; remaining: number }> = [];
  protected readonly now: () => Date;

  constructor(opts: MockProviderOptions = {}) { this.now = opts.now ?? (() => new Date()); }

  isAvailable() { return true; }
  unavailableReason() { return null; }

  /** Дараагийн (эсвэл method-оор заасан) дуудлага(ууд)ыг алдаатай болгоно. Анхдагч алдаа: ProviderUnavailableError. */
  failNext(opts: FailNextOptions = {}): void {
    this.failures.push({ method: opts.method, error: opts.error ?? new ProviderUnavailableError(this.provider, `${this.provider} mock: тест хийж буй алдаа`), remaining: opts.times ?? 1 });
  }

  private maybeFail(method: ProviderMethod): void {
    const i = this.failures.findIndex((f) => !f.method || f.method === method);
    if (i < 0) return;
    const f = this.failures[i];
    if (--f.remaining <= 0) this.failures.splice(i, 1);
    throw f.error;
  }

  async createInvoice(req: CreateProviderInvoiceRequest): Promise<ProviderInvoice> {
    this.maybeFail('createInvoice');
    if (!(req.amount > 0)) throw new ProviderRejectedError(this.provider, 'INVALID_AMOUNT', `${this.provider}: дүн эерэг байх ёстой`);
    if (req.currency !== 'MNT') throw new ProviderRejectedError(this.provider, 'CURRENCY_UNSUPPORTED', `${this.provider}: зөвхөн MNT валют дэмжигдэнэ`);
    const providerInvoiceId = `${this.idPrefix}_${createHash('sha1').update(req.senderInvoiceNo).digest('hex').slice(0, 12)}`;
    const existing = this.ledger.get(providerInvoiceId);
    if (existing) {
      if (existing.request.amount !== req.amount) throw new ProviderRejectedError(this.provider, 'SENDER_INVOICE_NO_DUPLICATED', `${this.provider}: sender_invoice_no давхардлаа`);
      return existing.invoice;
    }
    const qrText = this.qrPayload(providerInvoiceId, req);
    const qrImage = (await QRCode.toBuffer(qrText, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' })).toString('base64');
    const invoice: ProviderInvoice = {
      providerInvoiceId, qrText, qrImage, deeplinks: this.deeplinksFor(qrText, providerInvoiceId),
      raw: { mock: true, invoice_id: providerInvoiceId, sender_invoice_no: req.senderInvoiceNo },
    };
    this.ledger.set(providerInvoiceId, { request: req, invoice, status: 'OPEN', payment: null });
    return invoice;
  }

  async checkInvoice(ref: ProviderInvoiceRef): Promise<ProviderCheckResult> {
    this.maybeFail('checkInvoice');
    const entry = this.ledger.get(ref.providerInvoiceId);
    if (!entry) throw new ProviderRejectedError(this.provider, 'INVOICE_NOTFOUND', `${this.provider}: invoice олдсонгүй`);
    return { paid: entry.status === 'PAID', payments: entry.payment ? [entry.payment] : [] };
  }

  async cancelInvoice(ref: ProviderInvoiceRef): Promise<void> {
    this.maybeFail('cancelInvoice');
    const entry = this.ledger.get(ref.providerInvoiceId);
    if (!entry || entry.status === 'CANCELLED') return; // бодит провайдерт 404 = аль хэдийн байхгүй
    if (entry.status === 'PAID') throw new ProviderRejectedError(this.provider, 'INVOICE_PAID', `${this.provider}: төлөгдсөн invoice-ийг цуцлах боломжгүй`);
    entry.status = 'CANCELLED';
  }

  simulatePayment(providerInvoiceId: string, opts: { amount?: number; paidAt?: Date; payerName?: string; payerAccount?: string } = {}): ProviderPayment {
    const entry = this.ledger.get(providerInvoiceId);
    if (!entry) throw new ProviderRejectedError(this.provider, 'INVOICE_NOTFOUND', `${this.provider} mock: invoice олдсонгүй`);
    if (entry.status === 'CANCELLED') throw new ProviderRejectedError(this.provider, 'INVOICE_CANCELLED', `${this.provider} mock: цуцлагдсан invoice-ийг төлөх боломжгүй`);
    if (entry.payment) return entry.payment;
    entry.payment = {
      providerPaymentId: `${providerInvoiceId}_P1`,
      amount: opts.amount ?? entry.request.amount,
      currency: entry.request.currency,
      paidAt: opts.paidAt ?? this.now(),
      payerName: opts.payerName ?? 'Тест Төлөгч',
      payerAccount: opts.payerAccount ?? '5012345678',
      raw: { mock: true, payment_id: `${providerInvoiceId}_P1`, payment_status: 'PAID', payer_account: opts.payerAccount ?? '5012345678' },
    };
    entry.status = 'PAID';
    return entry.payment;
  }

  /** Тестийн helper: ledger болон төлөвлөсөн алдааг цэвэрлэнэ. */
  reset(): void { this.ledger.clear(); this.failures.length = 0; }

  /** Тестийн helper: ledger-т бүртгэлтэй invoice-ийн тоо. */
  invoiceCount(): number { return this.ledger.size; }
  /** Тестийн helper: ledger-ийн төлөв. */
  statusOf(providerInvoiceId: string): 'OPEN' | 'PAID' | 'CANCELLED' | undefined { return this.ledger.get(providerInvoiceId)?.status; }
}
