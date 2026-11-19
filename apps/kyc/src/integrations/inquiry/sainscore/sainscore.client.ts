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
  /**
   * Нэг inquiry() дуудлагын НИЙТ хугацаа (login + хураамжтай /inquiry). origination kyc-г 15с-д хүлээдэг тул түүнээс БОГИНО байх ёстой — эс бөгөөс origination timeout-д орж
   * хэрэглэгч дахин дарахад kyc-д аль хэдийн төлөгдсөн лавлагаа ДАХИН төлөгдөнө. Анхдагч 12с.
   */
  deadlineMs?: number;
  /** Login-ийн дараа үлдсэн төсөв үүнээс бага бол хураамжтай /inquiry-г ЯВУУЛАХГҮЙ (харилцахад хангалттай хугацаа үлдээгүй). Анхдагч 2с. */
  minInquiryBudgetMs?: number;
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
  private readonly deadlineMs: number;
  private readonly minInquiryBudgetMs: number;
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
    this.deadlineMs = opts.deadlineMs ?? 12_000;
    this.minInquiryBudgetMs = opts.minInquiryBudgetMs ?? 2_000;
  }

  async inquiry(source: ExternalInquirySource, req: CibInquiryRequest): Promise<SainScoreInquiryResult> {
    const deadlineAt = Date.now() + this.deadlineMs;
    const token = await this.getToken(source, deadlineAt);
    // Хураамжтай хүсэлтийг хариуг нь авах хангалттай төсөвгүй бол ЯВУУЛАХГҮЙ (төлбөр ногдохгүй); явуулсан бол timeout нь үлдсэн төсвөөр хязгаарлагдана.
    const remaining = deadlineAt - Date.now();
    if (remaining < this.minInquiryBudgetMs) throw new InquiryUnavailableError(source, `${source}: хугацааны төсөв дууссан тул лавлагаа илгээгдсэнгүй (төлбөр ногдоогүй)`);
    const res = await this.send(source, '/inquiry', {
      productno: req.productNo, purptypeid: '01', purposedesc: 'Зээл лавлагаа авах', acnttypeid: '02',
      custregno: req.registerNo, custtypeid: '01', custphone: req.phone, custemail: req.email,
    }, token, Math.min(this.timeoutMs, remaining));
    if (res.status === 401) { this.token = null; throw new InquiryUnavailableError(source, `${source}: нэвтрэлтийн токен хүчингүй боллоо (дахин оролдоно уу)`); }
    if (res.status >= 400) throw new InquiryUnavailableError(source, `${source}: лавлагааны сервис түр ажиллахгүй байна (HTTP ${res.status})`);
    const body = this.object(source, res.body);

    const code = body.responsecode;
    // responsecode БАЙХГҮЙ = амжилт БИШ (fail closed): gateway/алдааны JSON-г «хоосон зээлийн түүх» гэж ойлгож чадавхийг хэтрүүлэхгүй.
    if (code === undefined || code === null) throw new InquiryUnavailableError(source, `${source}: vendor-ийн хариуны хэлбэр буруу байна`);
    if (code !== SUCCESS_CODE) {
      const vendorCode = String(code);
      if (VENDOR_SERVER_CODES.has(vendorCode)) throw new InquiryUnavailableError(source, `${source}: vendor-ийн сервер алдаа [${vendorCode}] (лавлагаа ажиллаагүй)`);
      throw new InquiryRejectedError(source, vendorCode, `${source}: vendor татгалзлаа [${vendorCode}] ${clip(body.responsemsg)}`.trim());
    }
    if (!Array.isArray(body.inquiry)) throw new InquiryUnavailableError(source, `${source}: vendor-ийн хариуны хэлбэр буруу байна`);
    return { decision: typeof body.decision === 'string' ? body.decision : null, responseMessage: typeof body.responsemsg === 'string' ? body.responsemsg : null, rows: body.inquiry };
  }

  // ── токен ───────────────────────────────────────────────────────────────────────

  private getToken(source: ExternalInquirySource, deadlineAt: number): Promise<string> {
    if (this.token && this.token.expiresAtMs > this.now()) return Promise.resolve(this.token.value);
    this.loginInFlight ??= this.loginWithRetry(source, deadlineAt).finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  /** /login нь idempotent (хураамжгүй) тул түр алдаанд exponential backoff-оор дахин оролдоно. */
  private async loginWithRetry(source: ExternalInquirySource, deadlineAt: number): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.login(source, deadlineAt);
      } catch (e) {
        if (!(e instanceof InquiryUnavailableError) || attempt >= this.maxLoginRetries) throw e;
        const backoff = this.backoffMs * 2 ** attempt;
        if (deadlineAt - Date.now() <= backoff) throw e; // төсөв үлдээгүй: дахин оролдохгүй
        await this.sleep(backoff);
      }
    }
  }

  private async login(source: ExternalInquirySource, deadlineAt: number): Promise<string> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new InquiryUnavailableError(source, `${source}: хугацааны төсөв дууссан`);
    const res = await this.send(source, '/login', { username: this.opts.username, password: this.opts.passwordHash }, undefined, Math.min(this.timeoutMs, remaining));
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

  private async send(source: ExternalInquirySource, path: string, body: Json, token?: string, timeoutMs: number = this.timeoutMs): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
