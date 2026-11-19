import { Injectable } from '@nestjs/common';
import type { ApplicationDocumentsResponse, MissingDocument, RequestContext } from '@los/contracts';

type ReconciledDocuments = { documents: ApplicationDocumentsResponse; checklistInvalid: boolean };
import { DomainError } from '@los/nest-common';
import type { LoanApplication } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { AmlGateService } from '../aml/aml-gate.service';
import { missingRequiredDocuments } from '../document/document-checklist';
import { ApplicationDocumentService } from '../document/document.service';
import { missingRequiredSteps } from './application.rules';

const DOCUMENT_STEP = 'document';

/**
 * G1 «Илгээх боломж» (docs/01 §4) — мөрийн түгжээний ГАДНА хийгдэх HTTP-тэй урьдчилсан шалгалт (эрхийг дуудагч шалгасан).
 *  1. FR-9.2: `br7.required_steps`-д `document` байвал dms-ийн шинэ жагсаалтаар 8-р алхмыг дахин тооцно → дутуу бол 422 `DOCUMENTS_INCOMPLETE` (нэрээр).
 *  2. BR-7: бусад заавал алхам дутуу бол 422 `STEPS_INCOMPLETE` (kyc-ийг дэмий дуудахгүй).
 *  3. FR-3.4: оролцогч бүрийн AML шалгалт (`AmlGateService.screenForSubmit`).
 * Эцсийн, уралдаанд тэсвэртэй шийдвэр нь `ApplicationStateMachine.apply` (түгжээн дотор: алхам, нөхцөл, хадгалсан AML).
 */
@Injectable()
export class SubmitGateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrgSettings,
    private readonly documents: ApplicationDocumentService,
    private readonly aml: AmlGateService,
  ) {}

  async prepare(ctx: RequestContext, app: LoanApplication): Promise<void> {
    const required = await this.settings.get(ctx.orgId, 'br7.required_steps');
    const docs = required.includes(DOCUMENT_STEP) ? await this.documents.reconcileForSubmit(ctx, app.id) : null;
    const steps = await this.prisma.loanApplicationStep.findMany({ where: { applicationId: app.id } });
    const missing = missingRequiredSteps(steps, required);
    const missingDocuments = docs ? missingRequiredDocuments(docs.documents) : [];
    if (missing.some((k) => k !== DOCUMENT_STEP)) {
      throw new DomainError('STEPS_INCOMPLETE', 'Заавал алхмууд бүрдээгүй тул илгээх боломжгүй', 422, { missing, missingDocuments });
    }
    if (missing.includes(DOCUMENT_STEP)) throw documentsIncomplete(docs, missingDocuments);
    if (app.productId == null || app.amount == null) return; // түгжээн дотор LOAN_TERMS_MISSING — kyc-ийг дэмий дуудахгүй
    await this.aml.screenForSubmit(ctx, app);
  }
}

/** `details.reason`: PRODUCT_CHECKLIST_INVALID (тохиргооны алдаа — admin засна) | PRODUCT_MISSING | MISSING_DOCUMENTS. */
function documentsIncomplete(docs: ReconciledDocuments | null, missingDocuments: MissingDocument[]): DomainError {
  const fail = (reason: string, text: string) =>
    new DomainError('DOCUMENTS_INCOMPLETE', `Заавал баримт бичиг бүрдээгүй тул илгээх боломжгүй: ${text}`, 422, { missing: [DOCUMENT_STEP], missingDocuments, reason });
  if (docs?.checklistInvalid) return fail('PRODUCT_CHECKLIST_INVALID', 'бүтээгдэхүүний баримтын жагсаалтын тохиргоо буруу байна — админд хандана уу');
  if (docs?.documents.summary.productMissing) return fail('PRODUCT_MISSING', 'бүтээгдэхүүн сонгогдоогүй тул баримтын жагсаалт тодорхойгүй');
  return fail('MISSING_DOCUMENTS', missingDocuments.map((d) => d.name).join(', ') || 'баримтын алхам бүрдээгүй');
}
