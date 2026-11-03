// origination → scoring (BSA) sync REST (CLAUDE.md §3.2.2). INT-1 (шинжилгээ үүсгэх), INT-4 (finalize + нэгтгэл), INT-6 (төлбөр шинэчлэх), INT-9 (PDF).
// Алдаа: scoring унасан/удаан → 503 BSA_UNAVAILABLE; scoring-ийн бизнесийн алдаа (404/409/422 …) кодтойгоо дамжина; 401/403 → 503 (сесс дууссан гэж ташаа ойлгуулахгүй).
// Хүсэлт/хариуны BODY-г логлохгүй (регистр, данс орно).
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  BsaCombinedSummary, BsaFinalizeResponse, BsaSummary,
  type BsaCreateAnalysisRequest, type BsaRecalculateRequest, type RequestContext,
} from '@los/contracts';
import { DomainError, InternalHttpClient, UpstreamError } from '@los/nest-common';

export const BSA_SCORING_CLIENT = Symbol('BSA_SCORING_CLIENT');
/** BSA импорт/PDF бодлого удаан байж болох тул underwrite-ийн 3с-ээс урт (дотоод, CLAUDE.md §3.1-ийн 3с нь энгийн дуудлагад) */
export const BSA_TIMEOUT_MS = 10_000;

/** scoring `AnalysisView`-ийн origination-д хэрэгтэй хэсэг (бусад талбар хаягдана) */
export const BsaAnalysisRef = z.object({
  id: z.string(),
  applicationId: z.string().optional(),
  loanApplicationId: z.string().optional(),
  customerId: z.string(),
  borrowerId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'ANALYZED']),
  version: z.number().int(),
  proposedMonthlyPayment: z.number().nullable().optional(),
  summary: BsaSummary.nullable().optional(),
});
export type BsaAnalysisRef = z.infer<typeof BsaAnalysisRef>;
const AnalysisPage = z.object({ items: z.array(BsaAnalysisRef) }).passthrough();

export interface FinalizeOutcome {
  summary: BsaFinalizeResponse['summary'];
  warnings: BsaFinalizeResponse['warnings'];
}

export interface BsaScoringClient {
  /** Хүсэлтийн бүх шинжилгээ (зээлдэгч бүрийн бүх хувилбар) */
  listAnalyses(ctx: RequestContext, applicationId: string): Promise<BsaAnalysisRef[]>;
  createAnalysis(ctx: RequestContext, request: BsaCreateAnalysisRequest): Promise<BsaAnalysisRef>;
  /** INT-6: санал болгосон төлбөр өөрчлөгдөхөд DTI дахин */
  recalculate(ctx: RequestContext, analysisId: string, request: BsaRecalculateRequest): Promise<void>;
  /** INT-4: «Системрүү татах» — ANALYZED болгож хураангуйг буцаана. 422 PENDING_SUSPICIOUS_BLOCK / NO_COMPLETED_IMPORT, 409 JOBS_IN_PROGRESS */
  finalize(ctx: RequestContext, analysisId: string): Promise<FinalizeOutcome>;
  /** BSA-BR-9 */
  combined(ctx: RequestContext, applicationId: string): Promise<BsaCombinedSummary>;
  /** INT-9: PDF тайлан */
  reportPdf(ctx: RequestContext, analysisId: string): Promise<Buffer>;
}

export const bsaUnavailable = (reason: string): DomainError =>
  new DomainError('BSA_UNAVAILABLE', 'Банкны хуулгын шинжилгээний үйлчилгээ түр ажиллахгүй байна. Түр хүлээгээд дахин оролдоно уу', 503, { reason });

export function createBsaScoringClient(env: NodeJS.ProcessEnv = process.env): HttpBsaScoringClient {
  return new HttpBsaScoringClient(new InternalHttpClient({ env, fetchFn: (input, init) => fetch(input, { ...init, redirect: 'error' }) }));
}

export class HttpBsaScoringClient implements BsaScoringClient {
  private readonly logger = new Logger(HttpBsaScoringClient.name);

