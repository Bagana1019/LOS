import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AmlScreeningResult, BorrowerRole, RequestContext, ScreeningStatus } from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { Customer, LoanApplication } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { customerRegisterNo } from '../borrower/customer-directory';
import { evaluateAmlGate, shouldReuseScreening, toAmlSubject, uniqueSubjects, type AmlGateVerdict, type GateBorrower, type GateScreening } from './aml-gate.rules';
import { KYC_AML_PORT, type KycAmlPort } from './ports/kyc-aml.port';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

interface Subject extends GateBorrower { customer: Customer }
interface Screened { subject: Subject; result: AmlScreeningResult; reused: boolean }
type AppRef = Pick<LoanApplication, 'id' | 'orgId' | 'version'>;

/**
 * G1 AML хаалт (docs/01 §4, FR-3.4; docs/05-compliance-aml.md §5 «blocking=true үед origination хүсэлтийг үргэлжлүүлэхгүй»).
 *  1. `screenForSubmit` — түгжээний ГАДНА (HTTP-г мөрийн түгжээн дор хийхгүй): оролцогч бүрийг kyc-ээр шалгах/дахин ашиглаад
 *     `application_aml_screening`-д хадгалж (аудиттай), блоклосон бол шууд татгалзана. kyc-ийн аливаа алдаа → юу ч хадгалахгүй, 503 (fail-closed).
 *  2. `assertClear` — `ApplicationStateMachine` түгжээн дотор: ОДООГИЙН оролцогч бүрт хадгалсан, блоклохгүй, харилцагчийн сүүлийн өөрчлөлтөөс хойшхи шалгалт байх
 *     (урьдчилсан шалгалтын дараа нэмэгдсэн/засагдсан оролцогч → 409 `AML_SCREENING_STALE`). SYSTEM шилжилт ч үүнийг тойрохгүй.
 */
@Injectable()
export class AmlGateService {
  private readonly logger = new Logger(AmlGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrgSettings,
    private readonly clock: Clock,
    @Inject(KYC_AML_PORT) private readonly kyc: KycAmlPort,
  ) {}

  async screenForSubmit(ctx: RequestContext, app: AppRef): Promise<void> {
    const subjects = await this.subjects(this.prisma, app.id);
    if (!subjects.length) reject(evaluateAmlGate([], []));
    const reuseHours = await this.settings.get(app.orgId, 'aml.screening_reuse_hours');
    const screened = await Promise.all(uniqueSubjects(subjects).map((s) => this.screenOne(ctx, app.id, s, reuseHours)));
    const rows = await this.persist(ctx, app, screened);
    reject(evaluateAmlGate(subjects, rows));
  }

  async assertClear(tx: Tx, applicationId: string): Promise<void> {
    const [subjects, rows] = await Promise.all([this.subjects(tx, applicationId), tx.applicationAmlScreening.findMany({ where: { applicationId } })]);
    reject(evaluateAmlGate(subjects, rows.map(toGateScreening)));
  }

  // ── дотоод ──────────────────────────────────────────────────────────────────────────
  private async subjects(db: Tx | PrismaService, applicationId: string): Promise<Subject[]> {
    const borrowers = await db.loanApplicationBorrower.findMany({ where: { applicationId }, include: { customer: true }, orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }] });
    return borrowers.map((b) => ({ customerId: b.customerId, role: b.role as BorrowerRole, customerUpdatedAt: b.customer.updatedAt, customer: b.customer }));
  }

  /**
   * `s.customerUpdatedAt` нь kyc-д илгээх subject-ийг бүтээсэн ЯГ тэр уншилтынх (snapshot) — хадгалагдаж, түгжээн дотор одоогийнхтой тэнцүү эсэхийг шалгана.
   * Цэвэр шалгалтыг дахин ашиглахад origination-д тухайн screening-ийн ижил snapshot хадгалагдсан байх ёстой (`shouldReuseScreening`).
   */
  private async screenOne(ctx: RequestContext, applicationId: string, s: Subject, reuseHours: number): Promise<Screened> {
    const latest = await this.kyc.latest(ctx, s.customerId);
    if (latest) {
      const attested = await this.prisma.applicationAmlScreening.findFirst({ where: { orgId: ctx.orgId, customerId: s.customerId, screeningId: latest.id }, select: { customerUpdatedAt: true } });
      if (shouldReuseScreening(latest, attested?.customerUpdatedAt ?? null, s.customerUpdatedAt, this.clock.now(), reuseHours)) return { subject: s, result: latest, reused: true };
    }
    const result = await this.kyc.screen(ctx, {
      orgId: ctx.orgId, customerId: s.customerId, applicationId, borrowerRole: s.role, trigger: 'APPLICATION', subject: toAmlSubject(s.customer, customerRegisterNo(s.customer)),
    });
    return { subject: s, result, reused: false };
  }

  /** Нэг богино транзакцад: хүсэлт × харилцагч тутамд сүүлийн шийдвэрийг upsert + `AML_SCREENED` аудит (регистр, нэргүй). */
  private async persist(ctx: RequestContext, app: AppRef, screened: readonly Screened[]): Promise<GateScreening[]> {
    const checkedAt = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      for (const { subject, result, reused } of screened) {
        const facts = { screeningId: result.id, status: result.status, blocking: result.blocking, riskLevel: result.riskLevel, hitCount: result.hits.length, reused };
        const data = {
          ...facts, borrowerRole: subject.role, riskScore: Math.round(result.riskScore), listVersions: result.listVersions, screenedAt: new Date(result.screenedAt),
          applicationVersion: app.version, checkedAt, checkedBy: ctx.userId, customerUpdatedAt: subject.customerUpdatedAt,
        };
        await tx.applicationAmlScreening.upsert({
          where: { applicationId_customerId: { applicationId: app.id, customerId: subject.customerId } },
          create: { orgId: app.orgId, applicationId: app.id, customerId: subject.customerId, ...data },
          update: data,
        });
        await recordAudit(tx, {
          orgId: app.orgId, entity: 'LOAN_APPLICATION', entityId: app.id, action: 'AML_SCREENED', actorId: ctx.userId, applicationId: app.id, correlationId: ctx.correlationId,
          afterJson: { customerId: subject.customerId, role: subject.role, ...facts, listVersions: result.listVersions },
        });
      }
    }, TX_OPTIONS);
    this.logger.log({ op: 'aml.screened', applicationId: app.id, subjects: screened.length, blocking: screened.filter((s) => s.result.blocking).length, correlationId: ctx.correlationId });
    return screened.map(({ subject, result }) => ({ customerId: subject.customerId, screeningId: result.id, status: result.status, blocking: result.blocking, customerUpdatedAt: subject.customerUpdatedAt }));
  }
}

/** Хаалт хаалттай бол `DomainError` шиднэ (`details.borrowers` = асуудалтай оролцогчид; регистр, нэргүй). */
function reject(verdict: AmlGateVerdict): void {
  if (verdict.ok) return;
  throw new DomainError(verdict.code, verdict.message, verdict.httpStatus, { borrowers: verdict.issues, retryable: verdict.code === 'AML_SCREENING_STALE' });
}

const toGateScreening = (r: { customerId: string; screeningId: string; status: string; blocking: boolean; customerUpdatedAt: Date }): GateScreening => ({
  customerId: r.customerId, screeningId: r.screeningId, status: r.status as ScreeningStatus, blocking: r.blocking, customerUpdatedAt: r.customerUpdatedAt,
});
