import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ContractView, CreateOfficialLetterRequest, OfficialLetterView, RequestContext } from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { Contract, LoanApplication, OfficialLetter } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { APPLICATION_SIGNING_LOOKUP, type ApplicationSigningLookup } from './application-signing-lookup';
import { buildTemplateData } from './contract-data';
import { DMS_DOCGEN, type DmsDocgenPort } from './dms-docgen.port';

const DOC_STATUSES = ['APPROVED', 'DISBURSING'];
const ACTIVE_SIGNING = ['PENDING', 'IN_PROGRESS', 'FINALIZING'];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const n = (d: { toString(): string } | null | undefined) => (d == null ? 0 : Number(d.toString()));

export const toContractView = (c: Contract): ContractView => ({
  id: c.id, applicationId: c.applicationId, contractNo: c.contractNo, templateVersion: c.templateVersion, generatedFileId: c.generatedFileId,
  signedFileId: c.signedFileId, signedAt: c.signedAt?.toISOString() ?? null, signChannel: c.signChannel as 'PAPER' | 'ESIGN', signingStatus: c.signingStatus,
});
const toLetterView = (l: OfficialLetter): OfficialLetterView => ({ id: l.id, applicationId: l.applicationId, templateId: l.templateId, generatedFileId: l.generatedFileId, printedAt: l.printedAt?.toISOString() ?? null, createdAt: l.createdAt.toISOString() });

