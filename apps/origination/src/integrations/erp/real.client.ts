import { createHmac } from 'node:crypto';
import type { ErpEventPayload } from '@los/contracts';
import { ErpPostError, type ErpGateway, type ErpPostContext, type ErpPostResult } from './erp.interface';

export interface RealErpClientOptions {
  url: string; webhookSecret: string; token?: string; timeoutMs: number;
  // true бол 2xx хариу заавал лавлах дугаар (reference/id…) эсвэл replay тэмдэгтэй байх ёстой (буруу URL-ийн 200 хуудсыг SENT гэж тооцохоос сэргийлнэ)
  requireAck?: boolean;
  allowInsecure?: boolean; fetchImpl?: typeof fetch; now?: () => Date;
}

const REF_FIELDS = ['reference', 'externalRef', 'documentId', 'journalId', 'id'] as const;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REF_LENGTH = 128;
// Хүсэлтийн чиглэл буруу (буруу зам/proxy) гэсэн статусууд: бичилт өөрөө буруу биш тул DEAD болгохгүй, backoff-оор дахин оролдоно
const ROUTE_STATUSES = new Set([404, 405, 406, 410, 415, 421]);
const HEADER_SAFE = /^[\x21-\x7E]+$/;

// eslint-disable-next-line no-control-regex -- хүлээн авагчийн текстээс удирдлагын тэмдэгтийг зориуд арилгана
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (s: string) => s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
const truncate = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Generic webhook/API клиент: POST JSON + HMAC-SHA256 гарын үсэг + Idempotency-Key. Vendor-specific (SAP, 1C, Core)
// payload хөрвүүлэлт шаардлагатай бол энэ port-ийг өөр RealXxx-ээр хэрэгжүүлнэ.
export class RealErpClient implements ErpGateway {
  readonly name = 'webhook';
  private readonly url: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly requireAck: boolean;
  private readonly secrets: string[];

