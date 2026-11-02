import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ApplicationDocumentMutationResponse, ApplicationDocumentsResponse, AttachDocumentRequest, CreateDocumentRequest, DocumentOcrCheck, DocumentView, RequestContext,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, conflict, DomainError } from '@los/nest-common';
import type { LoanApplication, Product } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { isEditableStatus } from '../borrower/borrower.rules';
import { CustomerDirectory, customerRegisterNo } from '../borrower/customer-directory';
import { DMS_DOCUMENTS, type DmsDocumentsPort } from './dms-documents.port';
import {
  buildApplicationDocuments, findChecklistItem, ID_CARD_CHECKLIST_KEY, normalizeKey, parseProductChecklist, planDocumentStep, sameDocuments,
} from './document-checklist';
import { evaluateIdCardOcr } from './document-ocr';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
/** Нэг дахин тооцооллын "бичих → шалгах" давталтын дээд тоо. Давтагдсан зөрүү бол зэрэг өөрчлөлт маш олон — үлдсэнийг event-ийн subscriber барина. */
export const MAX_RECONCILE_ATTEMPTS = 3;
/** dms-ийн `application:read` шаарддаг, хэрэглэгчгүй (event consumer) дуудлагад тавих үйлчилгээний хэрэглэгч. */
export const SERVICE_PRINCIPAL = { userId: 'system:origination', roles: ['ADMIN'] } as const;

function fail(status: 422 | 409, code: string, message: string, details?: unknown): never {
  throw new DomainError(code, message, status, details);
}

/** DMS-д зөвхөн ADMIN-ы уншигч эрхтэй үйлчилгээний контекстоор (event consumer-д хэрэглэгч байхгүй). Хэрэглэгчийн контекст байвал өөрийг нь. */
export const dmsContext = (ctx: RequestContext): RequestContext => (ctx.userId ? ctx : { ...ctx, userId: SERVICE_PRINCIPAL.userId, roles: [...SERVICE_PRINCIPAL.roles] });

interface Reconciled { documents: ApplicationDocumentsResponse; stepChanged: boolean }

/**
 * FR-9.1, FR-9.2: хүсэлтийн баримт бичиг ба 8-р алхам (`document`).
 *
 * Мутаци бүрийн дараалал (HTTP-г хүсэлтийн мөрийн түгжээн дор хэзээ ч хийхгүй):
 *   1. эрх (write) → төлөв (DRAFT/RETURNED) → дүрмийн шалгалт (түгжээгүй);
 *   2. dms-д бичих (create/remove);
 *   3. богино транзакц: `loan_application` мөрийг FOR UPDATE-ээр түгжиж, төлвийг дахин шалгаад аудит бичнэ;
 *   4. алхмыг дахин тооцох (`reconcile`): dms-ээс ШИНЭ жагсаалт авч → богино транзакцад түгжээд алхмыг бичиж → жагсаалтыг дахин уншиж
 *      хэрэв хооронд өөрчлөгдсөн бол давтана. Ингэснээр зэрэг attach/remove дуусгавар болоход алхам эцсийн жагсаалттай нийцнэ
 *      (хоцорсон хуучин жагсаалтаар бичигч нь дараагийн уншилтаар зөрүүг мэдэж засна).
 *   5. dms-ийн `DocumentUploaded`/`DocumentRemoved` event ирэхэд subscriber мөн дахин тооцно (3-4-ийн хооронд унасан тохиолдлын нөөц).
 */
@Injectable()
export class ApplicationDocumentService {
  private readonly logger = new Logger(ApplicationDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly clock: Clock,
    private readonly directory: CustomerDirectory,
    @Inject(DMS_DOCUMENTS) private readonly dms: DmsDocumentsPort,
  ) {}

