import { randomUUID } from 'node:crypto';
import { DomainError } from '@los/nest-common';
import type { ContractTemplateType, RenderTemplateRequest, RequestContext } from '@los/contracts';
import type { DmsDocgenPort } from '../dms-docgen.port';

/** Тест: dms-гүй. Үүсгэсэн өгөгдлийг `renders`-д хадгална (PDF-д зээлдэгчийн нэр, дүн, ЭТХ орсон эсэхийг шалгахад). */
export class FakeDmsDocgen implements DmsDocgenPort {
  readonly renders: RenderTemplateRequest[] = [];
  readonly files = new Set<string>();
  /** Файлын байршуулагч; бүртгээгүй бол дуудагч өөрөө (upload → attach урсгал). */
  readonly uploaders = new Map<string, string | null>();
  /** dms-ийн хадгалсан (magic bytes-аар баталгаажсан) төрөл; бүртгээгүй бол PDF (render-ийн үр дүн, хуучин тестүүд). `null` = dms төрлөө хэлээгүй. */
  readonly mimes = new Map<string, string | null>();
  templates = new Set<ContractTemplateType>(['LOAN_CONTRACT', 'OFFICIAL_LETTER']);
  async render(req: RenderTemplateRequest, _ctx: RequestContext) {
    if (!this.templates.has(req.type)) throw new DomainError('TEMPLATE_NOT_CONFIGURED', 'Энэ төрлийн идэвхтэй загвар тохируулаагүй байна', 422);
    this.renders.push(req);
    const pdfFileId = randomUUID();
    this.files.add(pdfFileId);
    return { templateId: randomUUID(), templateVersion: 1, docxFileId: randomUUID(), pdfFileId };
  }
  async fileInfo(fileId: string, ctx: RequestContext) {
    if (!this.files.has(fileId)) return null;
    return {
      uploadedBy: this.uploaders.has(fileId) ? (this.uploaders.get(fileId) ?? null) : ctx.userId,
      mime: this.mimes.has(fileId) ? (this.mimes.get(fileId) ?? null) : 'application/pdf',
    };
  }
  async hasTemplate(type: ContractTemplateType) { return this.templates.has(type); }
}