  constructor(private readonly opts: RealErpClientOptions) {
    this.url = new URL(opts.url);
    if (this.url.username || this.url.password) throw new Error('ERP_API_URL must not contain credentials; use ERP_API_TOKEN');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname);
    if (this.url.protocol !== 'https:' && !(opts.allowInsecure || local)) throw new Error('ERP_API_URL must be https');
    if (!opts.webhookSecret) throw new Error('ERP_WEBHOOK_SECRET is required');
    if (opts.token && !HEADER_SAFE.test(opts.token)) throw new Error('ERP_API_TOKEN must be printable ASCII without spaces');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.requireAck = opts.requireAck ?? true;
    this.secrets = [opts.webhookSecret, opts.token].filter((s): s is string => !!s);
  }

  async post(payload: ErpEventPayload, ctx: ErpPostContext): Promise<ErpPostResult> {
    // Толгойд орох утга илгээгдэх боломжгүй бол (Cyrillic, CR/LF) fetch TypeError шидэж "сүлжээний алдаа" болон хэдэн цагаар давтагдана — шууд PERMANENT
    if (!HEADER_SAFE.test(payload.idempotencyKey) || !HEADER_SAFE.test(ctx.correlationId)) {
      throw new ErpPostError('idempotency key or correlation id is not a valid HTTP header value', 'PERMANENT', 'INVALID_REQUEST');
    }
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(this.now().getTime() / 1000).toString();
    const signature = createHmac('sha256', this.opts.webhookSecret).update(`${timestamp}.${body}`).digest('hex');
    const headers: Record<string, string> = {
      'content-type': 'application/json', accept: 'application/json',
      'idempotency-key': payload.idempotencyKey, 'x-los-event-id': payload.eventId, 'x-los-event-type': payload.eventType,
      'x-los-timestamp': timestamp, 'x-los-signature': `sha256=${signature}`,
      'x-correlation-id': ctx.correlationId, 'x-los-attempt': String(ctx.attemptNo),
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;

    let res: Response;
    try {
      // redirect: manual — токен/гарын үсгийг өөр хост руу дамжуулахгүй
      res = await this.fetchImpl(this.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ErpPostError(`ERP request timed out after ${this.opts.timeoutMs}ms`, 'RETRYABLE', 'TIMEOUT');
      const code = err.cause?.code ? ` (${clean(String(err.cause.code))})` : '';
      throw new ErpPostError(`ERP request failed: ${this.redact(truncate(err.message, 120))}${code}`, 'RETRYABLE', 'NETWORK');
    }

    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    const json = parseJson(text);
    const externalRef = pickRef(json, text);
    const replay = res.headers.get('idempotent-replayed') === 'true' || hasDuplicateFlag(json, text);
    const status = res.status;

    if (status >= 200 && status < 300) {
      if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
        throw new ErpPostError('ERP responded with an HTML page — check ERP_API_URL', 'RETRYABLE', 'UNEXPECTED_CONTENT', status);
      }
      if (this.requireAck && !externalRef && !replay) {
        throw new ErpPostError(`ERP responded ${status} without an acknowledgement reference`, 'RETRYABLE', 'NO_ACK', status);
      }
      return { externalRef, duplicate: replay };
    }
    // 409 нь зөвхөн хүлээн авагч "энэ түлхүүрийг өмнө нь бүртгэсэн" гэж ТОДОРХОЙ дохиолсон үед л давхардал. Бусад 409 (жишээ нь хаагдсан сар) — хүн засна.
    if (status === 409 && replay) return { externalRef, duplicate: true };

    const detail = this.redact(truncate(clean(text)));
    const msg = `ERP responded ${status}${detail ? `: ${detail}` : ''}`;
    if (status === 429 || status === 408 || status === 425) throw new ErpPostError(msg, 'RETRYABLE', 'THROTTLED', status, parseRetryAfter(res.headers.get('retry-after'), this.now()));
    if (status === 401 || status === 403) throw new ErpPostError(msg, 'RETRYABLE', 'AUTH_REJECTED', status);
    if (status >= 500) throw new ErpPostError(msg, 'RETRYABLE', 'SERVER_ERROR', status, parseRetryAfter(res.headers.get('retry-after'), this.now()));
    if (status >= 300 && status < 400) throw new ErpPostError(msg, 'RETRYABLE', 'REDIRECT', status);
    if (ROUTE_STATUSES.has(status)) throw new ErpPostError(msg, 'RETRYABLE', 'ROUTE_ERROR', status);
    throw new ErpPostError(msg, 'PERMANENT', 'REJECTED', status);
  }

  // Алдааны текстэд хүлээн авагчаас буцаж ирсэн токен/нууц/гарын үсэг орсон байж болно — DB, лог руу очихоос өмнө арилгана
  private redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[redacted]');
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/sha256=[0-9a-f]{16,}/gi, 'sha256=[redacted]');
  }
}

// Хариуны биеийг хязгаарласан хэмжээгээр уншина (буруу тохируулсан/хортой endpoint санах ой дүүргэхээс сэргийлнэ)
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch { /* дутуу хариу — байгаагаар нь ашиглана */ } finally { void reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const sanitizeRef = (v: string) => clean(v).slice(0, MAX_REF_LENGTH) || null;
// JSON задрахгүй (64KiB-аас том/дутуу) үед талбарыг regex-ээр хайна
function pickRef(json: unknown, text: string): string | null {
  if (json && typeof json === 'object') {
    for (const f of REF_FIELDS) {
      const v = (json as Record<string, unknown>)[f];
      if ((typeof v === 'string' && v) || typeof v === 'number') return sanitizeRef(String(v));
    }
    return null;
  }
  if (json === null && text) {
    for (const f of REF_FIELDS) {
      const m = new RegExp(`"${f}"\\s*:\\s*(?:"([^"\\\\]{1,${MAX_REF_LENGTH}})"|(\\d{1,18}))`).exec(text);
      if (m) return sanitizeRef(m[1] ?? m[2]);
    }
  }
  return null;
}
function hasDuplicateFlag(json: unknown, text: string): boolean {
  if (json && typeof json === 'object') return (json as { duplicate?: unknown }).duplicate === true;
  return json === null && /"duplicate"\s*:\s*true/.test(text);
}
export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 86_400)) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - now.getTime(), 86_400_000));
}
