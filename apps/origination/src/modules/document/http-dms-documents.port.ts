import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import { DocumentListResponse, DocumentView, type CreateDocumentRequest, type DocumentListQuery, type RequestContext } from '@los/contracts';
import { DomainError, InternalHttpClient, UpstreamError, type CallOptions, type ServiceName } from '@los/nest-common';
import { DmsDocumentOcr, type DmsDocumentsPort, type DmsOcrOutcome, type DmsOcrUnreadableReason } from './dms-documents.port';

/** CLAUDE.md §3.1: дотоод sync дуудлагын timeout 3с. */
export const DMS_TIMEOUT_MS = 3_000;
/**
 * OCR нь урт ажил (бодит хөдөлгүүр хуудас бүрийг таниулдаг) тул дотоод 3с-ээр хүрэлцэхгүй. CLAUDE.md §3.1: гадаад интеграци дамжуулах дуудлага 15с — OCR хөдөлгүүр ижил зэрэглэл.
 * DEMO: бодит хөдөлгүүр (tesseract) сонгогдсоны дараа хэмжилтээр засна. Солих ганц газар.
 */
export const DMS_OCR_TIMEOUT_MS = 15_000;

/** Redirect дагахгүй: ctx толгой (X-Internal-Token) өөр хост руу алдагдахаас сэргийлнэ (InternalHttpClient-д fetchFn-ээр). */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

/**
 * `InternalHttpClient`-д DELETE байхгүй (get/post/put). Нэг хүсэлтийн механизмыг (толгой, timeout, алдааны хөрвүүлэлт) давхар бичихгүйн тулд
 * хаалттай `request`-ийг ашиглана. TODO: nest-common-д `delete()` нэмэгдвэл энэ дэд классыг устга.
 */
class DmsHttpClient extends InternalHttpClient {
  delete<T = unknown>(service: ServiceName, path: string, opts: CallOptions<T> = {}): Promise<T> {
    const send = this['request'] as unknown as (method: string, service: ServiceName, path: string, body: unknown, opts: CallOptions<T>) => Promise<T>;
    return send.call(this, 'DELETE', service, path, undefined, opts);
  }
}

/** `DMS_URL` (анхдагч http://localhost:4005) — `InternalHttpClient`-ийн serviceUrl-ээр. */
export function createDmsDocuments(env: NodeJS.ProcessEnv = process.env, timeoutMs: number = DMS_TIMEOUT_MS, ocrTimeoutMs: number = DMS_OCR_TIMEOUT_MS): HttpDmsDocuments {
  return new HttpDmsDocuments(new DmsHttpClient({ env, fetchFn: noRedirectFetch }), timeoutMs, ocrTimeoutMs);
}

const MSG = {
  fileNotFound: 'Файл олдсонгүй эсвэл устгагдсан байна',
  documentNotFound: 'Баримт олдсонгүй',
  ocrBusy: 'OCR түр завгүй байна, дахин оролдоно уу',
  badGateway: 'DMS үйлчилгээ хүсэлтийг биелүүлж чадсангүй',
} as const;

/** dms OCR-ийн 4xx `code` → "уншигдахгүй" шалтгаан (`OcrErrorFilter`, `DocumentService.extract`). Бусад 4xx нь алдаа. */
const UNREADABLE: Readonly<Record<string, DmsOcrUnreadableReason>> = {
  UNSUPPORTED_MIME: 'UNSUPPORTED_FILE',
  EMPTY_RESULT: 'NO_TEXT',
  NO_FIXTURE: 'NO_TEXT',
  OCR_FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_INPUT: 'INVALID_FILE',
};

type Run = (opts: { ctx: RequestContext; timeoutMs: number }) => Promise<unknown>;

/**
 * dms-ийн `/api/documents` клиент — `InternalHttpClient` (X-* толгой, 3с timeout, зөвхөн GET дахин оролдоно) дээр.
 * Хүсэлт/хариуны BODY-г (файлын нэр, тайлбар, OCR-ийн регистр) хэзээ ч логлохгүй; лог зөвхөн { op, status, correlationId }.
 * 4xx-ийг тогтвортой монгол мессежтэй болгож, бусад 4xx → 502; timeout/холбогдож чадаагүй/5xx нь `InternalHttpClient`-ийн UpstreamError (504/502).
 */
export class HttpDmsDocuments implements DmsDocumentsPort {
  private readonly logger = new Logger(HttpDmsDocuments.name);

