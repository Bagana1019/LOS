import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PLACEHOLDER_CATALOG, type ContractTemplateType, type ContractTemplateView, type RenderTemplateRequest, type RenderTemplateResponse, type RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import type { ContractTemplate } from '.prisma/client-dms';
import { PrismaService } from '../../prisma.service';
import { FileService, type UploadedFile } from '../file/file.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../file/storage';
import { extractPlaceholders, fillDocx } from './docx-renderer';
import { demoLoanContractDocx, demoOfficialLetterDocx } from './demo-template';
import { PDF_CONVERTER, type PdfConverter } from './pdf-converter';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Давталтын доторх талбарууд — каталогийн түлхүүр биш ч "тодорхойгүй" гэж үзэхгүй. */
export const LOOP_FIELDS = ['no', 'due_date', 'principal', 'interest', 'total', 'balance', 'description', 'value', 'registry_no'] as const;
const KNOWN = new Set<string>([...PLACEHOLDER_CATALOG.map((p) => p.key), ...LOOP_FIELDS]);

export const toTemplateView = (t: ContractTemplate): ContractTemplateView => {
  const placeholders = Array.isArray(t.placeholdersJson) ? (t.placeholdersJson as string[]) : [];
  return { id: t.id, productId: t.productId, type: t.type as ContractTemplateType, name: t.name, docxFileId: t.docxFileId, placeholders, unknownPlaceholders: placeholders.filter((k) => !KNOWN.has(k)), version: t.version, isActive: t.isActive, createdAt: t.createdAt.toISOString() };
};

/** FR-11.1/11.2: гэрээ, ЭТХ, албан бичгийн docx загвар (түүх: version), placeholder каталог, загвараас PDF үүсгэх. */
@Injectable()
export class TemplateService {
  constructor(
    private readonly db: PrismaService,
    private readonly files: FileService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(PDF_CONVERTER) private readonly pdf: PdfConverter,
  ) {}

  catalog() { return PLACEHOLDER_CATALOG; }

