import { Inject, Injectable } from '@nestjs/common';
import { COLLATERAL_OTHER_DOC_KEY, type AssetType, type AttachCollateralDocumentRequest, type CollateralMutationResponse, type RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { auditSnapshot } from './collateral-data';
import { resolveChecklist } from './collateral-gate';
import { toGateProduct } from './collateral-gate.service';
import { CollateralTxService, TX_OPTIONS } from './collateral-tx.service';
import { MAX_DOCUMENTS_PER_COLLATERAL, RULE_EDITABLE } from './collateral.constants';
import { FILE_PORT, type FilePort } from './ports/file.port';

/**
 * Модуль 6 · барьцааны баримт (FR-6.2, FR-6.7). Checklist = `product.collateral_checklist_json[assetType]` + `other` (нэмэлт баримт, зураг).
 * dms-ийн файлыг FilePort-оор шалгаж, нэр/төрөл/хэмжээг мөрөнд хуулна (жагсаалтад dms дуудахгүй). Баримт нэмэх/хасах бүр G0-г дахин тооцно.
 * (Хүсэлтийн баримт — docs/05 §3.2, `modules/document` — тусдаа.)
 */
@Injectable()
export class CollateralDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly tx: CollateralTxService,
    @Inject(FILE_PORT) private readonly files: FilePort,
  ) {}

  async attach(ctx: RequestContext, applicationId: string, collateralId: string, input: AttachCollateralDocumentRequest): Promise<CollateralMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_EDITABLE);
    const row = await this.tx.row(this.prisma, app.id, collateralId);
    const product = app.productId ? await this.prisma.product.findFirst({ where: { id: app.productId, orgId: app.orgId } }) : null;
    const allowed = new Set([...resolveChecklist(toGateProduct(product)?.collateralChecklist, row.assetType as AssetType).map((r) => r.key), COLLATERAL_OTHER_DOC_KEY]);
    if (!allowed.has(input.checklistKey)) {
      throw new DomainError('UNKNOWN_CHECKLIST_KEY', `"${input.checklistKey}" нь энэ хөрөнгийн баримтын checklist-д байхгүй. Зөвшөөрөгдсөн: ${[...allowed].join(', ')}`, 422, { allowed: [...allowed] });
    }
    const file = await this.files.getMeta(ctx, input.fileId);
    if (!file) throw new DomainError('FILE_NOT_FOUND', 'Файл олдсонгүй. Эхлээд файлыг байршуулна уу', 422);

    return this.prisma.$transaction(async (db) => {
      const lockedApp = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      const fresh = await this.tx.row(db, lockedApp.id, collateralId);
      if (fresh.documents.some((d) => d.checklistKey === input.checklistKey && d.fileId === input.fileId)) throw new DomainError('COLLATERAL_DOCUMENT_DUPLICATE', 'Энэ файл энэ баримтын төрөлд аль хэдийн хавсаргагдсан байна', 409);
      if (fresh.documents.length >= MAX_DOCUMENTS_PER_COLLATERAL) throw new DomainError('DOCUMENT_LIMIT_EXCEEDED', `Нэг барьцаанд дээд тал нь ${MAX_DOCUMENTS_PER_COLLATERAL} баримт хавсаргана`, 409, { limit: MAX_DOCUMENTS_PER_COLLATERAL });
      const doc = await db.collateralDocument.create({
        data: {
          orgId: lockedApp.orgId, collateralId: fresh.id, checklistKey: input.checklistKey, fileId: input.fileId, fileName: file.name, mime: file.mime, size: file.size,
          note: input.note ?? null, uploadedBy: ctx.userId, createdBy: ctx.userId, updatedBy: ctx.userId,
        },
      });
      const snap = await this.tx.finish(db, ctx, lockedApp, {
        collateralId: fresh.id, assetType: fresh.assetType, change: 'DOCUMENT_CHANGED', action: 'COLLATERAL_DOCUMENT_ATTACHED', before: auditSnapshot(fresh),
        after: { documentId: doc.id, checklistKey: doc.checklistKey, fileId: doc.fileId }, updateSteps: true,
      });
      return this.tx.mutation(snap, fresh.id);
    }, TX_OPTIONS);
  }

  async remove(ctx: RequestContext, applicationId: string, collateralId: string, documentId: string): Promise<CollateralMutationResponse> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_EDITABLE);
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      const row = await this.tx.row(db, app.id, collateralId);
      const doc = row.documents.find((d) => d.id === documentId);
      if (!doc) throw new DomainError('COLLATERAL_DOCUMENT_NOT_FOUND', 'Баримт олдсонгүй', 404);
      await db.collateralDocument.delete({ where: { id: doc.id } });
      const snap = await this.tx.finish(db, ctx, app, {
        collateralId: row.id, assetType: row.assetType, change: 'DOCUMENT_CHANGED', action: 'COLLATERAL_DOCUMENT_REMOVED', before: { documentId: doc.id, checklistKey: doc.checklistKey, fileId: doc.fileId }, updateSteps: true,
      });
      return this.tx.mutation(snap, row.id);
    }, TX_OPTIONS);
  }
}
