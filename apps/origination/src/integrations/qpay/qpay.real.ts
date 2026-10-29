// QPay merchant API v2 — НИЙТЭД МЭДЭГДЭХ баримтаар бичсэн клиент.
// АНХААР: sandbox (https://merchant-sandbox.qpay.mn/v2)-д ТӨВЛӨРСӨН ТУРШИЛТ ХИЙГЭЭГҮЙ — credential авсны дараа шалгана.
// Тест нь fetch stub-аар (qpay.real.test.ts) хүсэлт/хариуны хэлбэр, токен, дахин оролдлого, timeout-ийг шалгасан.
// Баталгаажаагүй таамаглал (credential-тай шалгах):
//   · auth/token-ийн `expires_in` — epoch секунд (> 1e9) эсвэл үлдсэн секунд аль нь ч байж болно гэж үзсэн;
//   · payment_date-д цагийн бүс байхгүй бол Asia/Ulaanbaatar (+08:00) гэж үзсэн;
//   · токен шинэчлэлт нь /auth/refresh биш, /auth/token-оор дахин нэвтрэх хэлбэрээр.
import { z } from 'zod';
import { requireEnv } from '../../shared/integration-mode';
import type { IntegrationMode, PaymentDeeplink } from '@los/contracts';
import type {
  CreateProviderInvoiceRequest, ProviderCheckResult, ProviderInvoice, ProviderInvoiceRef, ProviderPayment,
} from '../payment-provider/payment-provider.port';
import { ProviderRejectedError, ProviderUnavailableError } from '../payment-provider/provider-errors';
import { sanitizeRaw } from '../payment-provider/sanitize';
import type { QPayClient, QPayConfig } from './qpay.client';

export const QPAY_DEFAULT_BASE_URL = 'https://merchant-sandbox.qpay.mn/v2';
const REQUIRED_ENV = ['QPAY_USERNAME', 'QPAY_PASSWORD', 'QPAY_INVOICE_CODE', 'QPAY_CALLBACK_BASE_URL'];

export interface RealQPayOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** CLAUDE.md §3.1: гадаад дуудлагын timeout 15с. */
  timeoutMs?: number;
  /** 5xx / сүлжээний алдаанд нэмэлт оролдлого (анхдагч 2 → нийт 3 дуудлага). */
  maxRetries?: number;
  backoffMs?: number;
}

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().optional() }).passthrough();
const InvoiceResponse = z.object({
  invoice_id: z.string().min(1),
  qr_text: z.string().optional().nullable(),
  qr_image: z.string().optional().nullable(),
  qPay_shortUrl: z.string().optional().nullable(),
  urls: z.array(z.object({ name: z.string(), description: z.string().optional().nullable(), logo: z.string().optional().nullable(), link: z.string() }).passthrough()).optional().nullable(),
}).passthrough();
const CheckResponse = z.object({
  rows: z.array(z.object({
    payment_id: z.union([z.string(), z.number()]),
    payment_status: z.string(),
    payment_date: z.string().optional().nullable(),
    payment_amount: z.union([z.string(), z.number()]).optional().nullable(),
    payment_currency: z.string().optional().nullable(),
  }).passthrough()).optional().nullable(),
}).passthrough();

type Json = Record<string, unknown>;
interface HttpResult { status: number; body: unknown }

