import { Inject, Injectable } from '@nestjs/common';
import { DocumentView, type CreateDocumentRequest, type DocumentListQuery, type DocumentRelatedEntity, type RequestContext } from '@los/contracts';
import { buildEvent, enqueueOutbox } from '@los/database';
import { DomainError } from '@los/nest-common';
import { detectOcrMime, OcrError, type DocumentExtraction, type OcrDocType } from '@los/ocr';
import type { Document as DocumentRow, File as FileRow } from '.prisma/client-dms';
import { PrismaService } from '../../prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../file/storage';
import { OcrService } from '../ocr/ocr.service';
import { readOcrConfig } from '../ocr/ocr.config';
import { DOCUMENT_ID, isViolation, normalizeCreate, ocrDocTypeFor } from './document.rules';

type DocumentWithFile = DocumentRow & { file: FileRow };

/** `POST /api/documents/:id/ocr` хариу: OCR-ийн задлалт, ТЕКСТГҮЙ. Хадгалагдахгүй. */
export interface DocumentOcrExtraction {
  documentId: string;
  docType: OcrDocType;
  detectedDocType: DocumentExtraction['detectedDocType'];
  fields: DocumentExtraction['fields'];
  warnings: string[];
  ocr: { engine: string; meanConfidence: number; pageCount: number; durationMs: number };
}

const notFound = () => new DomainError('DOCUMENT_NOT_FOUND', 'Баримт олдсонгүй', 404);
const fileNotFound = () => new DomainError('FILE_NOT_FOUND', 'Файл олдсонгүй эсвэл устгагдсан байна', 404);

/** FR-9.1: `document` → `DocumentView`. Оруулсан ажилтан/огноо нь мөрийн `created_by`/`created_at` (автоматаар). */
export function toDocumentView(row: DocumentWithFile): DocumentView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    type: row.type,
    relatedEntity: row.relatedEntity as DocumentRelatedEntity,
    relatedId: row.relatedId,
    note: row.note,
    fileId: row.fileId,
    fileName: row.file.name,
    mime: row.file.mime,
    size: row.file.size,
    checklistKey: row.checklistKey,
    uploadedBy: row.createdBy,
    uploadedAt: row.createdAt.toISOString(),
  };
}

/**
 * Хүсэлтэд хавсаргасан баримт (FR-9.1). Зөвхөн origination (sync, `docs/05-collateral-documents.md` §3.2) дууддаг дотоод үйлчилгээ.
 * Хүсэлтийн хүрээ, төлөв, checklist-ийн шалгалт origination-д; энд байгууллага (org), файлын оршихуй, холбоосын бүрдэл.
 * Бүх уншилт `org_id`-аар хязгаарлагдана — өөр байгууллагын бичлэг 404 (оршихуйг задруулахгүй).
 */
