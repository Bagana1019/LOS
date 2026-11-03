import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { AccountOwnerType, DisbursementStatus, DisbursementView, RepaymentType, RequestContext, UpdateDisbursementRequest } from '@los/contracts';
import { decryptedField, encryptedField, recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { DisbursementRequest, LoanApplication } from '.prisma/client-origination';
import { BANK_GATEWAY } from '../../integrations/bank-transfer/bank-transfer.provider';
import type { BankGatewayPort } from '../../integrations/bank-transfer/bank-transfer.client';
import { CORE_LOAN_PORT } from '../../integrations/core-loan/core-loan.provider';
import { CoreLoanError, type CoreLoanPort } from '../../integrations/core-loan/core-loan.port';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { DomainEvents } from '../../shared/domain-events';
import { ApplicationStateMachine } from '../application/application-state-machine';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { amountWithinApproved, evaluateGate, maskAccount, reconcile, type DecisionTerms, type ReconDiff } from './disbursement.rules';

export const ACCOUNT_AAD = 'disbursement.account_no';
const TX = { timeout: 20_000, maxWait: 10_000 };
const VISIBLE = ['APPROVED', 'DISBURSING', 'ACTIVE'];
const num = (d: { toString(): string } | null | undefined): number => (d == null ? 0 : Number(d.toString()));
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

interface HistoryEntry { at: string; by: string | null; action: string; note: string | null }
interface Snapshot {
  decision: DecisionTerms; scheduleCurrent: boolean; requiresCollateral: boolean;
  contractSigned: boolean; hasDecision: boolean; hasLetter: boolean;
  collaterals: Array<{ registryNo: string | null; releasedAt: Date | null }>;
}

/**
 * FR-12 · олголтын хүсэлт. Төлөв: DRAFT → (G4) SUBMITTED → (G5, батлагч) APPROVED → Core openLoan → SENT_TO_CORE + хүсэлт ACTIVE.
 * Хүсэлтийн төлөв солих бүх шилжилт `ApplicationStateMachine.apply()`-аар. Core дуудлага нь DB транзакцаас гадуур (idempotencyKey = disbursement_request.id).
 */
@Injectable()
export class DisbursementService {
  private readonly logger = new Logger(DisbursementService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly machine: ApplicationStateMachine,
    private readonly events: DomainEvents,
    private readonly erp: ErpSyncService,
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
    }, TX);
    return this.get(ctx, applicationId);
  }

  // ── G5: зөвшөөрөх → Core ──
  async approve(ctx: RequestContext, applicationId: string, comment?: string): Promise<DisbursementView> {
    const pre = await this.access.load(ctx, applicationId, 'read');
    // 1) Зөвшөөрлийг бүртгэж, Core руу явуулах төлөвт оруулна (CAS) — зэрэг дарсан хоёр дахь хүсэлтийг хаана.
    const { row, app } = await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      const row = await tx.disbursementRequest.findUnique({ where: { applicationId } });
      if (!row || !['SUBMITTED', 'FAILED'].includes(row.status)) throw new ConflictException({ code: 'DISBURSEMENT_NOT_PENDING', message: 'Зөвшөөрөх олголтын хүсэлт алга', details: { status: row?.status ?? null } });
      if (app.status !== 'DISBURSING') throw new ConflictException({ code: 'DISBURSEMENT_NOT_PENDING', message: 'Хүсэлтийн төлөв "Олгож байна" биш байна', details: { status: app.status } });
      const submittedBy = (row.historyJson as unknown as HistoryEntry[] | null)?.filter((h) => h.action === 'SUBMITTED').at(-1)?.by;
      if (submittedBy && submittedBy === ctx.userId) throw new ForbiddenException({ code: 'SELF_APPROVAL', message: 'Өөрийн илгээсэн олголтыг өөрөө зөвшөөрөх боломжгүй' });
      const checks = evaluateGate(this.gateInput(app, row, await this.snapshot(tx, app)));
      const bad = checks.filter((c) => !c.ok);
      if (bad.length) throw new DomainError('DISBURSEMENT_GATE_FAILED', 'Олголт зөвшөөрөх нөхцөл (G5) хангагдаагүй байна', 422, { failed: bad });
      const res = await tx.disbursementRequest.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'APPROVED', historyJson: this.history(row, ctx, 'APPROVED', comment ?? null) as never, updatedBy: ctx.userId } });
      if (res.count !== 1) throw new ConflictException({ code: 'STALE_STATE', message: 'Олголтын төлөв өөрчлөгдсөн байна, дахин ачаална уу' });
      return { row: await tx.disbursementRequest.findUniqueOrThrow({ where: { id: row.id } }), app };
    }, TX);
    void pre;

    // 2) Core: данс нээх (транзакцаас гадуур)
    const customerId = (await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId, isPrimary: true }, select: { customerId: true } }))?.customerId ?? '';
    let coreLoanId: string;
    try {
      coreLoanId = (await this.core.openLoan({
        idempotencyKey: row.id, applicationId, contractNo: app.contractNo as string, customerId, amount: num(row.disburseAmount), currency: app.currency, termMonths: row.termMonths, interestRate: num(row.interestRate),
        repaymentType: row.repaymentType, disburseDate: ymd(row.disburseDate) as string, firstPaymentDate: ymd(row.firstPaymentDate),
        account: { bankCode: row.bankCode as string, accountNo: decryptedField(row.accountNoEncrypted as string, ACCOUNT_AAD), holderName: row.holderName as string },
      })).coreLoanId;
    } catch (e) {
      const code = e instanceof CoreLoanError ? e.code : 'CORE_UNAVAILABLE';
      this.logger.warn({ event: 'disbursement.core_failed', applicationId, disbursementId: row.id, code, correlationId: ctx.correlationId });
      await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.disbursementRequest.findUniqueOrThrow({ where: { id: row.id } });
        await tx.disbursementRequest.update({ where: { id: row.id }, data: { status: 'FAILED', historyJson: this.history(fresh, ctx, 'CORE_FAILED', code) as never, updatedBy: ctx.userId } });
        await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: row.id, action: 'DISBURSEMENT_CORE_FAILED', actorId: ctx.userId, afterJson: { code }, applicationId, correlationId: ctx.correlationId });
      }, TX);
      throw new DomainError('CORE_OPEN_LOAN_FAILED', 'Core-д зээлийн данс нээж чадсангүй — дахин оролдох эсвэл буцаана уу', 502, { code });
    }

    // 3) Амжилт: SENT_TO_CORE + ACTIVE + event + ERP нэг транзакцид
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.disbursementRequest.findUniqueOrThrow({ where: { id: row.id } });
      await tx.disbursementRequest.update({ where: { id: row.id }, data: { status: 'SENT_TO_CORE', coreLoanId, historyJson: this.history(fresh, ctx, 'SENT_TO_CORE', null) as never, updatedBy: ctx.userId } });
      await tx.loanApplication.update({ where: { id: applicationId }, data: { disbursedAt: this.clock.now() } });
      await this.machine.apply(tx, ctx, applicationId, 'ACTIVE', { via: 'SYSTEM' });
      await this.events.publish(tx, { type: 'DisbursementApproved', applicationId, amount: num(fresh.disburseAmount), coreLoanId }, ctx);
      await this.erp.emitDisbursement({
        orgId: ctx.orgId, branchId: app.branchId, applicationId, contractNo: app.contractNo, coreLoanId, customerId: customerId || null, sourceId: row.id, currency: app.currency,
        businessDate: ymd(fresh.disburseDate) as string, amount: num(fresh.disburseAmount), correlationId: ctx.correlationId, actorId: ctx.userId,
      }, { tx });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: row.id, action: 'DISBURSEMENT_SENT_TO_CORE', actorId: ctx.userId, afterJson: { coreLoanId }, applicationId, correlationId: ctx.correlationId });
    }, TX);
    return this.get(ctx, applicationId);
  }

  /** Батлагч буцаана: олголт → DRAFT, хүсэлт DISBURSING → APPROVED. Тайлбар заавал. */
  async reject(ctx: RequestContext, applicationId: string, comment?: string): Promise<DisbursementView> {
    await this.access.load(ctx, applicationId, 'read');
    if (!comment?.trim()) throw new DomainError('COMMENT_REQUIRED', 'Буцаахдаа тайлбар бичих шаардлагатай', 400);
    await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      const row = await tx.disbursementRequest.findUnique({ where: { applicationId } });
      if (!row || !['SUBMITTED', 'FAILED'].includes(row.status) || app.status !== 'DISBURSING') throw new ConflictException({ code: 'DISBURSEMENT_NOT_PENDING', message: 'Буцаах олголтын хүсэлт алга' });
      await this.machine.apply(tx, ctx, applicationId, 'APPROVED', { via: 'SYSTEM', reason: comment });
      await tx.disbursementRequest.update({ where: { id: row.id }, data: { status: 'DRAFT', historyJson: this.history(row, ctx, 'REJECTED', comment) as never, updatedBy: ctx.userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'DISBURSEMENT_REQUEST', entityId: row.id, action: 'DISBURSEMENT_REJECTED', actorId: ctx.userId, afterJson: { comment }, applicationId, correlationId: ctx.correlationId });
    }, TX);
    return this.get(ctx, applicationId);
  }

  // ── дотоод ──
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
