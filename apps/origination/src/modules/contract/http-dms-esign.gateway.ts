import { BadGatewayException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { SigningRequestView, type CreateSigningRequest, type RequestContext } from '@los/contracts';
import { DomainError, InternalHttpClient, UpstreamError } from '@los/nest-common';
import { IssuedSigningRequest, type EsignGateway } from './esign.gateway';

/** CLAUDE.md §3.1: дотоод sync дуудлагын timeout 3с. */
export const DMS_TIMEOUT_MS = 3_000;

/** Redirect дагахгүй: ctx толгой (X-Internal-Token) өөр хост руу алдагдахаас сэргийлнэ (InternalHttpClient-д fetchFn-ээр). */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

/** `DMS_URL` (анхдагч http://localhost:4005) — `InternalHttpClient`-ийн serviceUrl-ээр. */
export function createDmsEsignGateway(env: NodeJS.ProcessEnv = process.env, timeoutMs: number = DMS_TIMEOUT_MS): HttpDmsEsignGateway {
  return new HttpDmsEsignGateway(new InternalHttpClient({ env, fetchFn: noRedirectFetch }), timeoutMs);
}

const MSG = {
  notFound: 'Цахим гарын үсгийн хүсэлт олдсонгүй',
  conflict: 'Идэвхтэй цахим гарын үсгийн хүсэлт байгаа эсвэл хүсэлтийн төлөв энэ үйлдэлд тохирохгүй байна',
  badGateway: 'DMS үйлчилгээ хүсэлтийг биелүүлж чадсангүй',
} as const;

/**
 * dms-ийн `/api/esign/requests` клиент — `InternalHttpClient` (X-* толгой, 3с timeout, POST дахин оролдохгүй) дээр.
 * Хүсэлт/хариуны BODY-г хэзээ ч логлохгүй (регистр, утас, нэг удаагийн линк агуулна). 404/409 нь монгол мессежтэй, бусад 4xx → 502;
 * timeout/холбогдож чадаагүй/5xx нь `InternalHttpClient`-ийн UpstreamError (504/502).
 */
export class HttpDmsEsignGateway implements EsignGateway {
  private readonly logger = new Logger(HttpDmsEsignGateway.name);

  constructor(private readonly http: InternalHttpClient, private readonly timeoutMs: number = DMS_TIMEOUT_MS) {}

  createRequest(input: CreateSigningRequest, ctx: RequestContext): Promise<IssuedSigningRequest> {
    return this.call('createRequest', ctx, IssuedSigningRequest, (o) => this.http.post('dms', '/api/esign/requests', input, o));
  }

  resend(signingRequestId: string, ctx: RequestContext): Promise<IssuedSigningRequest> {
    return this.call('resend', ctx, IssuedSigningRequest, (o) => this.http.post('dms', `/api/esign/requests/${encodeURIComponent(signingRequestId)}/resend`, {}, o));
  }

  cancel(signingRequestId: string, ctx: RequestContext): Promise<SigningRequestView> {
    return this.call('cancel', ctx, SigningRequestView, (o) => this.http.post('dms', `/api/esign/requests/${encodeURIComponent(signingRequestId)}/cancel`, {}, o));
  }

  get(signingRequestId: string, ctx: RequestContext): Promise<SigningRequestView> {
    return this.call('get', ctx, SigningRequestView, (o) => this.http.get('dms', `/api/esign/requests/${encodeURIComponent(signingRequestId)}`, o));
  }

  private async call<T>(op: string, ctx: RequestContext, schema: z.ZodType<T, z.ZodTypeDef, unknown>, run: (opts: { ctx: RequestContext; timeoutMs: number }) => Promise<unknown>): Promise<T> {
    let json: unknown;
    try {
      json = await run({ ctx, timeoutMs: this.timeoutMs });
    } catch (err) {
      // 4xx-ийг (InternalHttpClient: DomainError) тогтвортой мессежтэй болгоно; 5xx/timeout нь UpstreamError хэвээр
      if (err instanceof UpstreamError) throw err;
      if (err instanceof DomainError) throw this.statusError(op, err.getStatus(), ctx);
      throw err;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Утгыг биш зөвхөн талбарын замыг логлоно
      this.logger.warn({ op, reason: 'invalid response body', fields: parsed.error.issues.map((i) => i.path.join('.')), correlationId: ctx.correlationId });
      throw new BadGatewayException(MSG.badGateway);
    }
    return parsed.data;
  }

  private statusError(op: string, status: number, ctx: RequestContext): Error {
    if (status === 404) return new NotFoundException(MSG.notFound);
    if (status === 409) return new ConflictException(MSG.conflict);
    this.logger.warn({ op, status, correlationId: ctx.correlationId });
    return new BadGatewayException(MSG.badGateway);
  }
}
