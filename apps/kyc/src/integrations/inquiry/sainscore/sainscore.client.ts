// SainScore (ЗМС) API Inquire v1.7 клиент: POST /login → Bearer токен, POST /inquiry. Протокол: Python лавлагаа (apps/integrations/sainscore).
// Хураамжтай (priced) лавлагаа тул `/inquiry`-г ХЭЗЭЭ Ч дахин илгээхгүй (timeout / 5xx / сүлжээ → түр алдаа; хэрэглэгч дахин оролдоно). Зөвхөн /login (idempotent) дахин оролдоно.
// Алдааны мессеж регистр, утас, имэйл, токен, нууц hash агуулахгүй; vendor-ийн мессеж 200 тэмдэгтээр тайрагдана.
import { InquiryRejectedError, InquiryUnavailableError, type ExternalInquirySource } from '../inquiry.provider';

const SUCCESS_CODE = 'SR0000';
/** Vendor-ийн ӨӨРИЙН сервер алдаа (лавлагаа ажиллаагүй) → түр алдаа. SR0130/0140/0150 (хураамжийн гүйлгээ) зориуд ороогүй: төлбөрийн үйлдэлд хүрсэн тул терминал. */
const VENDOR_SERVER_CODES = new Set(['SR0050', 'SR1090', 'SR1095']);
/** Vendor-ийн баталсан 1000 минутын токеноос 10 минутын зайтай. */
const TOKEN_TTL_MS = 990 * 60_000;
const MAX_VENDOR_MESSAGE = 200;

export interface SainScoreClientOptions {
  baseUrl: string;
  username: string;
  /** Vendor-ийн convert-hash-map-ээр гаргасан hash — өөрчлөхгүй, шууд илгээнэ. */
  passwordHash: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** CLAUDE.md §3.1: гадаад дуудлагын timeout 15с. */
  timeoutMs?: number;
  /** /login-ийн нэмэлт оролдлого (анхдагч 2 → нийт 3). */
  maxLoginRetries?: number;
  backoffMs?: number;
}

export interface CibInquiryRequest { registerNo: string; productNo: string; phone: string; email: string }
export interface SainScoreInquiryResult { decision: string | null; responseMessage: string | null; rows: unknown[] }

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (v: unknown): string => String(v ?? '').slice(0, MAX_VENDOR_MESSAGE);

export class SainScoreClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxLoginRetries: number;
  private readonly backoffMs: number;
  private token: { value: string; expiresAtMs: number } | null = null;
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly opts: SainScoreClientOptions) {
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxLoginRetries = opts.maxLoginRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
  }

  async inquiry(source: ExternalInquirySource, req: CibInquiryRequest): Promise<SainScoreInquiryResult> {
    const token = await this.getToken(source);
    const res = await this.send(source, '/inquiry', {
      productno: req.productNo, purptypeid: '01', purposedesc: 'Зээл лавлагаа авах', acnttypeid: '02',
      custregno: req.registerNo, custtypeid: '01', custphone: req.phone, custemail: req.email,
    }, token);
    if (res.status === 401) { this.token = null; throw new InquiryUnavailableError(source, `${source}: нэвтрэлтийн токен хүчингүй боллоо (дахин оролдоно уу)`); }
    if (res.status >= 400) throw new InquiryUnavailableError(source, `${source}: лавлагааны сервис түр ажиллахгүй байна (HTTP ${res.status})`);
    const body = this.object(source, res.body);

    const code = body.responsecode;
    if (code !== undefined && code !== null && code !== SUCCESS_CODE) {
      const vendorCode = String(code);
      if (VENDOR_SERVER_CODES.has(vendorCode)) throw new InquiryUnavailableError(source, `${source}: vendor-ийн сервер алдаа [${vendorCode}] (лавлагаа ажиллаагүй)`);
      throw new InquiryRejectedError(source, vendorCode, `${source}: vendor татгалзлаа [${vendorCode}] ${clip(body.responsemsg)}`.trim());
    }
    if (!Array.isArray(body.inquiry)) throw new InquiryUnavailableError(source, `${source}: vendor-ийн хариуны хэлбэр буруу байна`);
    return { decision: typeof body.decision === 'string' ? body.decision : null, responseMessage: typeof body.responsemsg === 'string' ? body.responsemsg : null, rows: body.inquiry };
  }

  // ── токен ───────────────────────────────────────────────────────────────────────

  private getToken(source: ExternalInquirySource): Promise<string> {
    if (this.token && this.token.expiresAtMs > this.now()) return Promise.resolve(this.token.value);
    this.loginInFlight ??= this.loginWithRetry(source).finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  /** /login нь idempotent (хураамжгүй) тул түр алдаанд exponential backoff-оор дахин оролдоно. */
  private async loginWithRetry(source: ExternalInquirySource): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.login(source);
      } catch (e) {
        if (!(e instanceof InquiryUnavailableError) || attempt >= this.maxLoginRetries) throw e;
        await this.sleep(this.backoffMs * 2 ** attempt);
      }
    }
  }

  private async login(source: ExternalInquirySource): Promise<string> {
    const res = await this.send(source, '/login', { username: this.opts.username, password: this.opts.passwordHash });
    if (res.status >= 400) throw new InquiryUnavailableError(source, `${source}: vendor-т нэвтэрч чадсангүй (HTTP ${res.status})`);
    const body = this.object(source, res.body);
    if (body.success !== true) throw new InquiryRejectedError(source, 'LOGIN_REJECTED', `${source}: vendor нэвтрэлтийг татгалзлаа ${clip(body.msg)}`.trim());
    if (typeof body.token !== 'string' || body.token === '') throw new InquiryUnavailableError(source, `${source}: vendor-ийн нэвтрэлтийн хариунд токен алга`);
    this.token = { value: body.token, expiresAtMs: this.now() + TOKEN_TTL_MS };
    return body.token;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────

  private object(source: ExternalInquirySource, body: unknown): Json {
    if (!isObject(body)) throw new InquiryUnavailableError(source, `${source}: vendor-ийн хариуны хэлбэр буруу байна`);
    return body;
  }

  private async send(source: ExternalInquirySource, path: string, body: Json, token?: string): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST', signal: ctrl.signal, body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) { try { parsed = JSON.parse(text); } catch { if (res.status < 400) throw new InquiryUnavailableError(source, `${source}: vendor-ийн хариуг уншиж чадсангүй`); } }
      return { status: res.status, body: parsed };
    } catch (e) {
      if (e instanceof InquiryUnavailableError) throw e;
      const aborted = ctrl.signal.aborted || (e instanceof Error && e.name === 'AbortError');
      throw new InquiryUnavailableError(source, aborted ? `${source}: vendor хариу өгсөнгүй (timeout)` : `${source}: vendor-тэй холбогдож чадсангүй`);
    } finally {
      clearTimeout(timer);
    }
  }
}
