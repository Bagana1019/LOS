import { randomUUID } from 'node:crypto';
import type { CreateDocumentRequest, DocumentListQuery, DocumentView, RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { normalizeKey } from '../document-checklist';
import type { DmsDocumentOcr, DmsDocumentsPort, DmsOcrOutcome } from '../dms-documents.port';

// Тестийн dms: жинхэнэ dms-ийн дүрмүүдийг (`apps/dms/src/modules/document`) дагана — байгууллагаар тусгаарлалт, файлын оршихуй (422 FILE_NOT_FOUND),
// түлхүүр нормчлол, оруулсан цагаар өсөх жагсаалт, устгал идемпотент. `DMS_DOCUMENTS` токеныг override хийж ашиглана.

type Op = 'create' | 'list' | 'remove' | 'ocr';
interface StoredDocument { orgId: string; view: DocumentView }
export interface FakeFile { id: string; orgId: string; name: string; mime: string; size: number }

export class FakeDmsDocuments implements DmsDocumentsPort {
  readonly calls: { op: Op; ctx: RequestContext; arg: unknown }[] = [];
  /** `list` дуудлагын тоо (алхмын дахин тооцооллын "шинэ жагсаалт" шаардлагыг шалгахад) */
  listCalls = 0;
  /** `list` бүрийн ӨМНӨ ажиллана — хоёр дуудлагын хооронд зэрэг өөрчлөлт гарахыг дуурайна. `n` = дугаар (1-ээс). */
  beforeList?: (n: number) => void | Promise<void>;
  /** `create`-ийн дараа, буцахаас өмнө ажиллана — dms амжилттай бичиж, origination хариу авахаас өмнөх цаг. */
  afterCreate?: (doc: DocumentView) => void | Promise<void>;
  private readonly documents: StoredDocument[] = [];
  private readonly files = new Map<string, FakeFile>();
  private readonly failures = new Map<Op, Error[]>();
  private readonly ocrOutcomes = new Map<string, DmsOcrOutcome>();
  private clockMs = Date.UTC(2026, 9, 29, 1, 0, 0);

  /** Тест бүрийн өмнө бүх төлвийг цэвэрлэнэ (нэг instance-ийг модуль руу `useValue`-ээр өгсөн үед). */
  reset(): void {
    this.calls.length = 0;
    this.listCalls = 0;
    this.beforeList = undefined;
    this.afterCreate = undefined;
    this.documents.length = 0;
    this.files.clear();
    this.failures.clear();
    this.ocrOutcomes.clear();
  }

  /** `op` дуудлагуудын жагсаалт. */
  callsOf(op: Op): { op: Op; ctx: RequestContext; arg: unknown }[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Файлыг файл санд бүртгэнэ (жинхэнэ нь `POST /api/dms/files`). */
  addFile(orgId: string, o: Partial<Omit<FakeFile, 'id' | 'orgId'>> & { id?: string } = {}): string {
    const id = o.id ?? randomUUID();
    this.files.set(id, { id, orgId, name: o.name ?? 'scan.pdf', mime: o.mime ?? 'application/pdf', size: o.size ?? 1024 });
    return id;
  }

  /** Файлыг устгагдсан (purge) болгоно: дараагийн `create` 422 FILE_NOT_FOUND. */
  purgeFile(id: string): void {
    this.files.delete(id);
  }

  /** Дараагийн `op` дуудлагыг нэг удаа энэ алдаагаар унагаана (дараалалд хэд ч нэмж болно). */
  failNext(op: Op, error: Error): void {
    this.failures.set(op, [...(this.failures.get(op) ?? []), error]);
  }

  /** `documentId`-ийн OCR хариуг тохируулна. Тохируулаагүй бол "текст олдсонгүй" (mock fixture олдохгүйтэй адил). */
  setOcr(documentId: string, outcome: DmsOcrOutcome): void {
    this.ocrOutcomes.set(documentId, outcome);
  }

  /** dms дээр шууд (origination-гүйгээр) өөр эх сурвалжаас баримт орсон/устсаныг дуурайх. */
  async insertDirect(orgId: string, request: CreateDocumentRequest, uploadedBy: string | null = 'system'): Promise<DocumentView> {
    return this.store(orgId, request, uploadedBy);
  }

  removeDirect(orgId: string, documentId: string): boolean {
    const i = this.documents.findIndex((d) => d.orgId === orgId && d.view.id === documentId);
    if (i < 0) return false;
    this.documents.splice(i, 1);
    return true;
  }

  all(orgId?: string): DocumentView[] {
    return this.documents.filter((d) => !orgId || d.orgId === orgId).map((d) => ({ ...d.view }));
  }

  async create(request: CreateDocumentRequest, ctx: RequestContext): Promise<DocumentView> {
    this.record('create', ctx, request);
    this.maybeFail('create');
    const view = await this.store(ctx.orgId, request, ctx.userId);
    await this.afterCreate?.(view);
    return { ...view };
  }

  async list(query: DocumentListQuery, ctx: RequestContext): Promise<DocumentView[]> {
    this.record('list', ctx, query);
    this.listCalls++;
    await this.beforeList?.(this.listCalls);
    this.maybeFail('list');
    return this.documents
      .filter((d) => d.orgId === ctx.orgId && d.view.applicationId === query.applicationId)
      .filter((d) => !query.relatedEntity || d.view.relatedEntity === query.relatedEntity)
      .filter((d) => !query.relatedId || d.view.relatedId === query.relatedId)
      .map((d) => ({ ...d.view }));
  }

  async remove(documentId: string, ctx: RequestContext): Promise<boolean> {
    this.record('remove', ctx, documentId);
    this.maybeFail('remove');
    return this.removeDirect(ctx.orgId, documentId);
  }

  async ocr(documentId: string, ctx: RequestContext): Promise<DmsOcrOutcome> {
    this.record('ocr', ctx, documentId);
    this.maybeFail('ocr');
    if (!this.documents.some((d) => d.orgId === ctx.orgId && d.view.id === documentId)) throw new DomainError('DOCUMENT_NOT_FOUND', 'Баримт олдсонгүй', 404);
    return this.ocrOutcomes.get(documentId) ?? { readable: false, reason: 'NO_TEXT' };
  }

  private async store(orgId: string, request: CreateDocumentRequest, uploadedBy: string | null): Promise<DocumentView> {
    const file = this.files.get(request.fileId);
    if (!file || file.orgId !== orgId) throw new DomainError('FILE_NOT_FOUND', 'Файл олдсонгүй эсвэл устгагдсан байна', 422);
    const view: DocumentView = {
      id: randomUUID(), applicationId: request.applicationId, type: normalizeKey(request.type), relatedEntity: request.relatedEntity, relatedId: request.relatedId?.trim() || null,
      note: request.note ?? null, fileId: file.id, fileName: file.name, mime: file.mime, size: file.size,
      checklistKey: request.checklistKey === undefined ? null : normalizeKey(request.checklistKey), uploadedBy, uploadedAt: new Date((this.clockMs += 1000)).toISOString(),
    };
    this.documents.push({ orgId, view });
    return view;
  }

  private record(op: Op, ctx: RequestContext, arg: unknown): void {
    this.calls.push({ op, ctx, arg });
  }

  private maybeFail(op: Op): void {
    const queue = this.failures.get(op);
    const error = queue?.shift();
    if (error) throw error;
  }
}

/** `DmsDocumentOcr`-ийн "уншигдсан" хариуг бүтээнэ (ID карт: регистр + итгэл). */
export const readableOcr = (documentId: string, o: Partial<Omit<DmsDocumentOcr, 'documentId'>> = {}): DmsOcrOutcome => ({
  readable: true,
  ocr: { documentId, docType: 'ID_CARD', warnings: [], registerNo: 'УБ90000001', registerConfidence: 0.93, meanConfidence: 0.9, ...o },
});