  async list(ctx: RequestContext, q: { productId?: string | null; type?: ContractTemplateType; activeOnly?: boolean }): Promise<ContractTemplateView[]> {
    const rows = await this.db.contractTemplate.findMany({
      where: { orgId: ctx.orgId, ...(q.productId !== undefined ? { productId: q.productId } : {}), ...(q.type ? { type: q.type } : {}), ...(q.activeOnly ? { isActive: true } : {}) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }, { version: 'desc' }],
    });
    return rows.map(toTemplateView);
  }

  /** docx оруулна. Нэр+төрөл+бүтээгдэхүүн ижил бол version+1 болж, өмнөх идэвхтэй хувилбар идэвхгүй болно. */
  async create(ctx: RequestContext, file: UploadedFile | undefined, input: { type: ContractTemplateType; name: string; productId: string | null }): Promise<ContractTemplateView> {
    if (!file?.buffer?.length) throw new DomainError('FILE_REQUIRED', 'Загварын docx файл сонгоогүй байна', 400);
    if (!file.originalname.toLowerCase().endsWith('.docx')) throw new DomainError('TEMPLATE_NOT_DOCX', 'Загвар .docx байх ёстой', 415);
    const placeholders = extractPlaceholders(file.buffer); // буруу docx бол файл хадгалахаас өмнө 422
    const stored = await this.files.upload(ctx, { ...file, mimetype: DOCX_MIME });
    const row = await this.db.$transaction(async (tx) => {
      const where = { orgId: ctx.orgId, productId: input.productId, type: input.type };
      const last = await tx.contractTemplate.findFirst({ where: { ...where, name: input.name }, orderBy: { version: 'desc' } });
      await tx.contractTemplate.updateMany({ where: { ...where, isActive: true }, data: { isActive: false, updatedBy: ctx.userId } });
      return tx.contractTemplate.create({ data: { ...where, name: input.name, docxFileId: stored.id, placeholdersJson: placeholders, version: (last?.version ?? 0) + 1, isActive: true, createdBy: ctx.userId, updatedBy: ctx.userId } });
    });
    return toTemplateView(row);
  }

  /** DEMO: нийтлэг (productId=null) идэвхтэй загвар байхгүй төрөл бүрт DEMO docx суулгана. Жинхэнэ загвар ирэхэд `create`-ээр солино. */
  async installDemo(ctx: RequestContext): Promise<ContractTemplateView[]> {
    const demos: Array<{ type: ContractTemplateType; name: string; buffer: Buffer }> = [
      { type: 'LOAN_CONTRACT', name: 'Зээлийн гэрээ (DEMO)', buffer: demoLoanContractDocx() },
      { type: 'OFFICIAL_LETTER', name: 'Албан бичиг (DEMO)', buffer: demoOfficialLetterDocx() },
    ];
    const out: ContractTemplateView[] = [];
    for (const d of demos) {
      if (await this.db.contractTemplate.findFirst({ where: { orgId: ctx.orgId, productId: null, type: d.type, isActive: true } })) continue;
      out.push(await this.create(ctx, { originalname: `${d.type.toLowerCase()}-demo.docx`, mimetype: DOCX_MIME, buffer: d.buffer, size: d.buffer.length }, { type: d.type, name: d.name, productId: null }));
    }
    return out;
  }

  /** Хуучин хувилбарыг дахин идэвхжүүлэх (rollback) эсвэл идэвхгүй болгох. */
  async setActive(ctx: RequestContext, id: string, isActive: boolean): Promise<ContractTemplateView> {
    const t = await this.find(ctx, id);
    const row = await this.db.$transaction(async (tx) => {
      if (isActive) await tx.contractTemplate.updateMany({ where: { orgId: ctx.orgId, productId: t.productId, type: t.type, isActive: true, id: { not: id } }, data: { isActive: false, updatedBy: ctx.userId } });
      return tx.contractTemplate.update({ where: { id }, data: { isActive, updatedBy: ctx.userId } });
    });
    return toTemplateView(row);
  }

  async render(ctx: RequestContext, req: RenderTemplateRequest): Promise<RenderTemplateResponse> {
    const t = await this.resolve(ctx, req);
    const docx = await this.read(t.docxFileId, ctx);
    const filled = fillDocx(docx, req.data);
    const pdf = await this.pdf.convert(filled);
    const base = (req.fileBaseName ?? 'document').replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 80);
    const [docxFile, pdfFile] = [
      await this.files.upload(ctx, { originalname: `${base}.docx`, mimetype: DOCX_MIME, buffer: filled, size: filled.length }),
      await this.files.upload(ctx, { originalname: `${base}.pdf`, mimetype: 'application/pdf', buffer: pdf, size: pdf.length }),
    ];
    return { templateId: t.id, templateVersion: t.version, docxFileId: docxFile.id, pdfFileId: pdfFile.id };
  }

  private async find(ctx: RequestContext, id: string): Promise<ContractTemplate> {
    const t = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.contractTemplate.findFirst({ where: { id, orgId: ctx.orgId } }) : null;
    if (!t) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Загвар олдсонгүй' });
    return t;
  }

  private async resolve(ctx: RequestContext, req: RenderTemplateRequest): Promise<ContractTemplate> {
    if (req.templateId) {
      const t = await this.find(ctx, req.templateId);
      if (t.type !== req.type) throw new DomainError('TEMPLATE_TYPE_MISMATCH', 'Загварын төрөл таарахгүй байна', 422);
      return t;
    }
    // Бүтээгдэхүүний идэвхтэй загвар, байхгүй бол нийтлэг (productId = null)
    for (const productId of req.productId ? [req.productId, null] : [null]) {
      const t = await this.db.contractTemplate.findFirst({ where: { orgId: ctx.orgId, productId, type: req.type, isActive: true }, orderBy: { version: 'desc' } });
      if (t) return t;
    }
    throw new DomainError('TEMPLATE_NOT_CONFIGURED', 'Энэ төрлийн идэвхтэй загвар тохируулаагүй байна (Тохиргоо → Загвар)', 422, { type: req.type });
  }

  private async read(fileId: string, ctx: RequestContext): Promise<Buffer> {
    const { row, stream } = await this.files.open(ctx, fileId);
    void row;
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }
}