  // ── унших ──────────────────────────────────────────────────────────────────────────
  async list(ctx: RequestContext, applicationId: string): Promise<ApplicationDocumentsResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const [product, documents] = await Promise.all([this.productOf(this.prisma, app), this.dms.list({ applicationId: app.id }, ctx)]);
    return this.view(product, documents);
  }

  // ── хавсаргах ───────────────────────────────────────────────────────────────────────
  async attach(ctx: RequestContext, applicationId: string, input: AttachDocumentRequest): Promise<ApplicationDocumentMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const product = await this.productOf(this.prisma, app);
    const request = await this.plan(app, product, input);

    const created = await this.dms.create(request, ctx);
    try {
      await this.confirm(ctx, app.id, async (tx) => {
        await recordAudit(tx, {
          orgId: ctx.orgId, entity: 'DOCUMENT', entityId: created.id, action: 'DOCUMENT_ATTACHED', actorId: ctx.userId, applicationId: app.id, correlationId: ctx.correlationId,
          afterJson: this.auditFacts(created),
        });
      }, true);
    } catch (err) {
      // dms-д бичигдсэн ч хүсэлт хаагдсан/алга болсон — өнчин баримт үлдээхгүй (боломжгүй бол subscriber/хөтлөгч цэвэрлэнэ)
      await this.dms.remove(created.id, ctx).catch(() => this.logger.warn({ op: 'attach.compensate', applicationId: app.id, correlationId: ctx.correlationId }));
      throw err;
    }
    const { documents } = await this.reconcile(ctx, app.id);
    return { document: documents.items.find((d) => d.id === created.id) ?? created, documents };
  }

  // ── хасах ──────────────────────────────────────────────────────────────────────────
  async remove(ctx: RequestContext, applicationId: string, documentId: string): Promise<ApplicationDocumentMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    // Баримт ЭНЭ хүсэлтийнх эсэхийг dms-ийн жагсаалтаас (applicationId-аар) баталгаажуулна — өөр хүсэлтийн баримтыг устгуулахгүй.
    const target = (await this.dms.list({ applicationId: app.id }, ctx)).find((d) => d.id === documentId);
    if (!target) throw new DomainError('DOCUMENT_NOT_FOUND', 'Баримт олдсонгүй', 404);
    this.assertNotCollateral(target.relatedEntity);

    await this.dms.remove(target.id, ctx); // false = зэрэг устгал аль хэдийн хийсэн: үр дүн адил
    // dms-ээс аль хэдийн устсан тул төлөв зэрэг өөрчлөгдсөн ч (хүсэлт илгээгдсэн) аудитыг бичнэ — 409-өөр худал хэлэхгүй
    await this.confirm(ctx, app.id, async (tx) => {
      await recordAudit(tx, {
        orgId: ctx.orgId, entity: 'DOCUMENT', entityId: target.id, action: 'DOCUMENT_REMOVED', actorId: ctx.userId, applicationId: app.id, correlationId: ctx.correlationId,
        beforeJson: this.auditFacts(target),
      });
    }, false);
    const { documents } = await this.reconcile(ctx, app.id);
    return { document: null, documents };
  }

  // ── OCR тулгалт ────────────────────────────────────────────────────────────────────
  /**
   * Зөвхөн checklist `id_card` түлхүүртэй баримтад: OCR-ийн регистрийг баримтын холбогдох зээлдэгчийн (BORROWER), хүсэлтийн түвшний
   * баримтад ҮНДСЭН зээлдэгчийн регистртэй тулгана. Бусад баримт NOT_APPLICABLE (dms-д хандахгүй). Зөвлөмж — хадгалахгүй; регистр, текст логлохгүй.
   * Эрх: бичих (ЗЭЗ өөрийн, ADMIN) — хүсэлтийн төлвөөс үл хамаарна (юу ч өөрчлөхгүй).
   */
  async ocrCheck(ctx: RequestContext, applicationId: string, documentId: string): Promise<DocumentOcrCheck> {
    const app = await this.access.load(ctx, applicationId, 'write');
    const doc = (await this.dms.list({ applicationId: app.id }, ctx)).find((d) => d.id === documentId && d.relatedEntity !== 'COLLATERAL');
    if (!doc) throw new DomainError('DOCUMENT_NOT_FOUND', 'Баримт олдсонгүй', 404);
    const checkedAt = this.clock.now().toISOString();
    if (!doc.checklistKey || normalizeKey(doc.checklistKey) !== ID_CARD_CHECKLIST_KEY)
      return { documentId: doc.id, verdict: 'NOT_APPLICABLE', docType: null, registerMasked: null, confidence: null, warnings: [], checkedAt };

    const customerId = doc.relatedEntity === 'BORROWER' && doc.relatedId ? doc.relatedId : await this.primaryCustomerId(app.id);
    const link = await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId: app.id, customerId }, select: { id: true } });
    const customer = link ? await this.directory.findById(this.prisma, app.orgId, customerId) : null;
    if (!customer) return fail(422, 'BORROWER_NOT_ON_APPLICATION', 'Баримтын холбогдох зээлдэгч энэ хүсэлтэд байхгүй байна');

    const outcome = await this.dms.ocr(doc.id, ctx);
    const evaluation = evaluateIdCardOcr(customerRegisterNo(customer), outcome);
    // PII-гүй лог: дүгнэлт л (регистр, текст, нэр байхгүй)
    this.logger.log({ op: 'ocrCheck', applicationId: app.id, documentId: doc.id, verdict: evaluation.verdict, correlationId: ctx.correlationId });
    return { documentId: doc.id, ...evaluation, checkedAt };
  }

  // ── event (subscriber) ─────────────────────────────────────────────────────────────
  /**
   * `DocumentUploaded`/`DocumentRemoved` → тухайн хүсэлтийн 8-р алхмыг дахин тооцно. Үл мэдэгдэх хүсэлт, өөр байгууллага, хүсэлтгүй баримт (`applicationId = null`),
   * засагдахгүй төлөв (илгээсэн хүсэлтийн алхмыг хөдөлгөхгүй) → чимээгүй алгасна. Алдаа шидвэл bus дахин хүргэнэ.
   */
  async recomputeFromEvent(event: { orgId: string; applicationId: string | null; correlationId: string }): Promise<void> {
    if (!event.applicationId) return;
    const app = await this.prisma.loanApplication.findFirst({ where: { id: event.applicationId, orgId: event.orgId }, select: { id: true, status: true } });
    if (!app || !isEditableStatus(app.status)) return;
    const ctx: RequestContext = dmsContext({ userId: null, roles: [], branchId: null, orgId: event.orgId, customerId: null, correlationId: event.correlationId });
    await this.reconcile(ctx, app.id);
  }

  // ── дотоод ──────────────────────────────────────────────────────────────────────────
  /** Хавсралтын хүсэлтийг шалгаж, dms-д илгээх `CreateDocumentRequest` болгоно (checklist түлхүүрийг бүтээгдэхүүний каноник хэлбэрээр). */
  private async plan(app: LoanApplication, product: Product | null, input: AttachDocumentRequest): Promise<CreateDocumentRequest> {
    this.assertNotCollateral(input.relatedEntity);
    const relatedId = input.relatedId?.trim() || undefined;
    if (input.relatedEntity === 'APPLICATION' && relatedId) fail(422, 'RELATED_ID_NOT_ALLOWED', 'Хүсэлтийн түвшний баримтад холбогдох зээлдэгчийг заахгүй');
    if (input.relatedEntity === 'BORROWER') {
      if (!relatedId) fail(422, 'RELATED_ID_REQUIRED', 'Зээлдэгчид холбох баримтад зээлдэгчийг заавал заана');
      const link = await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId: app.id, customerId: relatedId }, select: { id: true } });
      if (!link) fail(422, 'BORROWER_NOT_ON_APPLICATION', 'Заасан зээлдэгч энэ хүсэлтийн оролцогч биш байна');
    }

    // Бүтээгдэхүүнгүй бол checklist хоосон: түлхүүр өгөх боломжгүй, төрлөөр хавсаргана (FR-9.1)
    const checklist = product ? parseProductChecklist(product.documentChecklistJson).items : [];
    let checklistKey: string | undefined;
    if (input.checklistKey !== undefined) {
      const item = findChecklistItem(checklist, input.checklistKey);
      if (!item) return fail(422, 'UNKNOWN_CHECKLIST_KEY', 'Баримтын checklist-д ийм түлхүүр байхгүй байна', { allowedKeys: checklist.map((i) => i.key) });
      checklistKey = item.key;
    } else if (input.type !== undefined) {
      // Төрөл нь checklist-ийн түлхүүртэй давхцвал ("id_card") тэр мөрийг хангана — санамсаргүй "нэмэлт" болгохгүй
      checklistKey = findChecklistItem(checklist, input.type)?.key;
    }
    const type = input.type ?? checklistKey;
    if (!type) return fail(422, 'DOCUMENT_TYPE_REQUIRED', 'Баримтын төрөл эсвэл checklist-ийн түлхүүрийг заана уу');
    return {
      applicationId: app.id, type, relatedEntity: input.relatedEntity, ...(relatedId ? { relatedId } : {}),
      ...(input.note ? { note: input.note } : {}), fileId: input.fileId, ...(checklistKey ? { checklistKey } : {}),
    };
  }

  private assertNotCollateral(relatedEntity: string): void {
    if (relatedEntity === 'COLLATERAL') fail(422, 'USE_COLLATERAL_DOCUMENTS', 'Барьцааны баримтыг барьцааны хэсгээс (барьцааны баримтын цэс) хавсаргана/хасна');
  }

  private assertEditable(app: Pick<LoanApplication, 'status'>): void {
    if (!isEditableStatus(app.status)) throw conflict('APPLICATION_NOT_EDITABLE', 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л баримтыг өөрчилнө', { status: app.status });
  }

  /**
   * Хүсэлтийн мөрийг түгжиж (FOR UPDATE) аудит бичнэ. `requireEditable`: түгжээ авсны дараа төлөв засагдахаа больсон бол 409
   * (attach-д dms-ийн баримтыг буцаана). remove-д dms-ээс аль хэдийн устсан тул шалгахгүй.
   */
  private async confirm(ctx: RequestContext, applicationId: string, work: (tx: Tx) => Promise<void>, requireEditable: boolean): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lock(tx, ctx.orgId, applicationId);
      if (!app) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);
      if (requireEditable) this.assertEditable(app);
      await work(tx);
    }, TX_OPTIONS);
  }

  /** Түгжээ авсны дараа төлөвийг дахин уншина (READ COMMITTED). Хүсэлт алга бол null. */
  private async lock(tx: Tx, orgId: string, applicationId: string): Promise<LoanApplication | null> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${applicationId} AND org_id = ${orgId} FOR UPDATE`;
    return locked.length ? tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } }) : null;
  }

  /**
   * 8-р алхмыг dms-ийн ШИНЭ жагсаалтаар дахин тооцно. dms-ээс унших нь түгжээний гадна; бичих нь богино транзакцад.
   * `бичих → жагсаалтыг дахин унших → хооронд өөрчлөгдсөн бол давтах` — сүүлд бичсэн нь үргэлж өөрийнхөө дараа уншсан жагсаалтыг тусгана.
   */
  private async reconcile(ctx: RequestContext, applicationId: string): Promise<Reconciled> {
    const dmsCtx = dmsContext(ctx);
    let documents = await this.dms.list({ applicationId }, dmsCtx);
    let stepChanged = false;
    for (let attempt = 1; ; attempt++) {
      const applied = await this.applyStep(ctx, applicationId, documents);
      stepChanged ||= applied.stepChanged;
      const after = await this.dms.list({ applicationId }, dmsCtx);
      const stable = sameDocuments(documents, after);
      documents = after;
      if (stable) return { documents: this.view(applied.product, documents), stepChanged };
      if (attempt >= MAX_RECONCILE_ATTEMPTS) {
        // Зэрэг өөрчлөлт хэт олон: хамгийн сүүлийн жагсаалтаар нэг удаа бичээд гарна; үлдсэн зөрүүг dms-ийн event (subscriber) засна
        const last = await this.applyStep(ctx, applicationId, documents);
        this.logger.warn({ op: 'reconcile.unstable', applicationId, attempts: attempt, correlationId: ctx.correlationId });
        return { documents: this.view(last.product, documents), stepChanged: stepChanged || last.stepChanged };
      }
    }
  }

  /** Түгжээд: бүтээгдэхүүнийг шинээр уншиж, жагсаалтаас checklist тооцоод, `document` алхмыг бичнэ (LOCKED-д хүрэхгүй; засагдахгүй төлөвт алхам хөдөлгөхгүй). */
  private async applyStep(ctx: RequestContext, applicationId: string, documents: readonly DocumentView[]): Promise<{ product: Product | null; stepChanged: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const app = await this.lock(tx, ctx.orgId, applicationId);
      if (!app) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);
      const product = await this.productOf(tx, app);
      if (!isEditableStatus(app.status)) return { product, stepChanged: false };
      const view = this.view(product, documents);
      const step = await tx.loanApplicationStep.findUnique({ where: { applicationId_stepKey: { applicationId, stepKey: 'document' } }, select: { id: true, status: true } });
      const plan = planDocumentStep(step, view.summary.complete, this.clock.now());
      if (!plan) return { product, stepChanged: false };
      const { count } = await tx.loanApplicationStep.updateMany({
        where: { id: plan.id, status: { not: 'LOCKED' } },
        data: { status: plan.status, staleReason: plan.staleReason, completedAt: plan.completedAt },
      });
      return { product, stepChanged: count > 0 };
    }, TX_OPTIONS);
  }

  private view(product: Product | null, documents: readonly DocumentView[]): ApplicationDocumentsResponse {
    const parsed = parseProductChecklist(product?.documentChecklistJson);
    if (parsed.invalid) this.logger.warn({ op: 'checklist.invalid', productId: product?.id }); // тохиргооны алдаа: checklist хоосон гэж үзсэн
    return buildApplicationDocuments({ productPresent: !!product, checklist: parsed.items, documents });
  }

  private productOf(db: Tx | PrismaService, app: Pick<LoanApplication, 'productId' | 'orgId'>): Promise<Product | null> {
    return app.productId ? db.product.findFirst({ where: { id: app.productId, orgId: app.orgId } }) : Promise.resolve(null);
  }

  private async primaryCustomerId(applicationId: string): Promise<string> {
    const primary = await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId, role: 'PRIMARY' }, select: { customerId: true } });
    if (!primary) return fail(422, 'PRIMARY_BORROWER_MISSING', 'Үндсэн зээлдэгч бүртгэгдээгүй байна (1-р алхам)');
    return primary.customerId;
  }

  /** Аудитад PII-гүй баримтууд: тайлбар, файлын нэр, чөлөөт төрлийг оруулахгүй (нэр агуулж болно). */
  private auditFacts(d: DocumentView): Record<string, unknown> {
    return { documentId: d.id, fileId: d.fileId, checklistKey: d.checklistKey, relatedEntity: d.relatedEntity, relatedId: d.relatedId };
  }
}
