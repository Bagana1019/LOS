import { ConflictException, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { buildSchedule, ScheduleError, summarizeSchedule, type DayCount, type ScheduleRow as CalcRow } from '@los/calc';
import type { RequestContext, ScheduleParamsRequest, ScheduleResponse, ScheduleView } from '@los/contracts';
import { recordAudit } from '@los/database';
import { DomainError } from '@los/nest-common';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { OrgSettings } from '../../shared/org-settings';
import { ApplicationStateMachine } from '../application/application-state-machine';
import { isEditable } from '../application/application.rules';
import { INSTALLMENT_STEP, scheduleOutdated } from '../loan-terms/loan-terms.rules';
import { BsaService } from '../bsa/bsa.service';
import { ScoreService } from '../score/score.service';

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** `repayment_schedule.params_json` — тухайн үеийн нөхцөлийн snapshot (FR-7.3 зөрүү илрүүлэх). */
interface StoredParams {
  startDate: string; firstPaymentDate: string; endDate: string; type: ScheduleView['params']['type']; graceMonths: number; dayCount: DayCount;
  principal: number; annualRate: number; termMonths: number; currency: string;
}
const n = (d: Prisma.Decimal): number => Number(d);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** FR-7 · ЭТХ үүсгэх, харах, Excel. Нөхцөл (дүн, хүү, хугацаа) нь Модуль 5-ын хадгалсан утгаас; тооцоо нь `@los/calc`. */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly machine: ApplicationStateMachine,
    private readonly settings: OrgSettings,
    private readonly score: ScoreService,
    private readonly bsa: BsaService,
  ) {}

  async get(ctx: RequestContext, applicationId: string): Promise<ScheduleResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const editable = isEditable(app.status) && (await this.access.can(ctx, app, 'write'));
    const row = await this.prisma.repaymentSchedule.findFirst({ where: { applicationId }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }], include: { rows: { orderBy: { seq: 'asc' } } } });
    if (!row) return { editable, schedule: null };
    const params = row.paramsJson as unknown as StoredParams;
    const isStale = row.isStale || scheduleOutdated({ principal: params.principal, annualRate: params.annualRate, termMonths: params.termMonths }, { amount: app.amount == null ? null : n(app.amount), interestRate: app.interestRate == null ? null : n(app.interestRate), termMonths: app.termMonths });
    const rows = row.rows.map((r) => ({ seq: r.seq, dueDate: ymd(r.dueDate), days: r.days, disbursement: n(r.disbursement), principal: n(r.principal), interest: n(r.interest), total: n(r.total), balance: n(r.balance) }));
    return { editable, schedule: { id: row.id, generatedAt: row.generatedAt.toISOString(), isStale, params, summary: summarizeSchedule(rows), rows } };
  }

  /** FR-7.1 · хадгалахгүй урьдчилж харах. */
  async preview(ctx: RequestContext, applicationId: string, input: ScheduleParamsRequest): Promise<ScheduleView> {
    const app = await this.access.load(ctx, applicationId, 'read');
    return this.compute(app, input, await this.settings.get(ctx.orgId, 'schedule.day_count'), null, null);
  }

  /** FR-7.1 · "ЭТХ үүсгэх": өмнөх хуваарийг хуучирсан болгож, шинийг хадгална; `installment` алхам COMPLETED. */
  async generate(ctx: RequestContext, applicationId: string, input: ScheduleParamsRequest): Promise<ScheduleResponse> {
    const before = await this.access.load(ctx, applicationId, 'write');
    if (!isEditable(before.status)) throw new ConflictException({ code: 'APPLICATION_NOT_EDITABLE', message: 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л ЭТХ үүсгэнэ', details: { status: before.status } });
    const dayCount = await this.settings.get(ctx.orgId, 'schedule.day_count');
    const view = this.compute(before, input, dayCount, null, null);

    await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      if (!isEditable(app.status)) throw new ConflictException({ code: 'APPLICATION_NOT_EDITABLE', message: 'Хүсэлтийн төлөв өөрчлөгдсөн байна', details: { status: app.status } });
      // Түгжээний дараа нөхцөл өөрчлөгдсөн бол (зэрэгцээ хадгалалт) 409 — буруу нөхцөлөөр ЭТХ хадгалахгүй.
      if (app.amount == null || n(app.amount) !== view.params.principal || app.termMonths !== view.params.termMonths || app.interestRate == null || n(app.interestRate) !== view.params.annualRate) {
        throw new ConflictException({ code: 'LOAN_TERMS_CHANGED', message: 'Зээлийн нөхцөл өөрчлөгдсөн байна, дахин оролдоно уу' });
      }
      await tx.repaymentSchedule.updateMany({ where: { applicationId, isStale: false }, data: { isStale: true, updatedBy: ctx.userId } });
      const created = await tx.repaymentSchedule.create({ data: { orgId: ctx.orgId, applicationId, paramsJson: view.params as unknown as Prisma.InputJsonValue, createdBy: ctx.userId, updatedBy: ctx.userId } });
      await tx.repaymentScheduleRow.createMany({
        data: view.rows.map((r) => ({ scheduleId: created.id, seq: r.seq, dueDate: new Date(`${r.dueDate}T00:00:00Z`), days: r.days, disbursement: r.disbursement, principal: r.principal, interest: r.interest, total: r.total, balance: r.balance })),
      });
      await tx.loanApplicationStep.updateMany({
        where: { applicationId, stepKey: INSTALLMENT_STEP, status: { not: 'LOCKED' } },
        data: { status: 'COMPLETED', completedAt: new Date(), staleReason: null, updatedBy: ctx.userId },
      });
      await recordAudit(tx, {
        orgId: ctx.orgId, entity: 'REPAYMENT_SCHEDULE', entityId: created.id, action: 'SCHEDULE_GENERATED', actorId: ctx.userId,
        afterJson: { ...view.params, installments: view.summary.installments, totalInterest: view.summary.totalInterest }, applicationId, correlationId: ctx.correlationId,
      });
    }, TX_OPTIONS);

    // ЭТХ өөрчлөгдвөл сарын төлбөр өөрчлөгдөж болно → тооцоолол хуучирна (FR-7.3). Алдаа нь ЭТХ-ийг буцаахгүй.
    try {
      await this.score.markStale(ctx, applicationId, 'ЭТХ өөрчлөгдсөн');
    } catch (e) {
      this.logger.warn({ msg: 'could not mark the calculation stale after schedule generation', applicationId, correlationId: ctx.correlationId, error: e instanceof Error ? e.message : String(e) });
    }
    await this.bsa.syncPayment(ctx, applicationId); // INT-6: ЭТХ-ийн төлбөр өөрчлөгдсөн → BSA-ийн DTI дахин (best effort)
    return this.get(ctx, applicationId);
  }

  /** FR-7.2 · Excel: төлбөрийн мөр бүр (олголтын мөр хүснэгтэд ороогүй, толгойн хэсэгт). Хуучирсан ЭТХ-ийг экспортлохгүй. */
  async exportXlsx(ctx: RequestContext, applicationId: string): Promise<{ buffer: Buffer; filename: string; mime: string }> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const { schedule } = await this.get(ctx, applicationId);
    if (!schedule) throw new DomainError('SCHEDULE_NOT_FOUND', 'ЭТХ үүсгээгүй байна', 404);
    if (schedule.isStale) throw new DomainError('SCHEDULE_STALE', 'ЭТХ хуучирсан байна, дахин үүсгэнэ үү', 409);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ЭТХ');
    const p = schedule.params;
    ws.addRow([`Эргэн төлөлтийн хуваарь · ${app.appNo}`]).font = { bold: true, size: 13 };
    ws.addRow(['Олгох дүн', p.principal, p.currency, 'Олгох огноо', p.startDate]);
    ws.addRow(['Хүү (жилийн)', p.annualRate / 100, '', 'Хугацаа (сар)', p.termMonths]);
    ws.addRow(['Төрөл', p.type, '', 'Хоногийн суурь', p.dayCount]);
    ws.getCell('B2').numFmt = '#,##0.00';
    ws.getCell('B3').numFmt = '0.00%';
    ws.addRow([]);
    const header = ws.addRow(['№', 'Огноо', 'Хоног', 'Үндсэн зээл', 'Хүү', 'Нийт төлбөр', 'Үлдэгдэл']);
    header.font = { bold: true };
    const headerRow = header.number;
    for (const r of schedule.rows.filter((x) => x.seq > 0)) ws.addRow([r.seq, r.dueDate, r.days, r.principal, r.interest, r.total, r.balance]);
    const s = schedule.summary;
    ws.addRow(['Нийт', '', '', s.totalPrincipal, s.totalInterest, s.totalPayment, '']).font = { bold: true };
    for (const col of [4, 5, 6, 7]) ws.getColumn(col).numFmt = '#,##0.00';
    ws.columns.forEach((c) => { c.width = 16; });
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `repayment-schedule-${app.appNo}.xlsx`, mime: XLSX_MIME };
  }

  /** Хадгалсан нөхцөл + ЭТХ-ийн параметрээс хуваарь бодно. Нөхцөл бүрэн биш → 422, параметр буруу → 422 (`ScheduleError.code`). */
  private compute(app: LoanApplication, input: ScheduleParamsRequest, dayCount: DayCount, id: string | null, generatedAt: string | null): ScheduleView {
    if (app.amount == null || app.termMonths == null || app.interestRate == null) {
      throw new DomainError('LOAN_TERMS_MISSING', 'Зээлийн нөхцөл (дүн, хугацаа, хүү) бүрэн бус тул ЭТХ үүсгэх боломжгүй', 422);
    }
    const principal = n(app.amount), annualRate = n(app.interestRate), termMonths = app.termMonths;
    let rows: CalcRow[];
    try {
      rows = buildSchedule({ principal, annualRate, termMonths, type: input.type, startDate: input.startDate, firstPaymentDate: input.firstPaymentDate, graceMonths: input.graceMonths, dayCount });
    } catch (e) {
      if (e instanceof ScheduleError) throw new DomainError('SCHEDULE_PARAMS_INVALID', e.message, 422, { reason: e.code });
      throw e;
    }
    const summary = summarizeSchedule(rows);
    return {
      id, generatedAt, isStale: false,
      params: { startDate: input.startDate, firstPaymentDate: input.firstPaymentDate, endDate: summary.endDate, type: input.type, graceMonths: input.graceMonths, dayCount, principal, annualRate, termMonths, currency: app.currency },
      summary, rows,
    };
  }
}