@Injectable()
export class DocumentService {
  private readonly ocrMaxBytes = readOcrConfig(process.env).maxFileBytes;

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(OcrService) private readonly ocr: OcrService,
  ) {}

  /** Баримт үүсгээд `DocumentUploaded`-г ЯГ АДИЛ транзакцид outbox-д бичнэ (CLAUDE.md §3.2.4). */
  async create(ctx: RequestContext, input: CreateDocumentRequest): Promise<DocumentView> {
    const data = normalizeCreate(input);
    if (isViolation(data)) throw new DomainError(data.code, data.message, 422);
    return this.db.$transaction(async (tx) => {
      // purge хийгдсэн эсвэл өөр байгууллагын файл нь "байхгүй" файлтай адил — оршихуйг задруулахгүй
      const file = await tx.file.findFirst({ where: { id: data.fileId, orgId: ctx.orgId, purgedAt: null } });
      if (!file) throw fileNotFound();
      const row = await tx.document.create({
        data: {
          orgId: ctx.orgId, applicationId: data.applicationId, type: data.type, relatedEntity: data.relatedEntity, relatedId: data.relatedId,
          note: data.note, fileId: file.id, checklistKey: data.checklistKey, createdBy: ctx.userId, updatedBy: ctx.userId,
        },
        include: { file: true },
      });
      await enqueueOutbox(tx, buildEvent(ctx, 'DocumentUploaded', {
        documentId: row.id, applicationId: row.applicationId, kind: row.type, relatedEntity: data.relatedEntity, relatedId: row.relatedId, checklistKey: row.checklistKey, fileId: row.fileId,
      }));
      return toDocumentView(row);
    });
  }

  /** Хүсэлтийн баримтууд, оруулсан цагаар өсөхөөр (хуучин нь эхэнд), адил цагт `id`-аар. Устгагдсан (purge) файлтай баримт гарахгүй. */
  async list(ctx: RequestContext, query: DocumentListQuery): Promise<DocumentView[]> {
    const rows = await this.db.document.findMany({
      where: {
        orgId: ctx.orgId, applicationId: query.applicationId, file: { purgedAt: null },
        ...(query.relatedEntity ? { relatedEntity: query.relatedEntity } : {}),
        ...(query.relatedId ? { relatedId: query.relatedId } : {}),
      },
      include: { file: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDocumentView);
  }

  async get(ctx: RequestContext, id: string): Promise<DocumentView> {
    return toDocumentView(await this.find(ctx, id));
  }

  /** Баримтыг устгана (файл нь файл санд үлдэнэ — өөр баримтад ашиглагдаж болно, retention-ийг тусдаа job цэвэрлэнэ). `DocumentRemoved` ижил транзакцид. */
  async remove(ctx: RequestContext, id: string): Promise<void> {
    if (!DOCUMENT_ID.test(id)) throw notFound();
    await this.db.$transaction(async (tx) => {
      const row = await tx.document.findFirst({ where: { id, orgId: ctx.orgId } });
      if (!row) throw notFound();
      // зэрэг устгалтад нэг л хүсэлт event гаргана: deleteMany тоо 0 бол өөр хүсэлт аль хэдийн устгасан
      const { count } = await tx.document.deleteMany({ where: { id: row.id, orgId: ctx.orgId } });
      if (count === 0) throw notFound();
      await enqueueOutbox(tx, buildEvent(ctx, 'DocumentRemoved', {
        documentId: row.id, applicationId: row.applicationId, kind: row.type, relatedEntity: row.relatedEntity as DocumentRelatedEntity, relatedId: row.relatedId, checklistKey: row.checklistKey,
      }));
    });
  }

  /**
   * Хадгалсан файлыг OCR-д өгч задлалтыг (текстгүй) буцаана. Төрөл: checklist `id_card` → ID_CARD, `salary_statement` → SALARY_CERTIFICATE, бусад GENERIC.
   * Юуг ч хадгалахгүй; баримтын агуулга, нэр, талбарыг логлохгүй (`OcrService` зөвхөн хэмжээ/тоо логлоно). OcrError нь `OcrErrorFilter`-ээр HTTP болно.
   */
  async extract(ctx: RequestContext, id: string): Promise<DocumentOcrExtraction> {
    const doc = await this.find(ctx, id);
    if (doc.file.size > this.ocrMaxBytes) throw new DomainError('OCR_FILE_TOO_LARGE', 'Файл OCR-д хэт том байна', 413);
    const content = await this.read(doc.file);
    const mimeType = detectOcrMime(content);
    if (!mimeType) throw new OcrError('UNSUPPORTED_MIME', 'magic bytes таарсангүй');
    const result = await this.ocr.extract({ content, mimeType, fileName: doc.file.name, docType: ocrDocTypeFor(doc.checklistKey), includeText: false, correlationId: ctx.correlationId });
    // `includeText: false` ч текст хариунд хэзээ ч орохгүйг бүтцээр баталгаажуулна
    const { engine, meanConfidence, pageCount, durationMs } = result.ocr;
    return { documentId: doc.id, docType: result.docType, detectedDocType: result.detectedDocType, fields: result.fields, warnings: result.warnings, ocr: { engine, meanConfidence, pageCount, durationMs } };
  }

  private async find(ctx: RequestContext, id: string): Promise<DocumentWithFile> {
    const row = DOCUMENT_ID.test(id) ? await this.db.document.findFirst({ where: { id, orgId: ctx.orgId, file: { purgedAt: null } }, include: { file: true } }) : null;
    if (!row) throw notFound();
    return row;
  }

  /** Объект хадгалалтаас файлыг уншина; `ocrMaxBytes`-аас хэтэрвэл таслана. Хадгалалтын алдаа 502 (дотоод мэдээлэл задруулахгүй). */
  private async read(file: Pick<FileRow, 'storageKey'>): Promise<Buffer> {
    try {
      const stream = await this.storage.get(file.storageKey);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += part.length;
        if (total > this.ocrMaxBytes) throw new DomainError('OCR_FILE_TOO_LARGE', 'Файл OCR-д хэт том байна', 413);
        chunks.push(part);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError('FILE_CONTENT_UNAVAILABLE', 'Файлын агуулгыг уншиж чадсангүй', 502);
    }
  }
}
