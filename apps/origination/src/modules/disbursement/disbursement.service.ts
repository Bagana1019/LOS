import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { AccountOwnerType, DisbursementStatus, DisbursementView, RepaymentType, RequestContext, UpdateDisbursementRequest } from '@los/contracts';
import { decryptedField, encryptedField, recordAudit } from '@los/database';
import { Clock, DomainError, systemContext } from '@los/nest-common';
import type { DisbursementRequest, LoanApplication, Prisma } from '.prisma/client-origination';
import { BANK_GATEWAY } from '../../integrations/bank-transfer/bank-transfer.provider';
import type { BankGatewayPort } from '../../integrations/bank-transfer/bank-transfer.client';
import { CORE_LOAN_PORT } from '../../integrations/core-loan/core-loan.provider';
import { CORE_CALL_TIMEOUT_MS, CoreLoanError, type CoreLoanPort } from '../../integrations/core-loan/core-loan.port';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { DomainEvents } from '../../shared/domain-events';
import { ApplicationStateMachine } from '../application/application-state-machine';
import { selectLevels } from '../approval/approval.rules';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { NotificationService } from '../notification/notification.service';
import {
  amountWithinApproved, assertCoreTiming, evaluateGate, isNotFoundDefinitive, maskAccount, NOT_FOUND_MIN_LOOKUPS, parseSettleSeconds, reconcile, recordNotFound, settleAnchor,
  type CoreSettlePolicy, type DecisionTerms, type NotFoundEvidence, type ReconDiff,
} from './disbursement.rules';

export const ACCOUNT_AAD = 'disbursement.account_no';
const TX = { timeout: 20_000, maxWait: 10_000 };
/**
 * H1: Core lease. Lease эзэмшигчийн хамгийн урт ажил = findLoan 15с + openLoan 15с (Core timeout, CLAUDE.md §3.1) + tx maxWait 10с + tx 20с ≈ 60с;
 * 120с нь үүнээс дээш тул хүчинтэй lease-тэй мөрийг өөр pod/sweeper авахгүй. Бизнесийн утга биш — техникийн хязгаар.
 */
export const CORE_LEASE_MS = 120_000;
/** H1: lease эхэлснээс хойш openLoan-ийг эхлүүлж болох сүүлийн мөч (105с). Модуль ачаалахад инвариантыг шалгана. */
export const CORE_SEND_DEADLINE_MS = assertCoreTiming(CORE_LEASE_MS, CORE_CALL_TIMEOUT_MS);
/** Үр дүн нь тодорхой Core алдаа (данс нээгдээгүй нь баталгаатай) → FAILED. Бусад (timeout, сүлжээ, 5xx) → тодорхойгүй: APPROVED хэвээр. */
const DEFINITIVE_CORE_ERRORS = new Set(['CORE_REJECTED', 'NOT_IMPLEMENTED']);
/**
 * H1: Core idempotency key = `<disbursement_request.id>:<илгээсэн дугаар>`. Буцааж (DRAFT) дахин илгээх бүрт шинэ түлхүүр —
 * өмнөх оролдлогын (өөр дүн/данстай байж болох) Core дансыг шинэ оролдлого руу хэзээ ч холбохгүй.
 */
export function coreKey(row: Pick<DisbursementRequest, 'id' | 'historyJson'>): string {
  const submits = (Array.isArray(row.historyJson) ? (row.historyJson as unknown as HistoryEntry[]) : []).filter((h) => h.action === 'SUBMITTED').length;
  return `${row.id}:${Math.max(submits, 1)}`;
}
/** Тодорхой (completion / reject → DRAFT) үед H1 нотолгоог цэвэрлэнэ. */
const CLEAR_EVIDENCE = { coreUnknownAt: null, coreNotFoundCount: 0, coreNotFoundAt: null } as const;
const VISIBLE = ['APPROVED', 'DISBURSING', 'ACTIVE'];
const num = (d: { toString(): string } | null | undefined): number => (d == null ? 0 : Number(d.toString()));
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** Мэдэгдлийн хүлээн авагчаас хоосон утга болон үйлдэл хийсэн хүнийг (өөртөө мэдэгдэхгүй) хасна. */
const others = (ids: ReadonlyArray<string | null | undefined>, self: string | null | undefined): string[] => ids.filter((id): id is string => !!id && id !== self);

interface HistoryEntry { at: string; by: string | null; action: string; note: string | null }
interface Snapshot {
  decision: DecisionTerms; scheduleCurrent: boolean; requiresCollateral: boolean;
  contractSigned: boolean; hasDecision: boolean; hasLetter: boolean;
  collaterals: Array<{ registryNo: string | null; releasedAt: Date | null }>;
}

/**
 * FR-12 · олголтын хүсэлт. Төлөв: DRAFT → (G4) SUBMITTED → (G5, батлагч) APPROVED[core lease] → Core findLoan/openLoan → SENT_TO_CORE + хүсэлт ACTIVE;
 * Core алдаа/олдоогүй → FAILED (дахин зөвшөөрөх эсвэл буцаах). APPROVED гацвал reconcile / sweeper (H1).
 * Хүсэлтийн төлөв солих бүх шилжилт `ApplicationStateMachine.apply()`-аар. Core дуудлага нь DB транзакцаас гадуур (idempotencyKey = `coreKey`).
 */