export class RealQPayClient implements QPayClient {
  readonly provider = 'QPAY' as const;
  readonly mode: IntegrationMode = 'real';
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private token: { value: string; expiresAtMs: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(opts: RealQPayOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
  }

  isAvailable(): boolean { return REQUIRED_ENV.every((n) => !!this.env[n]); }
  unavailableReason() { return this.isAvailable() ? null : ('NOT_CONFIGURED' as const); }

  /** Тохиргоо дутуу бол IntegrationNotConfiguredError (→ 503 PROVIDER_NOT_CONFIGURED). */
  private config(): QPayConfig {
    const e = requireEnv('qpay', REQUIRED_ENV, this.env);
    return {
      baseUrl: (this.env.QPAY_BASE_URL || QPAY_DEFAULT_BASE_URL).replace(/\/+$/, ''),
      username: e.QPAY_USERNAME, password: e.QPAY_PASSWORD, invoiceCode: e.QPAY_INVOICE_CODE, callbackBaseUrl: e.QPAY_CALLBACK_BASE_URL.replace(/\/+$/, ''),
    };
  }

  async createInvoice(req: CreateProviderInvoiceRequest): Promise<ProviderInvoice> {
    const cfg = this.config();
    if (req.currency !== 'MNT') throw new ProviderRejectedError('QPay', 'CURRENCY_UNSUPPORTED', 'QPay: зөвхөн MNT валют дэмжигдэнэ');
    if (!(req.amount > 0)) throw new ProviderRejectedError('QPay', 'INVALID_AMOUNT', 'QPay: дүн эерэг байх ёстой');
    const body: Json = {
      invoice_code: cfg.invoiceCode,
      sender_invoice_no: req.senderInvoiceNo,
      invoice_receiver_code: req.receiverCode,
      invoice_description: req.description.slice(0, 200),
      amount: req.amount,
      callback_url: `${cfg.callbackBaseUrl}/payments/callbacks/qpay?invoice=${encodeURIComponent(req.senderInvoiceNo)}`,
    };
    const res = await this.call('POST', '/invoice', body);
    const parsed = InvoiceResponse.safeParse(res);
    if (!parsed.success) throw new ProviderUnavailableError('QPay', 'QPay: хариуны хэлбэр буруу байна');
    const r = parsed.data;
    const deeplinks: PaymentDeeplink[] = (r.urls ?? []).map((u) => ({ name: u.name, description: u.description ?? null, logo: u.logo ?? null, link: u.link }));
    return {
      providerInvoiceId: r.invoice_id, qrText: r.qr_text ?? null, qrImage: r.qr_image ?? null, deeplinks,
      raw: sanitizeRaw({ invoice_id: r.invoice_id, qPay_shortUrl: r.qPay_shortUrl ?? null }) as Record<string, unknown>,
    };
  }

  async checkInvoice(ref: ProviderInvoiceRef): Promise<ProviderCheckResult> {
    const res = await this.call('POST', '/payment/check', { object_type: 'INVOICE', object_id: ref.providerInvoiceId, offset: { page_number: 1, page_limit: 100 } });
    const parsed = CheckResponse.safeParse(res);
    if (!parsed.success) throw new ProviderUnavailableError('QPay', 'QPay: хариуны хэлбэр буруу байна');
    const payments: ProviderPayment[] = [];
    for (const row of parsed.data.rows ?? []) {
      if (row.payment_status !== 'PAID') continue;
      const amount = Number(row.payment_amount);
      // Дүнгүй PAID мөрийг хэзээ ч таамаглаж бүртгэхгүй — түр алдаа гэж үзэж дараа дахин шалгана.
      if (!Number.isFinite(amount) || amount <= 0) throw new ProviderUnavailableError('QPay', 'QPay: төлбөрийн дүн буруу байна');
      payments.push({
        providerPaymentId: String(row.payment_id), amount, currency: row.payment_currency || 'MNT',
        paidAt: this.parseDate(row.payment_date), payerName: null, payerAccount: null, raw: sanitizeRaw(row),
      });
    }
    return { paid: payments.length > 0, payments };
  }

  async cancelInvoice(ref: ProviderInvoiceRef): Promise<void> {
    try {
      await this.call('DELETE', `/invoice/${encodeURIComponent(ref.providerInvoiceId)}`);
    } catch (e) {
      if (e instanceof ProviderRejectedError && e.providerCode === 'HTTP_404') return; // аль хэдийн байхгүй/цуцлагдсан
      throw e;
    }
  }

  private parseDate(s: string | null | undefined): Date {
    if (!s) return this.now();
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
    const iso = s.includes(' ') ? s.replace(' ', 'T') : s;
    const d = new Date(hasZone ? iso : `${iso}+08:00`);
    return Number.isNaN(d.getTime()) ? this.now() : d;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────

  /** 5xx / сүлжээ / timeout-д exponential backoff-оор maxRetries удаа дахин оролдоно; 4xx-д оролдохгүй. */
  private async call(method: 'POST' | 'DELETE', path: string, body?: Json): Promise<unknown> {
    const cfg = this.config();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(cfg.baseUrl, method, path, body);
      } catch (e) {
        if (!(e instanceof ProviderUnavailableError) || attempt >= this.maxRetries) throw e;
        await this.sleep(this.backoffMs * 2 ** attempt);
      }
    }
  }