  constructor(private readonly http: InternalHttpClient, private readonly timeoutMs: number = BSA_TIMEOUT_MS) {}

  async listAnalyses(ctx: RequestContext, applicationId: string): Promise<BsaAnalysisRef[]> {
    const body = await this.run('listAnalyses', ctx, (o) => this.http.get('scoring', '/api/bsa/analyses', { ...o, query: { applicationId, pageSize: 200 } }));
    const parsed = AnalysisPage.safeParse(body);
    if (!parsed.success) throw this.invalid('listAnalyses', ctx, parsed.error);
    return parsed.data.items;
  }

  async createAnalysis(ctx: RequestContext, request: BsaCreateAnalysisRequest): Promise<BsaAnalysisRef> {
    const body = await this.run('createAnalysis', ctx, (o) => this.http.post('scoring', '/api/bsa/analyses', request, o));
    const parsed = BsaAnalysisRef.safeParse(body);
    if (!parsed.success) throw this.invalid('createAnalysis', ctx, parsed.error);
    return parsed.data;
  }

  async recalculate(ctx: RequestContext, analysisId: string, request: BsaRecalculateRequest): Promise<void> {
    await this.run('recalculate', ctx, (o) => this.http.post('scoring', `/api/bsa/analyses/${encodeURIComponent(analysisId)}/recalculate`, request, o));
  }

  async finalize(ctx: RequestContext, analysisId: string): Promise<FinalizeOutcome> {
    const body = await this.run('finalize', ctx, (o) => this.http.post('scoring', `/api/bsa/analyses/${encodeURIComponent(analysisId)}/finalize`, {}, o));
    const parsed = BsaFinalizeResponse.safeParse(body);
    if (!parsed.success) throw this.invalid('finalize', ctx, parsed.error);
    return { summary: parsed.data.summary, warnings: parsed.data.warnings };
  }

  async combined(ctx: RequestContext, applicationId: string): Promise<BsaCombinedSummary> {
    const body = await this.run('combined', ctx, (o) => this.http.get('scoring', `/api/bsa/applications/${encodeURIComponent(applicationId)}/combined`, o));
    const parsed = BsaCombinedSummary.safeParse(body);
    if (!parsed.success) throw this.invalid('combined', ctx, parsed.error);
    return parsed.data;
  }

  reportPdf(ctx: RequestContext, analysisId: string): Promise<Buffer> {
    return this.run('reportPdf', ctx, (o) => this.http.get<Buffer>('scoring', `/api/bsa/analyses/${encodeURIComponent(analysisId)}/report.pdf`, { ...o, responseType: 'buffer' }));
  }

  private async run<T>(op: string, ctx: RequestContext, fn: (o: { ctx: RequestContext; timeoutMs: number }) => Promise<T>): Promise<T> {
    try {
      return await fn({ ctx, timeoutMs: this.timeoutMs });
    } catch (err) {
      if (err instanceof UpstreamError) {
        this.logger.warn({ msg: 'scoring (bsa) unavailable', op, upstreamStatus: err.upstreamStatus, correlationId: ctx.correlationId });
        throw bsaUnavailable(err.upstreamStatus === null ? 'UNREACHABLE' : 'UPSTREAM_ERROR');
      }
      if (err instanceof DomainError) {
        const status = err.getStatus();
        if (status === 401 || status === 403 || status === 400) {
          this.logger.warn({ msg: 'scoring (bsa) rejected the request', op, status, code: err.code, correlationId: ctx.correlationId });
          throw bsaUnavailable('REJECTED');
        }
        throw err;
      }
      throw err;
    }
  }

  private invalid(op: string, ctx: RequestContext, error: z.ZodError): DomainError {
    this.logger.warn({ msg: 'scoring (bsa) response violates the contract', op, fields: error.issues.map((i) => i.path.join('.')), correlationId: ctx.correlationId });
    return bsaUnavailable('INVALID_RESPONSE');
  }
}