  constructor(private readonly http: DmsHttpClient, private readonly timeoutMs: number = DMS_TIMEOUT_MS, private readonly ocrTimeoutMs: number = DMS_OCR_TIMEOUT_MS) {}

  create(request: CreateDocumentRequest, ctx: RequestContext): Promise<DocumentView> {
    return this.call('create', ctx, this.timeoutMs, DocumentView, (o) => this.http.post('dms', '/api/documents', request, o), { 404: () => fileNotFound() });
  }

  async list(query: DocumentListQuery, ctx: RequestContext): Promise<DocumentView[]> {
    const res = await this.call('list', ctx, this.timeoutMs, DocumentListResponse, (o) =>
      this.http.get('dms', '/api/documents', { ...o, query: { applicationId: query.applicationId, relatedEntity: query.relatedEntity, relatedId: query.relatedId } }));
    return res.items;
  }

  async remove(documentId: string, ctx: RequestContext): Promise<boolean> {
    try {
      await this.http.delete('dms', `/api/documents/${encodeURIComponent(documentId)}`, { ctx, timeoutMs: this.timeoutMs });
      return true;
    } catch (err) {
      if (err instanceof DomainError && err.getStatus() === 404) return false; // зэрэг устгал: аль хэдийн байхгүй
      throw this.translate('remove', ctx, err, {});
    }
  }

  async ocr(documentId: string, ctx: RequestContext): Promise<DmsOcrOutcome> {
    let json: unknown;
    try {
      json = await this.http.post('dms', `/api/documents/${encodeURIComponent(documentId)}/ocr`, {}, { ctx, timeoutMs: this.ocrTimeoutMs });
    } catch (err) {
      // Файл уншигдахгүй (төрөл, текстгүй, хэт том) нь алдаа биш — хүн шалгах "UNREADABLE" дүгнэлт
      const reason = err instanceof DomainError ? UNREADABLE[err.code] : undefined;
      if (reason) return { readable: false, reason };
      throw this.translate('ocr', ctx, err, { 404: () => new DomainError('DOCUMENT_NOT_FOUND', MSG.documentNotFound, 404), 429: () => new DomainError('OCR_BUSY', MSG.ocrBusy, 429) });
    }
    return { readable: true, ocr: this.parse('ocr', ctx, DmsDocumentOcr, json) };
  }

  /** @param on статус → алдаа (тогтвортой монгол мессежтэй) */
  private async call<T>(
    op: string, ctx: RequestContext, timeoutMs: number, schema: z.ZodType<T, z.ZodTypeDef, unknown>, run: Run, on: Partial<Record<number, () => Error>> = {},
  ): Promise<T> {
    let json: unknown;
    try {
      json = await run({ ctx, timeoutMs });
    } catch (err) {
      throw this.translate(op, ctx, err, on);
    }
    return this.parse(op, ctx, schema, json);
  }

  /** 5xx/timeout (UpstreamError) хэвээр; 4xx → `on`-д заасан эсвэл 502; бусад алдаа хэвээр. */
  private translate(op: string, ctx: RequestContext, err: unknown, on: Partial<Record<number, () => Error>>): unknown {
    if (err instanceof UpstreamError) return err;
    if (err instanceof DomainError) {
      const factory = on[err.getStatus()];
      return factory ? factory() : this.rejected(op, err.getStatus(), ctx);
    }
    return err;
  }

  private parse<T>(op: string, ctx: RequestContext, schema: z.ZodType<T, z.ZodTypeDef, unknown>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Утгыг биш зөвхөн талбарын замыг логлоно
      this.logger.warn({ op, reason: 'invalid response body', fields: parsed.error.issues.map((i) => i.path.join('.')), correlationId: ctx.correlationId });
      throw new DomainError('UPSTREAM_ERROR', MSG.badGateway, 502);
    }
    return parsed.data;
  }

  private rejected(op: string, status: number, ctx: RequestContext): Error {
    this.logger.warn({ op, status, correlationId: ctx.correlationId });
    return new DomainError('UPSTREAM_ERROR', MSG.badGateway, 502);
  }
}

/** FILE_NOT_FOUND нь хэрэглэгчийн оролт (устсан/буруу файл) тул 422 — хүсэлт (application) олдсонгүй 404-өөс ялгагдана. */
const fileNotFound = (): DomainError => new DomainError('FILE_NOT_FOUND', MSG.fileNotFound, 422);
