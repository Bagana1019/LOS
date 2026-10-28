import { Logger } from '@nestjs/common';
import type { PortalErrorCode } from '@los/contracts';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ZodType } from 'zod';
import { PASS_THROUGH_DOWNSTREAM_CODES } from '../common/error-catalog';
import { PortalError } from '../common/portal-error';

export interface InternalContext {
  correlationId: string;
  /** Нэвтэрсэн харилцагч. Байхгүй бол нэвтрэхээс өмнөх (anonymous) дуудлага. */
  customerId?: string;
}

interface BaseRequest {
  path: string;
  ctx: InternalContext;
  headers?: Record<string, string>;
  /** 404-д буцаах код; заагаагүй бол гэрээний зөрчил гэж үзнэ. */
  notFound?: PortalErrorCode;
}

export interface JsonRequest<T> extends BaseRequest {
  method: 'GET' | 'POST';
  body?: unknown;
  schema: ZodType<T>;
}

export interface InternalHttpOptions {
  baseUrl: string;
  timeoutMs: number;
  maxStreamBytes: number;
  maxJsonBytes?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_GET_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Түр зуурын (дахин оролдож болох) доголдол. Дахин оролдлого дуусвал DOWNSTREAM_UNAVAILABLE болно. */
class TransientError extends Error {}

/**
 * portal-bff → origination дотоод REST (CLAUDE.md §3.1: дотоод timeout 3с, retry зөвхөн idempotent GET).
 * Хариуг zod-оор шалгана: гэрээнд үгүй талбар харилцагч руу гарахгүй; зөрчил → DOWNSTREAM_INVALID_RESPONSE.
 */
export class InternalHttpClient {
  private readonly logger = new Logger('InternalHttp');
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: InternalHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const attempts = req.method === 'GET' ? MAX_GET_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.jsonOnce(req);
      } catch (err) {
        if (!(err instanceof TransientError)) throw err;
        if (attempt >= attempts) throw new PortalError('DOWNSTREAM_UNAVAILABLE');
        await sleep((this.opts.retryDelayMs ?? 100) * attempt);
      }
    }
  }

  /** Том файл (PDF): timeout зөвхөн толгой ирэх хүртэл; биеийг stream-ээр дамжуулж, хэмжээг хязгаарлана. */
  async stream(req: BaseRequest): Promise<{ headers: Headers; stream: Readable }> {
    let sent: { res: Response; settle: () => void };
    try {
      sent = await this.send({ ...req, method: 'GET' });
    } catch (err) {
      throw err instanceof TransientError ? new PortalError('DOWNSTREAM_UNAVAILABLE') : err;
    }
    const { res, settle } = sent;
    settle(); // толгой ирсэн — биеийг timeout-оор таслахгүй, харин хэмжээгээр хязгаарлана
    try {
      if (!res.body) throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.opts.maxStreamBytes) throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
    } catch (err) {
      await res.body?.cancel().catch(() => undefined);
      throw err;
    }
    const limiter = new SizeLimit(this.opts.maxStreamBytes);
    const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    source.on('error', (e) => limiter.destroy(e));
    // Клиент таслахад (limiter destroy) эх урсгалыг мөн хаана
    limiter.on('close', () => source.destroy());
    // Хэн ч сонсоогүй мөчид гарсан 'error' процессыг унагахаас сэргийлнэ (бодит хүлээн авагч pipeline-аар алдааг авна).
    limiter.on('error', () => undefined);
    const body = source.pipe(limiter);
    // Эхний chunk иртэл хүлээнэ: HTTP толгой явахаас өмнө алдаа (хоосон/хэт том/тасарсан) нь жирийн JSON алдаа болно.
    await this.firstChunk(body);
    return { headers: res.headers, stream: body };
  }

  private firstChunk(s: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (err?: PortalError) => {
        clearTimeout(timer);
        s.off('readable', onReadable);
        s.off('error', onError);
        if (err) {
          s.destroy();
          reject(err);
        } else resolve();
      };
      // 'readable' нь буфер хоосон байхад зөвхөн урсгалын төгсгөлд ирнэ → хоосон бие
      const onReadable = () => finish(s.readableLength > 0 ? undefined : new PortalError('DOWNSTREAM_INVALID_RESPONSE'));
      const onError = (e: Error) => finish(e instanceof PortalError ? e : new PortalError('DOWNSTREAM_UNAVAILABLE'));
      const timer = setTimeout(() => finish(new PortalError('DOWNSTREAM_UNAVAILABLE')), this.opts.timeoutMs);
      s.once('readable', onReadable);
      s.once('error', onError);
    });
  }

  private async jsonOnce<T>(req: JsonRequest<T>): Promise<T> {
    const { res, settle } = await this.send(req);
    try {
      const text = await readLimited(res, this.opts.maxJsonBytes ?? 5 * 1024 * 1024);
      const parsed = req.schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        this.logger.error({ msg: 'downstream contract mismatch', ...logFields(req), at: parsed.error.issues[0]?.path.join('.') });
        throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof PortalError) throw err;
      if ((err as Error).name === 'AbortError') throw new TransientError();
      throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
    } finally {
      settle();
    }
  }

  /** Хүсэлт илгээж, амжилттай (2xx) бол Response + timer цэвэрлэгч буцаана; бусад нь алдаа болгоно. */
  private async send(req: BaseRequest & { method: 'GET' | 'POST'; body?: unknown }): Promise<{ res: Response; settle: () => void }> {
    const url = new URL(req.path, this.opts.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const settle = () => clearTimeout(timer);

    const headers: Record<string, string> = {
      Accept: 'application/json, application/pdf',
      'X-Correlation-Id': req.ctx.correlationId,
      ...(req.ctx.customerId
        ? { 'X-Actor-Type': 'CUSTOMER', 'X-Customer-Id': req.ctx.customerId, 'X-Roles': 'CUSTOMER' }
        : { 'X-Actor-Type': 'PORTAL_ANONYMOUS' }),
      ...req.headers,
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      settle();
      this.logger.warn({ msg: 'downstream request failed', ...logFields(req), reason: (err as Error).name });
      throw new TransientError();
    }
    if (res.ok) return { res, settle };

    settle();
    const text = await res.text().catch(() => '');
    throw this.mapError(req, res.status, text);
  }

  private mapError(req: BaseRequest & { method: string }, status: number, text: string): Error {
    const where = { ...logFields(req), status };
    if (status === 404) {
      if (req.notFound) return new PortalError(req.notFound);
      this.logger.error({ msg: 'downstream unexpected 404', ...where });
      return new PortalError('DOWNSTREAM_INVALID_RESPONSE');
    }
    if (RETRYABLE_STATUS.has(status)) {
      this.logger.warn({ msg: 'downstream transient status', ...where });
      return new TransientError();
    }
    if (status === 400 || status === 409 || status === 422) {
      const code = businessCode(text);
      if (code && PASS_THROUGH_DOWNSTREAM_CODES.has(code)) return new PortalError(code);
      this.logger.error({ msg: 'downstream unmapped business error', ...where });
      return new PortalError('DOWNSTREAM_INVALID_RESPONSE');
    }
    // 401/403 = портал → origination итгэлцэл буруу тохируулагдсан; 429/500 = доголдол
    this.logger.error({ msg: 'downstream error status', ...where });
    return new PortalError('DOWNSTREAM_UNAVAILABLE');
  }
}

function businessCode(text: string): PortalErrorCode | null {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    return typeof code === 'string' ? (code as PortalErrorCode) : null;
  } catch {
    return null;
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
  return text;
}

class SizeLimit extends Transform {
  private seen = 0;
  constructor(private readonly max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void) {
    this.seen += chunk.length;
    if (this.seen > this.max) return cb(new PortalError('DOWNSTREAM_INVALID_RESPONSE'));
    cb(null, chunk);
  }
}

const logFields = (req: BaseRequest & { method?: string }) => ({ correlationId: req.ctx.correlationId, method: req.method, path: req.path });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** URL сегментэд аюулгүй оруулах. */
export const seg = encodeURIComponent;