@Injectable()
export class DisbursementService {
  private readonly logger = new Logger(DisbursementService.name);
  /** H1: "олдсонгүй" баталгаатай болох нөхцөл — settle цонх (env), N лавлагаа, лавлагаа хоорондын зай = lease. */
  private readonly settle: CoreSettlePolicy = {
    settleMs: parseSettleSeconds(process.env.DISBURSEMENT_CORE_SETTLE_SECONDS) * 1000, minLookups: NOT_FOUND_MIN_LOOKUPS, lookupSpacingMs: CORE_LEASE_MS,
  };
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly machine: ApplicationStateMachine,
    private readonly events: DomainEvents,
    private readonly erp: ErpSyncService,
    private readonly notifications: NotificationService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(BANK_GATEWAY) private readonly bank: BankGatewayPort,
    @Inject(CORE_LOAN_PORT) private readonly core: CoreLoanPort,
  ) {}

  // ── FR-12.1 карт ──
  async get(ctx: RequestContext, applicationId: string): Promise<DisbursementView> {
    const app = await this.access.load(ctx, applicationId, 'read');
    if (!VISIBLE.includes(app.status)) throw new ConflictException({ code: 'DISBURSEMENT_NOT_AVAILABLE', message: 'Олголтын хүсэлт нь батлагдсан хүсэлтэд л байна', details: { status: app.status } });
    return this.view(app, await this.prisma.disbursementRequest.findUnique({ where: { applicationId } }));
  }

  /** Олгох дүн, огноо, данс засна (зөвхөн DRAFT). Дансны нэр-дугаар тулгалтыг банкны API-аар (mock) хийнэ. */
  async update(ctx: RequestContext, applicationId: string, input: UpdateDisbursementRequest): Promise<DisbursementView> {
    const app0 = await this.access.load(ctx, applicationId, 'write');
    if (app0.status !== 'APPROVED') throw new ConflictException({ code: 'DISBURSEMENT_NOT_EDITABLE', message: 'Олголтын хүсэлтийг "Батлагдсан" төлөвт л засна', details: { status: app0.status } });
    const existing = await this.prisma.disbursementRequest.findUnique({ where: { applicationId } });
    if (existing && existing.status !== 'DRAFT') throw new ConflictException({ code: 'DISBURSEMENT_NOT_EDITABLE', message: 'Илгээсэн олголтын хүсэлтийг засах боломжгүй', details: { status: existing.status } });

    const approved = num(app0.amount);
    if (input.disburseAmount !== undefined && !amountWithinApproved(input.disburseAmount, approved)) throw new DomainError('DISBURSE_EXCEEDS_APPROVED', `Олгох дүн батлагдсан дүнгээс (${approved}) хэтэрч болохгүй (BR-10)`, 400, { approved, requested: input.disburseAmount });

    const prevAccountNo = existing?.accountNoEncrypted ? decryptedField(existing.accountNoEncrypted, ACCOUNT_AAD) : null;
    const bankCode = input.bankCode ?? existing?.bankCode ?? null;
    const accountNo = input.accountNo ?? prevAccountNo;
    const holderName = input.holderName ?? existing?.holderName ?? null;
    const accountChanged = bankCode !== (existing?.bankCode ?? null) || accountNo !== prevAccountNo || holderName !== (existing?.holderName ?? null);
    let nameCheck: Record<string, unknown> | undefined;
    if (bankCode && accountNo && holderName && (accountChanged || !existing?.nameCheckJson)) {
      try {
        const r = await this.bank.nameCheck({ bankCode, accountNo, holderName });
        nameCheck = { matched: r.matched, registeredName: r.registeredName, similarity: r.similarity, checkedAt: this.clock.now().toISOString() };
      } catch (e) {
        this.logger.warn({ event: 'disbursement.name_check_failed', applicationId, correlationId: ctx.correlationId, error: (e as Error).name });
        throw new DomainError('BANK_UNAVAILABLE', 'Банкны дансны нэр шалгах үйлчилгээ түр ажиллахгүй байна', 502);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      if (app.status !== 'APPROVED') throw new ConflictException({ code: 'DISBURSEMENT_NOT_EDITABLE', message: 'Хүсэлтийн төлөв өөрчлөгдсөн байна' });
      const snap = await this.snapshot(tx, app);
      let row = await tx.disbursementRequest.findUnique({ where: { applicationId } });
      if (row && row.status !== 'DRAFT') throw new ConflictException({ code: 'DISBURSEMENT_NOT_EDITABLE', message: 'Илгээсэн олголтын хүсэлтийг засах боломжгүй' });
      if (!row) {
        row = await tx.disbursementRequest.create({ data: {
          orgId: ctx.orgId, applicationId, approvedAmount: snap.decision.amount, disburseAmount: snap.decision.amount, termMonths: snap.decision.termMonths, interestRate: snap.decision.interestRate,
          repaymentType: snap.decision.repaymentType, firstPaymentDate: snap.decision.firstPaymentDate ? new Date(snap.decision.firstPaymentDate) : null, status: 'DRAFT',
          historyJson: [] as never, createdBy: ctx.userId, updatedBy: ctx.userId,
        } });
      }
      const history = this.history(row, ctx, 'DRAFT_UPDATED', null);
      await tx.disbursementRequest.update({ where: { id: row.id }, data: {
        ...(input.disburseAmount !== undefined ? { disburseAmount: input.disburseAmount } : {}),
        ...(input.disburseDate !== undefined ? { disburseDate: new Date(input.disburseDate) } : {}),
        ...(bankCode ? { bankCode } : {}), ...(holderName ? { holderName } : {}),
        ...(input.accountNo !== undefined ? { accountNoEncrypted: encryptedField(input.accountNo, ACCOUNT_AAD) } : {}),
        accountOwnerType: input.accountOwnerType ?? row.accountOwnerType ?? (bankCode && accountNo ? 'SELF' : null),
        ...(nameCheck ? { nameCheckJson: nameCheck as never } : {}), historyJson: history as never, updatedBy: ctx.userId,
      } });
      // Дансны бүтэн дугаар аудитад орохгүй
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: row.id, action: 'DISBURSEMENT_DRAFT_UPDATED', actorId: ctx.userId, afterJson: { disburseAmount: input.disburseAmount ?? null, disburseDate: input.disburseDate ?? null, bankCode, accountMasked: maskAccount(accountNo), nameCheckMatched: (nameCheck?.matched as boolean | undefined) ?? null }, applicationId, correlationId: ctx.correlationId });
    }, TX);
    return this.get(ctx, applicationId);
  }

  // ── G4: илгээх ──
  async submit(ctx: RequestContext, applicationId: string): Promise<DisbursementView> {
    await this.access.load(ctx, applicationId, 'write');
    await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      const row = await tx.disbursementRequest.findUnique({ where: { applicationId } });
      if (!row || row.status !== 'DRAFT') throw new ConflictException({ code: 'DISBURSEMENT_NOT_DRAFT', message: 'Олголтын хүсэлтийн ноорог алга эсвэл аль хэдийн илгээсэн байна' });
      const checks = evaluateGate(this.gateInput(app, row, await this.snapshot(tx, app)));
      const bad = checks.filter((c) => !c.ok);
      if (bad.length) throw new DomainError('DISBURSEMENT_GATE_FAILED', 'Олголтын хүсэлт илгээх нөхцөл (G4) хангагдаагүй байна', 422, { failed: bad });
      await this.machine.apply(tx, ctx, applicationId, 'DISBURSING', { via: 'USER' });
      await tx.disbursementRequest.update({ where: { id: row.id }, data: { status: 'SUBMITTED', historyJson: this.history(row, ctx, 'SUBMITTED', null) as never, updatedBy: ctx.userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: row.id, action: 'DISBURSEMENT_SUBMITTED', actorId: ctx.userId, applicationId, correlationId: ctx.correlationId });
      // F5-12: батлагчдад "олголт хүлээж байна" — төлвийн өөрчлөлттэй нэг транзакцид; илгээгчид өөрт нь мэдэгдэхгүй.
      await this.notifications.notifyUsers({ orgId: ctx.orgId, userIds: others(await this.approverCandidates(tx, app), ctx.userId), type: 'DISBURSEMENT_SUBMITTED', applicationId, payload: this.notePayload(app, row) }, tx);
    }, TX);
    return this.get(ctx, applicationId);
  }

  // ── G5: зөвшөөрөх → Core ──
  /**
   * H1 (FR-12.5): Core данс нээх нь давхардахгүй, сэргээгдэх урсгал.
   * 1) Lease авах (CAS): SUBMITTED|FAILED|хугацаа хэтэрсэн APPROVED → APPROVED + core_requested_at=now. Lease-ийг нэг л дуудагч эзэмшинэ (олон pod-д ч).
   * 2) Core: эхлээд `findLoan(coreKey)`; байхгүй бол л `openLoan` (idempotencyKey = coreKey). openLoan дуудаж болох зам бүрт G5 дахин шалгана.
   * 3) Дуусгах транзакц `status=APPROVED AND core_requested_at=<lease>` fencing-тэй. Алдвал мөр APPROVED хэвээр → reconcile / sweeper дуусгана.
   * Хугацаа хэтэрсэн APPROVED-г дахин зөвшөөрвөл `APPROVE_RETRY` түүх (хэн) бичнэ.
   */
  async approve(ctx: RequestContext, applicationId: string, comment?: string): Promise<DisbursementView> {
    await this.access.load(ctx, applicationId, 'read');
    const { row, app, lease } = await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      const row = await tx.disbursementRequest.findUnique({ where: { applicationId } });
      if (!row || !['SUBMITTED', 'FAILED', 'APPROVED'].includes(row.status)) throw new ConflictException({ code: 'DISBURSEMENT_NOT_PENDING', message: 'Зөвшөөрөх олголтын хүсэлт алга', details: { status: row?.status ?? null } });
      if (app.status !== 'DISBURSING') throw new ConflictException({ code: 'DISBURSEMENT_NOT_PENDING', message: 'Хүсэлтийн төлөв "Олгож байна" биш байна', details: { status: app.status } });
      const recovering = row.status === 'APPROVED';
      if (recovering && this.leaseActive(row)) throw this.inProgress();
      const submittedBy = this.lastSubmitter(row);
      if (submittedBy && submittedBy === ctx.userId) throw new ForbiddenException({ code: 'SELF_APPROVAL', message: 'Өөрийн илгээсэн олголтыг өөрөө зөвшөөрөх боломжгүй' });
      // openLoan дуудагдаж болох тул G5-ийг үргэлж (сэргээлтэд ч) шалгана. Core-д данс аль хэдийн байвал G5-гүй замаар: reconcile.
      const bad = evaluateGate(this.gateInput(app, row, await this.snapshot(tx, app))).filter((c) => !c.ok);
      if (bad.length) throw new DomainError('DISBURSEMENT_GATE_FAILED', 'Олголт зөвшөөрөх нөхцөл (G5) хангагдаагүй байна', 422, { failed: bad });
      const lease = this.clock.now();
      const res = await tx.disbursementRequest.updateMany({
        where: { id: row.id, status: row.status, ...(recovering ? { coreRequestedAt: row.coreRequestedAt } : {}) },
        // H1: шинэ нотолгооны үе openLoan-ийг бодитоор илгээхийн өмнөх fenced тамгаар (`stampSend`) эхэлнэ — claim-аар биш.
        // Хугацаа хэтэрсэн lease-ийг орлох нь claimStale-тэй ижил: тэр lease дор илгээгдэж болсон openLoan-ийн settle эхлэлийг хадгална.
        data: { status: 'APPROVED', coreRequestedAt: lease, ...(recovering ? { coreUnknownAt: settleAnchor(row.coreUnknownAt, row.coreRequestedAt, lease, CORE_LEASE_MS) } : {}), updatedBy: ctx.userId, historyJson: this.history(row, ctx, recovering ? 'APPROVE_RETRY' : 'APPROVED', comment ?? null) as never },
      });
      if (res.count !== 1) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтын төлөв өөрчлөгдсөн байна, дахин ачаална уу' });
      return { row, app, lease };
    }, TX);
    await this.runCore(ctx, row, app, lease, { allowOpen: true, note: null });
    return this.get(ctx, applicationId);
  }

  /**
   * H1: Core-оос лавлагаагаар шалгаж дуусгана; хэзээ ч данс НЭЭХГҮЙ (G5 шаардахгүй).
   * APPROVED (lease хэтэрсэн/суллагдсан): олдвол дуусгана, олдохгүй бол FAILED. FAILED: олдвол дуусгана, олдохгүй бол FAILED хэвээр.
   */
  async reconcile(ctx: RequestContext, applicationId: string): Promise<DisbursementView> {
    await this.access.load(ctx, applicationId, 'read');
    const row = await this.prisma.disbursementRequest.findUnique({ where: { applicationId } });
    if (!row || !['APPROVED', 'FAILED'].includes(row.status)) throw new ConflictException({ code: 'DISBURSEMENT_NOT_RECONCILABLE', message: 'Сэргээх (Core-д илгээгдээд дуусаагүй) олголт алга', details: { status: row?.status ?? null } });
    if (row.status === 'FAILED') return this.reconcileFailed(ctx, row);
    if (this.leaseActive(row)) throw this.inProgress();
    const lease = await this.claimStale(row, ctx.userId);
    if (!lease) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтын төлөв өөрчлөгдсөн байна, дахин ачаална уу' });
    const app = await this.prisma.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
    const settling = await this.runCore(ctx, row, app, lease, { allowOpen: false, note: 'RECONCILED' });
    if (settling) throw this.settlingError(settling);
    return this.get(ctx, applicationId);
  }

  /** H1 sweeper: олон pod-д аюулгүй — мөр бүрийг CAS lease-ээр авна (нэг л pod ялна). Буцаах утга = авсан мөрийн тоо. */
  async reconcileStale(limit = 50): Promise<number> {
    const staleBefore = new Date(this.clock.now().getTime() - CORE_LEASE_MS);
    const rows = await this.prisma.disbursementRequest.findMany({
      where: { status: 'APPROVED', OR: [{ coreRequestedAt: null }, { coreRequestedAt: { lt: staleBefore } }] },
      orderBy: { coreRequestedAt: 'asc' }, take: limit,
    });
    let claimed = 0;
    for (const row of rows) {
      const lease = await this.claimStale(row, null);
      if (!lease) continue;
      claimed += 1;
      const app = await this.prisma.loanApplication.findUniqueOrThrow({ where: { id: row.applicationId } });
      await this.runCore(systemContext(row.orgId), row, app, lease, { allowOpen: false, note: 'RECONCILED' }).catch((e: unknown) => {
        this.logger.warn({ event: 'disbursement.reconcile_failed', disbursementId: row.id, error: e instanceof DomainError ? e.code : (e as Error).name });
      });
    }
    return claimed;
  }

  /** Батлагч буцаана: олголт → DRAFT, хүсэлт DISBURSING → APPROVED. Тайлбар заавал. FAILED бол Core-д данс нээгдээгүйг эхлээд баталгаажуулна (H1). */
  async reject(ctx: RequestContext, applicationId: string, comment?: string): Promise<DisbursementView> {
    await this.access.load(ctx, applicationId, 'read');
    if (!comment?.trim()) throw new DomainError('COMMENT_REQUIRED', 'Буцаахдаа тайлбар бичих шаардлагатай', 400);
    const pre = await this.prisma.disbursementRequest.findUnique({ where: { applicationId } });
    if (pre?.status === 'FAILED') await this.assertNoCoreLoan(pre, applicationId, ctx);
    await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      const row = await tx.disbursementRequest.findUnique({ where: { applicationId } });
      if (!row || !['SUBMITTED', 'FAILED'].includes(row.status) || app.status !== 'DISBURSING') throw new ConflictException({ code: 'DISBURSEMENT_NOT_PENDING', message: 'Буцаах олголтын хүсэлт алга' });
      // Core шалгасны дараа өөр хэн нэгэн дахин оролдсон бол (updatedAt өөрчлөгдсөн) буцаахгүй.
      if (row.status === 'FAILED' && row.updatedAt.getTime() !== pre?.updatedAt.getTime()) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтын төлөв өөрчлөгдсөн байна, дахин ачаална уу' });
      await this.machine.apply(tx, ctx, applicationId, 'APPROVED', { via: 'SYSTEM', reason: comment });
      await tx.disbursementRequest.update({ where: { id: row.id }, data: { status: 'DRAFT', coreRequestedAt: null, ...CLEAR_EVIDENCE, historyJson: this.history(row, ctx, 'REJECTED', comment) as never, updatedBy: ctx.userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: row.id, action: 'DISBURSEMENT_REJECTED', actorId: ctx.userId, afterJson: { comment }, applicationId, correlationId: ctx.correlationId });
      // F5-12: илгээгч (maker)-д батлагчийн тайлбартай; батлагч өөрөө илгээгч байсан бол өөрт нь мэдэгдэхгүй.
      await this.notifications.notifyUsers({ orgId: ctx.orgId, userIds: others([this.lastSubmitter(row)], ctx.userId), type: 'DISBURSEMENT_REJECTED', applicationId, payload: this.notePayload(app, row, comment) }, tx);
    }, TX);
    return this.get(ctx, applicationId);
  }

  // ── F5-12: олголтын мэдэгдэл (хонх) ──
  /** Олголтыг сүүлд илгээсэн хэрэглэгч (maker) = түүхийн сүүлийн SUBMITTED. */
  private lastSubmitter(row: Pick<DisbursementRequest, 'historyJson'>): string | null {
    const history = Array.isArray(row.historyJson) ? (row.historyJson as unknown as HistoryEntry[]) : [];
    return history.filter((h) => h.action === 'SUBMITTED').at(-1)?.by ?? null;
  }

  /**
   * Олголтыг зөвшөөрч болох хүмүүс. Origination-д iam дүрийн лавлах байхгүй (DECISIONS 2026-11-03, approval.notifyLevel-тэй ижил хязгаар) тул
   * мэдэгдэж буй батлагчдыг авна: хүсэлтэд хамаарах түвшний (BR-13) userId гишүүд + энэ хүсэлтэд санал өгсөн батлагчид.
   * Дүрээр томилогдсон, санал өгөөгүй батлагч энд орохгүй — тэд олголтыг хүсэлтийн "Олгох" табаас олно.
   */
  private async approverCandidates(tx: Tx, app: LoanApplication): Promise<Array<string | null>> {
    const pool = await tx.approvalLevel.findMany({ where: { orgId: app.orgId, OR: [{ productId: null }, ...(app.productId ? [{ productId: app.productId }] : [])] }, include: { members: true } });
    const levels = selectLevels(pool.map((l) => ({ ...l, amountFrom: num(l.amountFrom), amountTo: l.amountTo == null ? null : num(l.amountTo) })), num(app.amount), app.productId);
    const voters = await tx.approvalVote.findMany({ where: { orgId: app.orgId, request: { applicationId: app.id } }, select: { approverId: true } });
    return [...levels.flatMap((l) => l.members.map((m) => m.userId)), ...voters.map((v) => v.approverId)];
  }

  /** Мэдэгдлийн загварт орох утгууд (дансны дугаар, нэр зэрэг хувийн мэдээлэл ОРУУЛАХГҮЙ). */
  private notePayload(app: LoanApplication, row: DisbursementRequest, comment: string | null = null) {
    return { applicationNo: app.appNo, amount: num(row.disburseAmount), currency: app.currency, comment };
  }

  // ── H1 дотоод: Core lease ──
  private leaseActive(row: Pick<DisbursementRequest, 'coreRequestedAt'>): boolean {
    return !!row.coreRequestedAt && this.clock.now().getTime() - row.coreRequestedAt.getTime() < CORE_LEASE_MS;
  }

  private inProgress(): ConflictException {
    return new ConflictException({ code: 'DISBURSEMENT_CORE_IN_PROGRESS', message: 'Core руу илгээж байна — түр хүлээгээд дахин оролдоно уу' });
  }

  private settlingError(e: NotFoundEvidence): ConflictException {
    const settleUntil = e.unknownAt ? new Date(e.unknownAt.getTime() + this.settle.settleMs).toISOString() : null;
    return new ConflictException({
      code: 'DISBURSEMENT_CORE_SETTLING',
      message: 'Core-ийн хариу тодорхойгүй хэвээр — Core боловсруулж дуусахыг хүлээж байна. Одоогоор "амжилтгүй" гэж үзэх, буцаах боломжгүй; дараа дахин шалгана уу',
      details: { settleUntil, lookups: e.notFoundCount, required: this.settle.minLookups },
    });
  }

  /** openLoan илгээгдэж болох мөч = шинэ нотолгооны үе (тоолуур 0). */
  private newEpisode(at: Date) {
    return { coreUnknownAt: at, coreNotFoundCount: 0, coreNotFoundAt: null };
  }

  /**
   * H1: openLoan-ийн өмнөх сүүлийн алхам. Lease-ийн хугацаа send deadline-аас хэтэрсэн, эсвэл lease алдсан (fenced update 0 мөр) бол
   * ИЛГЭЭХГҮЙ (409 in-progress). Амжилттай бол шинэ нотолгооны үе = илгээх мөч. DB бичилт удааширч болох тул deadline-ийг дахин шалгана.
   */
  private async stampSend(id: string, lease: Date): Promise<void> {
    const late = () => this.clock.now().getTime() - lease.getTime() > CORE_SEND_DEADLINE_MS;
    if (late()) throw this.sendAborted(id, 'deadline');
    const res = await this.prisma.disbursementRequest.updateMany({ where: { id, status: 'APPROVED', coreRequestedAt: lease }, data: this.newEpisode(this.clock.now()) });
    if (res.count !== 1) throw this.sendAborted(id, 'lease_lost');
    if (late()) throw this.sendAborted(id, 'deadline'); // тамга бичсэн ч илгээгээгүй — консерватив, хор хөнөөлгүй
  }

  private sendAborted(id: string, reason: 'deadline' | 'lease_lost'): ConflictException {
    this.logger.warn({ event: 'disbursement.core_send_aborted', disbursementId: id, reason });
    return this.inProgress();
  }

  private evidence(row: Pick<DisbursementRequest, 'coreUnknownAt' | 'coreNotFoundCount' | 'coreNotFoundAt'>): NotFoundEvidence {
    return { unknownAt: row.coreUnknownAt, notFoundCount: row.coreNotFoundCount, lastNotFoundAt: row.coreNotFoundAt };
  }

  /**
   * Хугацаа хэтэрсэн APPROVED мөрийн lease-ийг CAS-аар авна (fencing: хуучин core_requested_at). Ялагдвал null.
   * Өмнөх эзэмшигч openLoan илгээгээд унасан/хөлдсөн байж болох тул settle эхлэл = `settleAnchor`. Нотолгооны тоолуурыг ХЭЗЭЭ Ч тэглэхгүй (lookup-only).
   */
  private async claimStale(row: DisbursementRequest, actorId: string | null): Promise<Date | null> {
    const lease = this.clock.now();
    const res = await this.prisma.disbursementRequest.updateMany({ where: { id: row.id, status: 'APPROVED', coreRequestedAt: row.coreRequestedAt }, data: { coreRequestedAt: lease, coreUnknownAt: settleAnchor(row.coreUnknownAt, row.coreRequestedAt, lease, CORE_LEASE_MS), updatedBy: actorId } });
    return res.count === 1 ? lease : null;
  }

  /** Core лавлагаа (зөвхөн унших). Тодорхойгүй хариу → 502 CORE_LOOKUP_FAILED (төлөв өөрчлөхгүй). */
  private async lookupOrFail(row: Pick<DisbursementRequest, 'id' | 'historyJson'>, applicationId: string, ctx: RequestContext): Promise<string | null> {
    try {
      return (await this.core.findLoan(coreKey(row)))?.coreLoanId ?? null;
    } catch (e) {
      this.logger.warn({ event: 'disbursement.core_lookup_failed', applicationId, disbursementId: row.id, code: e instanceof CoreLoanError ? e.code : 'CORE_UNAVAILABLE', correlationId: ctx.correlationId });
      throw new DomainError('CORE_LOOKUP_FAILED', 'Core-оос олголтын төлөв шалгаж чадсангүй — дараа дахин оролдоно уу', 502);
    }
  }

  /** Буцаахаас өмнө: Core-д данс байвал 409; тодорхойгүй үр дүнтэй мөрт "олдсонгүй" баталгаатай болтол 409 DISBURSEMENT_CORE_SETTLING (H1). */
  private async assertNoCoreLoan(row: DisbursementRequest, applicationId: string, ctx: RequestContext): Promise<void> {
    if (await this.lookupOrFail(row, applicationId, ctx)) throw new ConflictException({ code: 'DISBURSEMENT_CORE_LOAN_EXISTS', message: 'Core-д зээлийн данс аль хэдийн нээгдсэн тул буцаах боломжгүй — "Сэргээх"-ээр дуусгана уу' });
    const now = this.clock.now();
    const ev = recordNotFound(this.evidence(row), now, this.settle);
    if (isNotFoundDefinitive(ev, now, this.settle)) return; // reject нь нотолгоог цэвэрлэнэ
    if (!(await this.recordSettling(ctx, row, { id: row.id, status: 'FAILED', updatedAt: row.updatedAt }, ev))) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтын төлөв өөрчлөгдсөн байна, дахин ачаална уу' });
    throw this.settlingError(ev);
  }

  /**
   * H1: баталгаагүй "олдсонгүй"-г бүртгэнэ (fenced): тоолуур шинэчилж, түүхэнд `CORE_SETTLING`-ийг зөвхөн анх удаа бичнэ. Төлөв, lease өөрчлөхгүй.
   * Fence алдсан бол false.
   */
  private async recordSettling(ctx: RequestContext, fresh: DisbursementRequest, where: Prisma.DisbursementRequestWhereInput, ev: NotFoundEvidence): Promise<boolean> {
    const first = this.lastEntry(fresh)?.action !== 'CORE_SETTLING';
    if (!first && ev.notFoundCount === fresh.coreNotFoundCount) return true;
    const res = await this.prisma.disbursementRequest.updateMany({ where, data: {
      coreNotFoundCount: ev.notFoundCount, coreNotFoundAt: ev.lastNotFoundAt, updatedBy: ctx.userId,
      ...(first ? { historyJson: this.history(fresh, ctx, 'CORE_SETTLING', null) as never } : {}),
    } });
    return res.count === 1;
  }

  /** Lookup-only "олдсонгүй" (lease эзэмшигч): баталгаатай бол FAILED (null буцаана); үгүй бол APPROVED + lease хэвээр, нотолгоог буцаана. */
  private async notFound(ctx: RequestContext, id: string, applicationId: string, lease: Date): Promise<NotFoundEvidence | null> {
    const fresh = await this.prisma.disbursementRequest.findUniqueOrThrow({ where: { id } });
    const now = this.clock.now();
    const ev = recordNotFound(this.evidence(fresh), now, this.settle);
    if (isNotFoundDefinitive(ev, now, this.settle)) { await this.markFailed(ctx, id, applicationId, lease, 'CORE_NOT_FOUND', 'clear'); return null; }
    await this.recordSettling(ctx, fresh, { id, status: 'APPROVED', coreRequestedAt: lease }, ev);
    return ev;
  }

  /** FAILED: Core-д данс байвал (CAS: FAILED → APPROVED + lease) дуусгана; байхгүй бол юу ч өөрчлөхгүй. */
  private async reconcileFailed(ctx: RequestContext, row: DisbursementRequest): Promise<DisbursementView> {
    const coreLoanId = await this.lookupOrFail(row, row.applicationId, ctx);
    if (!coreLoanId) return this.get(ctx, row.applicationId);
    const lease = this.clock.now();
    const res = await this.prisma.disbursementRequest.updateMany({ where: { id: row.id, status: 'FAILED', updatedAt: row.updatedAt }, data: { status: 'APPROVED', coreRequestedAt: lease, updatedBy: ctx.userId } });
    if (res.count !== 1) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтын төлөв өөрчлөгдсөн байна, дахин ачаална уу' });
    const app = await this.prisma.loanApplication.findUniqueOrThrow({ where: { id: row.applicationId } });
    const customerId = (await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId: app.id, isPrimary: true }, select: { customerId: true } }))?.customerId ?? '';
    await this.completeOrPending(ctx, row.id, app, customerId, coreLoanId, lease, 'RECONCILED');
    return this.get(ctx, row.applicationId);
  }

  /**
   * Lease эзэмшигч Core-г дуудна: lookup → (allowOpen бол) open. Тодорхой Core алдаа → FAILED; тодорхойгүй (timeout, сүлжээ) →
   * APPROVED + lease хэвээр (хугацаагаараа дуусна), core_unknown_at тэмдэглэнэ. Lookup-only "олдсонгүй" → settle дүрэм (`notFound`).
   * Бүгд fenced. Амжилт → complete (fenced). Буцаах утга: settle хүлээж буй бол нотолгоо, бусад үед null.
   */
  private async runCore(ctx: RequestContext, row: DisbursementRequest, app: LoanApplication, lease: Date, o: { allowOpen: boolean; note: string | null }): Promise<NotFoundEvidence | null> {
    const customerId = (await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId: app.id, isPrimary: true }, select: { customerId: true } }))?.customerId ?? '';
    let coreLoanId: string | null;
    let opened = false;
    try {
      coreLoanId = (await this.core.findLoan(coreKey(row)))?.coreLoanId ?? null;
      if (!coreLoanId && o.allowOpen) {
        await this.stampSend(row.id, lease);
        opened = true;
        coreLoanId = (await this.core.openLoan(this.openRequest(row, app, customerId))).coreLoanId;
      }
    } catch (e) {
      if (e instanceof ConflictException) throw e; // илгээгээгүй (stampSend) — төлөв өөрчлөхгүй
      const code = e instanceof CoreLoanError ? e.code : 'CORE_UNAVAILABLE';
      this.logger.warn({ event: 'disbursement.core_failed', applicationId: app.id, disbursementId: row.id, code, correlationId: ctx.correlationId });
      // Энэ оролдлогын openLoan-ийн тодорхой татгалзалт = данс байхгүй нь баталгаатай → нотолгоо цэвэрлэнэ. Lookup-ийн "тодорхой" алдаа данс байгаа эсэхийг хэлэхгүй → хадгална.
      if (DEFINITIVE_CORE_ERRORS.has(code)) await this.markFailed(ctx, row.id, app.id, lease, code, opened ? 'clear' : 'keep');
      else await this.markUnknown(ctx, row.id, app.id, lease, code, opened);
      throw new DomainError('CORE_OPEN_LOAN_FAILED', 'Core-д зээлийн данс нээж чадсангүй — дахин оролдох эсвэл буцаана уу', 502, { code });
    }
    if (!coreLoanId) return this.notFound(ctx, row.id, app.id, lease);
    await this.completeOrPending(ctx, row.id, app, customerId, coreLoanId, lease, o.note);
    return null;
  }

  private async completeOrPending(ctx: RequestContext, id: string, app: LoanApplication, customerId: string, coreLoanId: string, lease: Date, note: string | null): Promise<void> {
    try {
      await this.complete(ctx, id, app, customerId, coreLoanId, lease, note);
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      this.logger.error({ event: 'disbursement.complete_failed', applicationId: app.id, disbursementId: id, correlationId: ctx.correlationId, error: (e as Error).name });
      throw new DomainError('DISBURSEMENT_COMPLETION_PENDING', 'Core-д данс нээгдсэн, LOS-д бүртгэх үлдлээ — автоматаар (эсвэл "Сэргээх"-ээр) дуусгана', 503);
    }
  }

  private openRequest(row: DisbursementRequest, app: LoanApplication, customerId: string) {
    return {
      idempotencyKey: coreKey(row), applicationId: app.id, contractNo: app.contractNo as string, customerId, amount: num(row.disburseAmount), currency: app.currency, termMonths: row.termMonths, interestRate: num(row.interestRate),
      repaymentType: row.repaymentType, disburseDate: ymd(row.disburseDate) as string, firstPaymentDate: ymd(row.firstPaymentDate),
      account: { bankCode: row.bankCode as string, accountNo: decryptedField(row.accountNoEncrypted as string, ACCOUNT_AAD), holderName: row.holderName as string },
    };
  }

  /**
   * Тодорхойгүй Core үр дүн (fenced): APPROVED хэвээр, lease СУЛЛАХГҮЙ — CORE_LEASE_MS-ээр дуусна (Core хүсэлтийг боловсруулж байж болно).
   * openLoan илгээсэн бол шинэ үе: core_unknown_at = одоо, тоолуур 0. Зөвхөн лавлагаа унасан бол core_unknown_at-ийг (хоосон бол л) тавина.
   * Ижил шалтгаан дараалан давтагдвал түүхийг дахин бичихгүй (sweeper-ийн tick бүрт).
   */
  private async markUnknown(ctx: RequestContext, id: string, applicationId: string, lease: Date, code: string, opened: boolean): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.disbursementRequest.findUniqueOrThrow({ where: { id } });
      const last = this.lastEntry(fresh);
      const repeat = last?.action === 'CORE_UNKNOWN' && last.note === code;
      const now = this.clock.now();
      const episode = opened ? { coreUnknownAt: now, coreNotFoundCount: 0, coreNotFoundAt: null } : { coreUnknownAt: fresh.coreUnknownAt ?? now };
      const res = await tx.disbursementRequest.updateMany({ where: { id, status: 'APPROVED', coreRequestedAt: lease }, data: { ...episode, updatedBy: ctx.userId, ...(repeat ? {} : { historyJson: this.history(fresh, ctx, 'CORE_UNKNOWN', code) as never }) } });
      if (res.count !== 1 || repeat) return;
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: id, action: 'DISBURSEMENT_CORE_UNKNOWN', actorId: ctx.userId, afterJson: { code }, applicationId, correlationId: ctx.correlationId });
    }, TX);
  }

  /** FAILED (fenced). `clear` = данс байхгүй нь баталгаатай (reject шууд); `keep` = нотолгоо хадгална, reject settle дүрмийг дахин шалгана. */
  private async markFailed(ctx: RequestContext, id: string, applicationId: string, lease: Date, code: string, evidence: 'clear' | 'keep'): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.disbursementRequest.findUniqueOrThrow({ where: { id } });
      const res = await tx.disbursementRequest.updateMany({ where: { id, status: 'APPROVED', coreRequestedAt: lease }, data: { status: 'FAILED', coreRequestedAt: null, ...(evidence === 'clear' ? CLEAR_EVIDENCE : {}), historyJson: this.history(fresh, ctx, 'CORE_FAILED', code) as never, updatedBy: ctx.userId } });
      if (res.count !== 1) return; // lease алдсан — шинэ эзэмшигчийн төлөвийг дарахгүй
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: id, action: 'DISBURSEMENT_CORE_FAILED', actorId: ctx.userId, afterJson: { code }, applicationId, correlationId: ctx.correlationId });
    }, TX);
  }

  /** SENT_TO_CORE + ACTIVE + event + ERP нэг транзакцид; fencing тул давхар дуусгахгүй. */
  private async complete(ctx: RequestContext, id: string, app: LoanApplication, customerId: string, coreLoanId: string, lease: Date, note: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.disbursementRequest.findUniqueOrThrow({ where: { id } });
      const res = await tx.disbursementRequest.updateMany({ where: { id, status: 'APPROVED', coreRequestedAt: lease }, data: { status: 'SENT_TO_CORE', coreLoanId, ...CLEAR_EVIDENCE, historyJson: this.history(fresh, ctx, 'SENT_TO_CORE', note) as never, updatedBy: ctx.userId } });
      if (res.count !== 1) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтыг өөр процесс дуусгасан байна' });
      await tx.loanApplication.update({ where: { id: app.id }, data: { disbursedAt: this.clock.now() } });
      await this.machine.apply(tx, ctx, app.id, 'ACTIVE', { via: 'SYSTEM' });
      // N4: DWH dimension keys (ids only) in the same outbox row
      await this.events.publish(tx, { type: 'DisbursementApproved', applicationId: app.id, amount: num(fresh.disburseAmount), coreLoanId, branchId: app.branchId, productId: app.productId, customerId: customerId || null }, ctx);
      await this.erp.emitDisbursement({
        orgId: ctx.orgId, branchId: app.branchId, applicationId: app.id, contractNo: app.contractNo, coreLoanId, customerId: customerId || null, sourceId: id, currency: app.currency,
        businessDate: ymd(fresh.disburseDate) as string, amount: num(fresh.disburseAmount), correlationId: ctx.correlationId, actorId: ctx.userId,
      }, { tx });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: id, action: 'DISBURSEMENT_SENT_TO_CORE', actorId: ctx.userId, afterJson: { coreLoanId, reconciled: note === 'RECONCILED' }, applicationId: app.id, correlationId: ctx.correlationId });
    }, TX);
  }

  // ── дотоод ──
  private lastEntry(row: Pick<DisbursementRequest, 'historyJson'>): HistoryEntry | undefined {
    return (Array.isArray(row.historyJson) ? (row.historyJson as unknown as HistoryEntry[]) : []).at(-1);
  }

  private history(row: Pick<DisbursementRequest, 'historyJson'>, ctx: RequestContext, action: string, note: string | null): HistoryEntry[] {
    const prev = Array.isArray(row.historyJson) ? (row.historyJson as unknown as HistoryEntry[]) : [];
    return [...prev, { at: this.clock.now().toISOString(), by: ctx.userId, action, note }];
  }

  private async snapshot(db: PrismaService | Tx, app: LoanApplication): Promise<Snapshot> {
    const [schedule, product, contract, decisions, letters, collaterals] = await Promise.all([
      db.repaymentSchedule.findFirst({ where: { applicationId: app.id }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }] }),
      app.productId ? db.product.findUnique({ where: { id: app.productId } }) : null,
      db.contract.findUnique({ where: { applicationId: app.id } }),
      db.decisionRecord.count({ where: { applicationId: app.id } }),
      db.officialLetter.count({ where: { applicationId: app.id, generatedFileId: { not: null } } }),
      db.collateral.findMany({ where: { applicationId: app.id }, select: { registryNo: true, releasedAt: true } }),
    ]);
    const p = (schedule?.paramsJson ?? {}) as { type?: string; firstPaymentDate?: string; principal?: number; termMonths?: number; annualRate?: number };
    return {
      decision: { amount: num(app.amount), termMonths: app.termMonths ?? 0, interestRate: num(app.interestRate), repaymentType: p.type ?? 'ANNUITY', firstPaymentDate: p.firstPaymentDate ?? null },
      scheduleCurrent: !!schedule && !schedule.isStale && p.principal === num(app.amount) && p.termMonths === app.termMonths,
      requiresCollateral: product?.requiresCollateral ?? false,
      contractSigned: !!contract?.signedFileId, hasDecision: decisions > 0, hasLetter: letters > 0, collaterals,
    };
  }

  private gateInput(app: LoanApplication, row: DisbursementRequest, s: Snapshot) {
    const nc = row.nameCheckJson as { matched?: boolean } | null;
    return {
      applicationStatus: app.status, disburseAmount: num(row.disburseAmount), approvedAmount: num(row.approvedAmount), disburseDate: ymd(row.disburseDate),
      contractSigned: s.contractSigned, hasDecision: s.hasDecision, hasLetter: s.hasLetter,
      account: { bankCode: row.bankCode, accountNo: row.accountNoEncrypted ? '1' : null, holderName: row.holderName, ownerType: row.accountOwnerType },
      nameCheckMatched: nc?.matched ?? null, reconDiffs: this.diffs(row, s), scheduleCurrent: s.scheduleCurrent,
      requiresCollateral: s.requiresCollateral, collaterals: s.collaterals,
    };
  }

  private diffs(row: Pick<DisbursementRequest, 'approvedAmount' | 'termMonths' | 'interestRate' | 'repaymentType' | 'firstPaymentDate'>, s: Snapshot): ReconDiff[] {
    return reconcile(s.decision, { approvedAmount: num(row.approvedAmount), termMonths: row.termMonths, interestRate: num(row.interestRate), repaymentType: row.repaymentType, firstPaymentDate: ymd(row.firstPaymentDate) });
  }

  private async view(app: LoanApplication, row: DisbursementRequest | null): Promise<DisbursementView> {
    const s = await this.snapshot(this.prisma, app);
    const base = row ?? ({ approvedAmount: s.decision.amount, termMonths: s.decision.termMonths, interestRate: s.decision.interestRate, repaymentType: s.decision.repaymentType,
      firstPaymentDate: s.decision.firstPaymentDate ? new Date(s.decision.firstPaymentDate) : null, disburseAmount: s.decision.amount, disburseDate: null, bankCode: null, accountNoEncrypted: null,
      holderName: null, accountOwnerType: null, nameCheckJson: null, status: 'DRAFT', coreLoanId: null, historyJson: [], id: null } as unknown as DisbursementRequest);
    const diffs = this.diffs(base, s);
    const checks = evaluateGate(this.gateInput(app, base, s));
    const nc = base.nameCheckJson as { matched: boolean; registeredName: string | null; similarity: number } | null;
    const account = base.accountNoEncrypted ? decryptedField(base.accountNoEncrypted, ACCOUNT_AAD) : null;
    const status = base.status as DisbursementStatus;
    return {
      id: row?.id ?? null, applicationId: app.id, applicationStatus: app.status, status,
      approvedAmount: num(base.approvedAmount), disburseAmount: num(base.disburseAmount), termMonths: base.termMonths, interestRate: num(base.interestRate),
      repaymentType: base.repaymentType as RepaymentType, firstPaymentDate: ymd(base.firstPaymentDate), disburseDate: ymd(base.disburseDate),
      bankCode: base.bankCode, accountNoMasked: maskAccount(account), holderName: base.holderName, accountOwnerType: base.accountOwnerType as AccountOwnerType | null,
      nameCheck: nc ? { matched: nc.matched, registeredName: nc.registeredName, similarity: nc.similarity } : null,
      reconciliation: { ok: diffs.length === 0, diffs }, coreLoanId: base.coreLoanId,
      checks, canSubmit: status === 'DRAFT' && app.status === 'APPROVED' && checks.every((c) => c.ok),
      history: (Array.isArray(base.historyJson) ? (base.historyJson as unknown as HistoryEntry[]) : []).map((h) => ({ at: h.at, by: h.by, action: h.action, note: h.note })),
    };
  }
}