/** FR-11.1/11.3: батлагдсан хүсэлтийн гэрээ + ЭТХ PDF (dms загвар), цаасан гарын үсгийн скан (G4), албан бичиг. */
@Injectable()
export class ContractDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    @Inject(DMS_DOCGEN) private readonly dms: DmsDocgenPort,
    @Inject(APPLICATION_SIGNING_LOOKUP) private readonly lookup: ApplicationSigningLookup,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async get(ctx: RequestContext, applicationId: string): Promise<{ contract: ContractView | null; letters: OfficialLetterView[] }> {
    await this.access.load(ctx, applicationId, 'read');
    const [contract, letters] = await Promise.all([
      this.prisma.contract.findUnique({ where: { applicationId } }),
      this.prisma.officialLetter.findMany({ where: { applicationId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { contract: contract ? toContractView(contract) : null, letters: letters.map(toLetterView) };
  }

  /** "Гэрээ үүсгэх": загвараас DOCX+PDF (ЭТХ хавсралттай). Гарын үсэг зурагдсан/зурагдаж буй бол дахин үүсгэхгүй. */
  async generate(ctx: RequestContext, applicationId: string): Promise<ContractView> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertStage2(app);
    const existing = await this.prisma.contract.findUnique({ where: { applicationId } });
    if (existing?.signedFileId || existing?.signingStatus === 'SIGNED') throw new ConflictException({ code: 'CONTRACT_ALREADY_SIGNED', message: 'Гарын үсэг зурагдсан гэрээг дахин үүсгэх боломжгүй' });
    if (existing?.signingStatus && ACTIVE_SIGNING.includes(existing.signingStatus)) throw new ConflictException({ code: 'CONTRACT_SIGNING_IN_PROGRESS', message: 'Цахим гарын үсгийн хүсэлт идэвхтэй байна — эхлээд цуцлана уу' });

    const data = await this.loadData(ctx, app);
    const rendered = await this.dms.render({ type: 'LOAN_CONTRACT', productId: app.productId, data, fileBaseName: `contract-${app.contractNo}` }, ctx);
    const now = this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      const c = existing
        ? await tx.contract.update({ where: { id: existing.id }, data: { generatedFileId: rendered.pdfFileId, templateVersion: rendered.templateVersion, updatedBy: ctx.userId } })
        : await tx.contract.create({ data: { orgId: ctx.orgId, applicationId, contractNo: app.contractNo as string, generatedFileId: rendered.pdfFileId, templateVersion: rendered.templateVersion, createdBy: ctx.userId, updatedBy: ctx.userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'CONTRACT', entityId: c.id, action: existing ? 'CONTRACT_REGENERATED' : 'CONTRACT_GENERATED', actorId: ctx.userId, afterJson: { templateId: rendered.templateId, templateVersion: rendered.templateVersion, at: now.toISOString() }, applicationId, correlationId: ctx.correlationId });
      return c;
    });
    return toContractView(row);
  }

  /** G4: гарын үсэгтэй (цаасан) гэрээний скан хавсаргах. ESIGN-ий үр дүн нь ContractSigned event-ээр орно. */
  async attachSigned(ctx: RequestContext, applicationId: string, fileId: string): Promise<ContractView> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertStage2(app);
    const c = await this.prisma.contract.findUnique({ where: { applicationId } });
    if (!c?.generatedFileId) throw new ConflictException({ code: 'CONTRACT_NOT_GENERATED', message: 'Эхлээд гэрээг үүсгэнэ үү' });
    if (c.signedFileId) throw new ConflictException({ code: 'CONTRACT_ALREADY_SIGNED', message: 'Гэрээнд аль хэдийн гарын үсэг зурагдсан байна' });
    if (c.signingStatus && ACTIVE_SIGNING.includes(c.signingStatus)) throw new ConflictException({ code: 'CONTRACT_SIGNING_IN_PROGRESS', message: 'Цахим гарын үсгийн хүсэлт идэвхтэй байна' });
    if (!(await this.dms.fileExists(fileId, ctx))) throw new DomainError('FILE_NOT_FOUND', 'Файл олдсонгүй', 422);
    const now = this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      const res = await tx.contract.updateMany({ where: { id: c.id, signedFileId: null }, data: { signedFileId: fileId, signedAt: now, signChannel: 'PAPER', updatedBy: ctx.userId } });
      if (res.count !== 1) throw new ConflictException({ code: 'CONTRACT_ALREADY_SIGNED', message: 'Гэрээнд аль хэдийн гарын үсэг зурагдсан байна' });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'CONTRACT', entityId: c.id, action: 'CONTRACT_PAPER_SIGNED_ATTACHED', actorId: ctx.userId, afterJson: { fileId }, applicationId, correlationId: ctx.correlationId });
      return tx.contract.findUniqueOrThrow({ where: { id: c.id } });
    });
    return toContractView(row);
  }

  // ── FR-11.3 албан бичиг ──
  async createLetter(ctx: RequestContext, applicationId: string, req: CreateOfficialLetterRequest): Promise<OfficialLetterView> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertStage2(app);
    const base = await this.loadData(ctx, app);
    const now = this.clock.now();
    const count = await this.prisma.officialLetter.count({ where: { applicationId } });
    const data = { letter_no: `${app.contractNo}/${count + 1}`, letter_date: ymd(now), ...base, ...(req.extra ?? {}) };
    const rendered = await this.dms.render({ type: 'OFFICIAL_LETTER', productId: app.productId, templateId: req.templateId, data, fileBaseName: `letter-${app.contractNo}-${count + 1}` }, ctx);
    const row = await this.prisma.$transaction(async (tx) => {
      const l = await tx.officialLetter.create({ data: { orgId: ctx.orgId, applicationId, templateId: rendered.templateId, generatedFileId: rendered.pdfFileId, createdBy: ctx.userId, updatedBy: ctx.userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'OFFICIAL_LETTER', entityId: l.id, action: 'OFFICIAL_LETTER_CREATED', actorId: ctx.userId, afterJson: { templateId: rendered.templateId }, applicationId, correlationId: ctx.correlationId });
      return l;
    });
    return toLetterView(row);
  }

  async markPrinted(ctx: RequestContext, applicationId: string, letterId: string): Promise<OfficialLetterView> {
    await this.access.load(ctx, applicationId, 'write');
    const l = await this.prisma.officialLetter.findFirst({ where: { id: letterId, applicationId, orgId: ctx.orgId } });
    if (!l) throw new NotFoundException({ code: 'LETTER_NOT_FOUND', message: 'Албан бичиг олдсонгүй' });
    return toLetterView(await this.prisma.officialLetter.update({ where: { id: l.id }, data: { printedAt: this.clock.now(), updatedBy: ctx.userId } }));
  }

  // ── дотоод ──
  private assertStage2(app: LoanApplication): void {
    if (!DOC_STATUSES.includes(app.status) || !app.contractNo) throw new ConflictException({ code: 'CONTRACT_NOT_AVAILABLE', message: 'Гэрээ, албан бичиг нь батлагдсан хүсэлтэд л үүснэ', details: { status: app.status } });
  }

  private async loadData(ctx: RequestContext, app: LoanApplication) {
    const [schedule, product, decision, collaterals, coBorrowers, signing] = await Promise.all([
      this.prisma.repaymentSchedule.findFirst({ where: { applicationId: app.id, isStale: false }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }], include: { rows: { orderBy: { seq: 'asc' } } } }),
      app.productId ? this.prisma.product.findUnique({ where: { id: app.productId } }) : null,
      this.prisma.decisionRecord.findFirst({ where: { applicationId: app.id }, orderBy: { decidedAt: 'desc' } }),
      this.prisma.collateral.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.loanApplicationBorrower.findMany({ where: { applicationId: app.id, role: 'CO_BORROWER' }, include: { customer: { select: { lastName: true, firstName: true } } } }),
      this.lookup.getForSigning(ctx.orgId, app.id),
    ]);
    if (!schedule) throw new DomainError('SCHEDULE_MISSING', 'Хүчинтэй эргэн төлөлтийн хуваарь алга — эхлээд ЭТХ үүсгэнэ үү', 422);
    if (!signing?.primaryBorrower) throw new DomainError('PRIMARY_BORROWER_MISSING', 'Үндсэн зээлдэгч олдсонгүй', 422);
    const params = schedule.paramsJson as { type?: string; firstPaymentDate?: string };
    const env = process.env;
    return buildTemplateData({
      contractNo: app.contractNo as string, contractDate: ymd(this.clock.now()), decisionNo: decision?.decisionNo ?? null, productName: product?.name ?? '', currency: app.currency,
      amount: n(app.amount), termMonths: app.termMonths ?? 0, interestRate: n(app.interestRate), repaymentType: params.type ?? 'ANNUITY', firstPaymentDate: params.firstPaymentDate ?? null,
      borrower: { name: signing.primaryBorrower.fullName, registerNo: signing.primaryBorrower.registerNo, phone: signing.primaryBorrower.phone, address: '' },
      coBorrowerNames: coBorrowers.map((b) => [b.customer.lastName, b.customer.firstName].filter(Boolean).join(' ')),
      // DEMO: салбарын нэр iam (gateway) схемд — origination-д зөвхөн id. Бодит нэрийг салбарын лавлах холбогдсоны дараа.
      branchName: app.branchId ?? '', officerName: app.officerId ?? '',
      collaterals: collaterals.map((c) => ({ description: collateralDescription(c.assetType, c.descriptionJson, c.registryNo), value: n(c.collateralValue ?? c.marketValue), registryNo: c.registryNo })),
      schedule: schedule.rows.map((r) => ({ seq: r.seq, dueDate: ymd(r.dueDate), principal: n(r.principal), interest: n(r.interest), total: n(r.total), balance: n(r.balance) })),
      org: { name: env.ORG_LEGAL_NAME ?? 'ББСБ (DEMO)', representativeName: env.ORG_REPRESENTATIVE_NAME ?? 'Гүйцэтгэх захирал (DEMO)', representativeTitle: env.ORG_REPRESENTATIVE_TITLE ?? 'Гүйцэтгэх захирал' },
    });
  }
}

function collateralDescription(assetType: string, desc: unknown, registryNo: string | null): string {
  const d = (desc ?? {}) as Record<string, unknown>;
  const label = ['address', 'plateNo', 'plate', 'description', 'name'].map((k) => d[k]).find((v) => typeof v === 'string' && v) as string | undefined;
  return [assetType, label ?? registryNo].filter(Boolean).join(' · ');
}
