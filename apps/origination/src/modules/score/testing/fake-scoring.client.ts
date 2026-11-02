import { DomainError } from '@los/nest-common';
import type {
  CalcMethod, CalculationRecord, MarkCalculationStaleRequest, RequestContext, ScoreRequest, SelectMethodRequest, SoscoScoreRequest, SoscoScoreResponse, SoscoSummary, UnderwritePersistRequest, UnderwriteResult,
} from '@los/contracts';
import { scoringUnavailable, type ScoringClient } from '../scoring.client';
import { calculationRecord, soscoResponse, underwriteResult, type ResultOptions, type SoscoOptions } from './scoring-fixtures';

export type FakeOp = 'preview' | 'calculate' | 'latest' | 'select' | 'markStale' | 'scoreSosco' | 'latestSosco';
export interface FakeCall { op: FakeOp; args: unknown[]; ctx: RequestContext }

/**
 * `SCORING_CLIENT`-ийн fake: дуудлагыг бүртгэнэ, scoring-ийн төлөвийг (сүүлийн тооцоолол, оноо) санана, статик fixture буцаана.
 * Бодит scoring-тэй ижил дүрэм: сонголт хуучирсан бол 409 CALCULATION_STALE, хэрэглэгдэхгүй арга бол 422 METHOD_NOT_APPLICABLE, тооцоолол байхгүй бол 404.
 */
export class FakeScoringClient implements ScoringClient {
  readonly calls: FakeCall[] = [];
  readonly records = new Map<string, CalculationRecord>();
  readonly sosco = new Map<string, SoscoSummary>();
  /** `preview`/`calculate` үр дүнгийн тохиргоо (аль арга хэрэглэгдэх, автомат сонголт, LTV…) */
  result: ResultOptions = {};
  soscoOptions: SoscoOptions = {};
  /** Op-д дараагийн дуудлагад шидэх алдаа (нэг удаа) */
  private readonly failures = new Map<FakeOp, Error[]>();
  private seq = 0;
  private tick = 0;
  /** Бодит цагаас 1 цагийн өмнө эхэлнэ: origination-ий `updatedAt` (бодит цаг)-тай харьцуулахад тооцоолол үргэлж "өмнөх" */
  private readonly base = Date.now() - 3_600_000;

  failNext(op: FakeOp, error: Error = scoringUnavailable('UNREACHABLE')): this {
    this.failures.set(op, [...(this.failures.get(op) ?? []), error]);
    return this;
  }
  failAlways(op: FakeOp, error: Error = scoringUnavailable('UNREACHABLE')): this {
    this.failures.set(op, Array.from({ length: 50 }, () => error));
    return this;
  }
  callsOf(op: FakeOp): FakeCall[] { return this.calls.filter((c) => c.op === op); }
  reset(): void { this.calls.length = 0; this.records.clear(); this.sosco.clear(); this.failures.clear(); this.result = {}; this.soscoOptions = {}; this.seq = 0; this.tick = 0; }

  private enter(op: FakeOp, ctx: RequestContext, ...args: unknown[]): void {
    this.calls.push({ op, args, ctx });
    const next = this.failures.get(op)?.shift();
    if (next) throw next;
  }
  /** Зохиомол, өсөх цаг: тооцоолол бүр өмнөхөөс 1с хожуу */
  now(): string { return new Date(this.base + ++this.tick * 1000).toISOString(); }

  async preview(ctx: RequestContext, request: ScoreRequest): Promise<UnderwriteResult> {
    this.enter('preview', ctx, request);
    return underwriteResult(request, this.result);
  }

  async calculate(ctx: RequestContext, body: UnderwritePersistRequest): Promise<CalculationRecord> {
    this.enter('calculate', ctx, body);
    const at = this.now();
    const result = underwriteResult(body.request, this.result);
    const wanted = body.selectedMethod ?? null;
    if (wanted && !result.methods.find((m) => m.method === wanted)?.applicable) throw new DomainError('METHOD_NOT_APPLICABLE', 'Сонгосон арга хэрэглэгдэхгүй', 422);
    const record = calculationRecord(body.request, {
      ...this.result, id: `calc-${++this.seq}`, customerId: body.customerId, computedAt: at,
      selectedMethod: wanted ?? result.autoSelected, selection: wanted ? 'MANUAL' : result.autoSelected ? 'AUTO' : null, selectionReason: wanted ? (body.selectionReason ?? null) : null,
    });
    this.records.set(body.request.applicationId, record);
    return record;
  }

  async latest(ctx: RequestContext, applicationId: string): Promise<CalculationRecord | null> {
    this.enter('latest', ctx, applicationId);
    return this.records.get(applicationId) ?? null;
  }

  async select(ctx: RequestContext, applicationId: string, body: SelectMethodRequest): Promise<CalculationRecord> {
    this.enter('select', ctx, applicationId, body);
    const record = this.records.get(applicationId);
    if (!record) throw new DomainError('CALCULATION_NOT_FOUND', 'Тооцоолол олдсонгүй', 404);
    if (record.isStale) throw new DomainError('CALCULATION_STALE', 'Тооцоолол хуучирсан', 409);
    if (!record.result.methods.find((m) => m.method === body.method)?.applicable) throw new DomainError('METHOD_NOT_APPLICABLE', 'Сонгосон арга хэрэглэгдэхгүй', 422);
    const next: CalculationRecord = { ...record, selectedMethod: body.method as CalcMethod, selection: 'MANUAL', selectedBy: ctx.userId, selectedAt: this.now(), selectionReason: body.reason ?? null };
    this.records.set(applicationId, next);
    return next;
  }

  async markStale(ctx: RequestContext, applicationId: string, body: MarkCalculationStaleRequest): Promise<void> {
    this.enter('markStale', ctx, applicationId, body);
    const record = this.records.get(applicationId);
    if (record) this.records.set(applicationId, { ...record, isStale: true, staleReason: body.reason });
  }

  async scoreSosco(ctx: RequestContext, body: SoscoScoreRequest): Promise<SoscoScoreResponse> {
    this.enter('scoreSosco', ctx, body);
    const response = soscoResponse({ ...this.soscoOptions, computedAt: this.now() });
    if (body.persist && response.resultId) {
      const { modelId: _modelId, ...rest } = response;
      this.sosco.set(`${body.applicationId}:${body.customerId}`, { ...rest, customerId: body.customerId });
    }
    return response;
  }

  async latestSosco(ctx: RequestContext, applicationId: string, customerId: string): Promise<SoscoSummary | null> {
    this.enter('latestSosco', ctx, applicationId, customerId);
    return this.sosco.get(`${applicationId}:${customerId}`) ?? null;
  }
}