  private async callOnce(baseUrl: string, method: string, path: string, body?: Json): Promise<unknown> {
    let token = await this.getToken();
    let res = await this.send(baseUrl, method, path, body, `Bearer ${token}`);
    if (res.status === 401) { // токен хүчингүй болсон → нэг удаа дахин нэвтэрнэ
      this.invalidate(token);
      token = await this.getToken();
      res = await this.send(baseUrl, method, path, body, `Bearer ${token}`);
    }
    return this.unwrap(res);
  }

  private unwrap(res: HttpResult): unknown {
    if (res.status >= 500) throw new ProviderUnavailableError('QPay', `QPay: үйлчилгээ түр хүрэлцэхгүй байна (HTTP ${res.status})`);
    if (res.status >= 400) {
      const code = (res.body && typeof res.body === 'object' && typeof (res.body as Json).error === 'string' ? (res.body as Json).error as string : null) ?? `HTTP_${res.status}`;
      throw new ProviderRejectedError('QPay', res.status === 404 ? 'HTTP_404' : code, res.status === 401 ? 'QPay: нэвтрэлт амжилтгүй (username/password шалгана уу)' : `QPay: хүсэлтийг татгалзлаа (${code})`);
    }
    return res.body;
  }

  private invalidate(failed: string) { if (this.token?.value === failed) this.token = null; }

  private getToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs > this.now().getTime()) return Promise.resolve(this.token.value);
    this.tokenInFlight ??= this.authenticate().finally(() => { this.tokenInFlight = null; });
    return this.tokenInFlight;
  }

  private async authenticate(): Promise<string> {
    const cfg = this.config();
    const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    const res = await this.send(cfg.baseUrl, 'POST', '/auth/token', undefined, `Basic ${basic}`);
    const body = this.unwrap(res);
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new ProviderUnavailableError('QPay', 'QPay: токены хариу буруу байна');
    const nowMs = this.now().getTime();
    const exp = parsed.data.expires_in;
    let expiresAtMs = exp === undefined ? nowMs + 5 * 60_000 : exp > 1e9 ? exp * 1000 : nowMs + exp * 1000;
    expiresAtMs -= 30_000; // тэвчих зай
    if (expiresAtMs <= nowMs) expiresAtMs = nowMs + 5_000;
    this.token = { value: parsed.data.access_token, expiresAtMs };
    return parsed.data.access_token;
  }

  private async send(baseUrl: string, method: string, path: string, body: Json | undefined, authorization: string): Promise<HttpResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${baseUrl}${path}`, {
        method, signal: ctrl.signal,
        headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) { try { parsed = JSON.parse(text); } catch { if (res.status < 400) throw new ProviderUnavailableError('QPay', 'QPay: хариуг уншиж чадсангүй'); } }
      return { status: res.status, body: parsed };
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw e;
      const aborted = ctrl.signal.aborted || (e instanceof Error && e.name === 'AbortError');
      throw new ProviderUnavailableError('QPay', aborted ? 'QPay: хариу ирсэнгүй (timeout)' : 'QPay: сүлжээний алдаа', e);
    } finally {
      clearTimeout(timer);
    }
  }
}
