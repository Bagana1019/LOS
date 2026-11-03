import { randomUUID } from 'node:crypto';
import { DomainError } from '@los/nest-common';
import type { ContractTemplateType, RenderTemplateRequest, RequestContext } from '@los/contracts';
import type { DmsDocgenPort } from '../dms-docgen.port';

/** Тест: dms-гүй. Үүсгэсэн өгөгдлийг `renders`-д хадгална (PDF-д зээлдэгчийн нэр, дүн, ЭТХ орсон эсэхийг шалгахад). */
export class FakeDmsDocgen implements DmsDocgenPort {
  readonly renders: RenderTemplateRequest[] = [];
  readonly files = new Set<string>();
  templates = new Set<ContractTemplateType>(['LOAN_CONTRACT', 'OFFICIAL_LETTER']);
  async render(req: RenderTemplateRequest, _ctx: RequestContext) {
    if (!this.templates.has(req.type)) throw new DomainError('TEMPLATE_NOT_CONFIGURED', 'Энэ төрлийн идэвхтэй загвар тохируулаагүй байна', 422);
    this.renders.push(req);
    const pdfFileId = randomUUID();
    this.files.add(pdfFileId);
    return { templateId: randomUUID(), templateVersion: 1, docxFileId: randomUUID(), pdfFileId };
  }
  async fileExists(fileId: string) { return this.files.has(fileId); }
  async hasTemplate(type: ContractTemplateType) { return this.templates.has(type); }
}
