import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import {
  CalculationRecord, SCORING_ERROR_CODES, SoscoScoreResponse, SoscoSummary, UnderwriteResult,
  type MarkCalculationStaleRequest, type RequestContext, type ScoreRequest, type SelectMethodRequest, type SoscoScoreRequest, type UnderwritePersistRequest,
} from '@los/contracts';
import { DomainError, InternalHttpClient, UpstreamError } from '@los/nest-common';

/**
 * origination → scoring (sync REST, CLAUDE.md §3.2.2). Хэрэглэгч хариуг хүлээж байгаа тул sync; тестэд `SCORING_CLIENT` token-оор солигдоно.
 * Алдаа: scoring унасан/удаан/гэрээнд нийцээгүй → `SCORING_UNAVAILABLE` (503); scoring-ийн өөрийн домэйн алдаа (409/422, мэдэгдэх код) өөрчлөгдөхгүй дамжина.
 */
export interface ScoringClient {
  /** FR-8.3: хадгалахгүй, event-гүй (slider) */
  preview(ctx: RequestContext, request: ScoreRequest): Promise<UnderwriteResult>;
  /** FR-8.1/8.2: шинэ `calculation` мөр, автомат (эсвэл өгсөн) арга сонгоно */
  calculate(ctx: RequestContext, request: UnderwritePersistRequest): Promise<CalculationRecord>;
  /** Сүүлийн тооцоолол; байхгүй бол `null` */
  latest(ctx: RequestContext, applicationId: string): Promise<CalculationRecord | null>;
  /** FR-8.2: гараар арга сонгох. 409 CALCULATION_STALE, 422 METHOD_NOT_APPLICABLE */
  select(ctx: RequestContext, applicationId: string, request: SelectMethodRequest): Promise<CalculationRecord>;
  /** FR-7.3: сүүлийн тооцоолол хуучирсан. Идемпотент; тооцоолол байхгүй бол юу ч хийхгүй */
  markStale(ctx: RequestContext, applicationId: string, request: MarkCalculationStaleRequest): Promise<void>;
  /** Sosco Score тооцоолж (persist=true бол хадгалж) буцаана */
  scoreSosco(ctx: RequestContext, request: SoscoScoreRequest): Promise<SoscoScoreResponse>;
  /** Үндсэн зээлдэгчийн сүүлийн Sosco оноо; байхгүй бол `null` */
  latestSosco(ctx: RequestContext, applicationId: string, customerId: string): Promise<SoscoSummary | null>;
}
export const SCORING_CLIENT = Symbol('SCORING_CLIENT');

/** CLAUDE.md §3.1: дотоод sync дуудлагын timeout 3с. */
export const SCORING_TIMEOUT_MS = 3_000;
export const SCORING_UNAVAILABLE_MESSAGE = 'Тооцооллын үйлчилгээ түр ажиллахгүй байна. Түр хүлээгээд дахин оролдоно уу';

export type UnavailableReason = 'TIMEOUT' | 'UNREACHABLE' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE' | 'REJECTED';
export const scoringUnavailable = (reason: UnavailableReason): DomainError => new DomainError('SCORING_UNAVAILABLE', SCORING_UNAVAILABLE_MESSAGE, 503, { reason });

/** scoring-ийн өөрийн домэйн алдааны кодууд (SCORING_UNAVAILABLE-ийг оролцуулахгүй — тэр нь origination-ий өөрийн код) */
const PASS_THROUGH_CODES: ReadonlySet<string> = new Set(SCORING_ERROR_CODES.filter((c) => c !== 'SCORING_UNAVAILABLE'));

/** Redirect дагахгүй: ctx толгой (X-Internal-Token) өөр хост руу алдагдахаас сэргийлнэ. */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

/** `SCORING_URL` (анхдагч http://localhost:4003). */
export function createScoringClient(env: NodeJS.ProcessEnv = process.env, timeoutMs: number = SCORING_TIMEOUT_MS): HttpScoringClient {
  return new HttpScoringClient(new InternalHttpClient({ env, fetchFn: noRedirectFetch }), timeoutMs);
}

type Run = (opts: { ctx: RequestContext; timeoutMs: number }) => Promise<unknown>;

/**
 * `InternalHttpClient` (X-* толгой, correlationId, 3с timeout) дээр. POST/PUT-ыг ХЭЗЭЭ Ч автоматаар дахин оролдохгүй (давхар тооцоолол үүсэхээс сэргийлнэ);
 * зөвхөн idempotent GET нэг удаа дахин оролдогдоно. Хүсэлт/хариуны BODY-г логлохгүй (орлого, зээлдэгчийн мэдээлэл); зөвхөн op, статус, код.
 * Хариу бүрийг `@los/contracts`-ийн zod-оор шалгана.
 */
export class HttpScoringClient implements ScoringClient {
  private readonly logger = new Logger(HttpScoringClient.name);

  constructor(private readonly http: InternalHttpClient, private readonly timeoutMs: number = SCORING_TIMEOUT_MS) {}

  preview(ctx: RequestContext, request: ScoreRequest): Promise<UnderwriteResult> {
    return this.call('preview', ctx, UnderwriteResult, (o) => this.http.post('scoring', '/api/underwrite/preview', request, o));
  }

  calculate(ctx: RequestContext, request: UnderwritePersistRequest): Promise<CalculationRecord> {
    return this.call('calculate', ctx, CalculationRecord, (o) => this.http.post('scoring', '/api/underwrite', request, o));
  }

  async latest(ctx: RequestContext, applicationId: string): Promise<CalculationRecord | null> {
    try {
      return await this.call('latest', ctx, CalculationRecord, (o) => this.http.get('scoring', `/api/underwrite/applications/${encodeURIComponent(applicationId)}/latest`, o));
    } catch (e) {
      if (e instanceof DomainError && e.code === 'CALCULATION_NOT_FOUND') return null;
      throw e;
    }
  }

  async select(ctx: RequestContext, applicationId: string, request: SelectMethodRequest): Promise<CalculationRecord> {
    const body = await this.raw('select', ctx, (o) => this.http.put('scoring', `/api/underwrite/applications/${encodeURIComponent(applicationId)}/selection`, request, o));
    const parsed = CalculationRecord.safeParse(body);
    if (parsed.success) return parsed.data;
    // Гэрээ `PUT selection`-ий хариуг тодорхой заагаагүй: бүтэн CalculationRecord биш (жишээ нь 204) бол сонголт хийгдсэний дараах сүүлийн мөрийг уншина.
    const latest = await this.latest(ctx, applicationId);
    if (!latest) throw scoringUnavailable('INVALID_RESPONSE');
    return latest;
  }

  async markStale(ctx: RequestContext, applicationId: string, request: MarkCalculationStaleRequest): Promise<void> {
    try {
      await this.raw('markStale', ctx, (o) => this.http.post('scoring', `/api/underwrite/applications/${encodeURIComponent(applicationId)}/stale`, request, o));
    } catch (e) {
      if (e instanceof DomainError && e.code === 'CALCULATION_NOT_FOUND') return; // хуучруулах тооцоолол байхгүй — зорилго биелсэн
      throw e;
    }
  }

  scoreSosco(ctx: RequestContext, request: SoscoScoreRequest): Promise<SoscoScoreResponse> {
    return this.call('scoreSosco', ctx, SoscoScoreResponse, (o) => this.http.post('scoring', '/api/sosco/score', request, o));
  }

  async latestSosco(ctx: RequestContext, applicationId: string, customerId: string): Promise<SoscoSummary | null> {
    // 404 = оноо хараахан байхгүй (scoring-ийн код тодорхойгүй тул статусаар таньна)
    const body = await this.raw('latestSosco', ctx, (o) => this.http.get('scoring', '/api/sosco/results/latest', { ...o, query: { applicationId, customerId } }), { notFound: 'undefined' });
    if (body === undefined || body === null || body === '') return null;
    // scoring `SoscoSummary` (customerId-тай) эсвэл `SoscoScoreResponse` (customerId-гүй, modelId-тай) хэлбэрийн аль нэгээр хариулж болно — хоёуланг нь хүлээн авна.
    const summary = SoscoSummary.safeParse(body);
    if (summary.success) return summary.data;
    const response = SoscoScoreResponse.safeParse(body);
    if (response.success) {
      const { modelId: _modelId, ...rest } = response.data;
      return { ...rest, customerId };
    }
    this.logInvalid('latestSosco', ctx, summary.error);
    throw scoringUnavailable('INVALID_RESPONSE');
  }

  /** Хариуг zod-оор шалгана. */
  private async call<T>(op: string, ctx: RequestContext, schema: z.ZodType<T, z.ZodTypeDef, unknown>, run: Run): Promise<T> {
    const json = await this.raw(op, ctx, run);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      this.logInvalid(op, ctx, parsed.error);
      throw scoringUnavailable('INVALID_RESPONSE');
    }
    return parsed.data;
  }

  /** Шалгаагүй хариу + алдааны хөрвүүлэлт. */
  private async raw(op: string, ctx: RequestContext, run: Run, opts: { notFound?: 'undefined' } = {}): Promise<unknown> {
    try {
      return await run({ ctx, timeoutMs: this.timeoutMs });
    } catch (err) {
      if (opts.notFound && err instanceof DomainError && !(err instanceof UpstreamError) && err.getStatus() === 404) return undefined;
      throw this.mapError(op, err, ctx);
    }
  }

  private mapError(op: string, err: unknown, ctx: RequestContext): unknown {
    if (err instanceof UpstreamError) {
      // UpstreamError нь DomainError-ийн дэд анги тул түрүүлж шалгана
      const reason: UnavailableReason = err.upstreamStatus === null ? (err.code === 'UPSTREAM_TIMEOUT' ? 'TIMEOUT' : 'UNREACHABLE') : 'UPSTREAM_ERROR';
      this.logger.warn({ msg: 'scoring unavailable', op, reason, upstreamStatus: err.upstreamStatus, correlationId: ctx.correlationId });
      return scoringUnavailable(reason);
    }
    if (err instanceof DomainError) {
      const status = err.getStatus();
      // Домэйн алдаа: мэдэгдэх код, эсвэл 409/422 (бизнесийн зөрчил) — өөрчлөхгүй дамжуулна.
      if (PASS_THROUGH_CODES.has(err.code) || status === 409 || status === 422) return err;
      // 400/401/403/бусад 404: гэрээ/тохиргооны алдаа (буруу дотоод токен гэх мэт). 401/403-ыг хэрэглэгч рүү дамжуулбал web сесс дууссан гэж ойлгоод гаргах тул 503 болгоно.
      this.logger.warn({ msg: 'scoring rejected the request', op, status, code: err.code, correlationId: ctx.correlationId });
      return scoringUnavailable('REJECTED');
    }
    return err;
  }

  private logInvalid(op: string, ctx: RequestContext, error: z.ZodError): void {
    // Утгыг биш зөвхөн талбарын замыг логлоно
    this.logger.warn({ msg: 'scoring response violates the contract', op, fields: error.issues.map((i) => i.path.join('.')), correlationId: ctx.correlationId });
  }
}
