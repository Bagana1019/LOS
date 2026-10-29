import { Injectable, Logger } from '@nestjs/common';
import { addDays, outstandingOf, remindersFor, type ReminderCandidate, type ReminderHit, type ReminderPolicy } from '@los/calc';
import type { RunRemindersResponse } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { NotificationService, type NotifyPayload } from './notification.service';
import { TemplateService, type TemplateResolver } from './template.service';
import { todayUB } from '../../shared/clock';

const toNum = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0);

const validDays = (v: unknown, fallback: number[]): number[] => (Array.isArray(v) && v.every((n) => Number.isInteger(n)) ? (v as number[]) : fallback);

interface Totals { scanned: number; scheduled: number; duplicates: number }
interface AppRow { id: string; appNo: string; contractNo: string | null; currency: string; officerId: string | null; branchId: string }

/**
 * FR-13.2 "төлөлт сануулах": ACTIVE/MIGRATED зээлийн одоогийн ЭТХ-ийн (isStale=false, хамгийн сүүлийн) үлдэгдэлтэй мөрүүдэд
 * `remindersFor(asOf, …)`-ийн дагуу PRIMARY + CO_BORROWER зээлдэгч бүрт PAYMENT_DUE / PAYMENT_OVERDUE. dedupeBase = `reminder:${hit.key}`.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger('ReminderService');
  /** Нэг багцад авах зээлийн тоо (cursor-оор давтана). Тестэд багасгана. */
  pageSize = 200;

  constructor(
    private readonly prisma: PrismaService, private readonly clock: Clock, private readonly settings: OrgSettings,
    private readonly notifications: NotificationService, private readonly templates: TemplateService,
  ) {}

  async run(orgId: string, opts: { asOf?: string; dryRun?: boolean } = {}): Promise<RunRemindersResponse> {
    const asOf = opts.asOf ?? todayUB(this.clock);
    const dryRun = opts.dryRun ?? false;
    const policy: ReminderPolicy = {
      beforeDueDays: validDays(await this.settings.get(orgId, 'notification.reminder_before_due_days'), [3, 1, 0]),
      overdueDays: validDays(await this.settings.get(orgId, 'notification.reminder_overdue_days'), [1, 3, 7]),
    };
    // Зөвхөн сануулга өгөх өдрүүдтэй таарах мөрийг DB-ээс авна (бусад мөрийг уншихгүй).
    const targetDates = [...new Set([...policy.beforeDueDays.filter((n) => n >= 0).map((n) => addDays(asOf, n)), ...policy.overdueDays.filter((n) => n > 0).map((n) => addDays(asOf, -n))])];
    const totals: Totals = { scanned: 0, scheduled: 0, duplicates: 0 };
    const resolver = await this.templates.resolver(orgId); // нэг удаа ачаална
    if (targetDates.length) {
      let cursor: string | undefined;
      for (;;) {
        const apps = await this.prisma.loanApplication.findMany({
          where: { orgId, status: { in: ['ACTIVE', 'MIGRATED'] } }, orderBy: { id: 'asc' }, take: this.pageSize, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, appNo: true, contractNo: true, currency: true, officerId: true, branchId: true },
        });
        if (!apps.length) break;
        cursor = apps[apps.length - 1].id;
        await this.processBatch(orgId, asOf, dryRun, policy, targetDates, apps, resolver, totals);
        if (apps.length < this.pageSize) break;
      }
    }
    return { asOf, scannedInstallments: totals.scanned, scheduledDeliveries: totals.scheduled, skippedDuplicates: totals.duplicates, dryRun };
  }

  /** Cron: ACTIVE/MIGRATED зээлтэй байгууллага бүрт. */
  async runAllOrgs(opts: { asOf?: string; dryRun?: boolean } = {}): Promise<RunRemindersResponse[]> {
    const orgs = await this.prisma.loanApplication.findMany({ where: { status: { in: ['ACTIVE', 'MIGRATED'] } }, distinct: ['orgId'], select: { orgId: true } });
    const out: RunRemindersResponse[] = [];
    for (const { orgId } of orgs) {
      try { out.push(await this.run(orgId, opts)); }
      catch (e) { this.logger.error(`Сануулга (${orgId}) амжилтгүй: ${e instanceof Error ? e.message : 'үл мэдэгдэх'}`); }
    }
    return out;
  }

  private async processBatch(
    orgId: string, asOf: string, dryRun: boolean, policy: ReminderPolicy, targetDates: string[],
    apps: AppRow[], resolver: TemplateResolver, totals: Totals,
  ): Promise<void> {
    const appIds = apps.map((a) => a.id);
    // Одоогийн ЭТХ = stale БИШ хамгийн сүүлийн generatedAt (payment модулийн loadCurrentSchedule-тэй ижил).
    const schedules = await this.prisma.repaymentSchedule.findMany({
      where: { applicationId: { in: appIds }, isStale: false }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }], select: { id: true, applicationId: true },
    });
    const currentByApp = new Map<string, string>();
    for (const s of schedules) if (!currentByApp.has(s.applicationId)) currentByApp.set(s.applicationId, s.id);
    if (!currentByApp.size) return;
    const appOfSchedule = new Map([...currentByApp].map(([appId, scheduleId]) => [scheduleId, appId]));

    const rows = await this.prisma.repaymentScheduleRow.findMany({
      where: { scheduleId: { in: [...currentByApp.values()] }, dueDate: { in: targetDates.map((d) => new Date(`${d}T00:00:00Z`)) } },
      include: { allocations: { select: { interestPaid: true, principalPaid: true } } },
    });
    const candidates: Array<ReminderCandidate & { appId: string }> = [];
    for (const r of rows) {
      const principal = toNum(r.principal); const interest = toNum(r.interest);
      if (principal + interest <= 0) continue; // олголтын мөр
      totals.scanned++;
      const outstanding = outstandingOf({
        id: r.id, seq: r.seq, dueDate: r.dueDate.toISOString().slice(0, 10), interest, principal,
        paidInterest: r.allocations.reduce((s, a) => s + toNum(a.interestPaid), 0), paidPrincipal: r.allocations.reduce((s, a) => s + toNum(a.principalPaid), 0),
      });
      candidates.push({ installmentId: r.id, dueDate: r.dueDate.toISOString().slice(0, 10), outstanding, appId: appOfSchedule.get(r.scheduleId) as string });
    }
    const hits = remindersFor(asOf, candidates, policy);
    if (!hits.length) return;

    const borrowers = await this.prisma.loanApplicationBorrower.findMany({
      where: { applicationId: { in: appIds }, role: { in: ['PRIMARY', 'CO_BORROWER'] } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { applicationId: true, customerId: true },
    });
    const customersByApp = new Map<string, string[]>();
    for (const b of borrowers) customersByApp.set(b.applicationId, [...(customersByApp.get(b.applicationId) ?? []), b.customerId]);
    const appById = new Map(apps.map((a) => [a.id, a]));
    const candidateById = new Map(candidates.map((c) => [c.installmentId, c]));

    for (const hit of hits) {
      const cand = candidateById.get(hit.installmentId);
      const app = cand ? appById.get(cand.appId) : undefined;
      if (!cand || !app) continue;
      try {
        await this.remind(orgId, hit, cand.dueDate, cand.outstanding, app, customersByApp.get(app.id) ?? [], dryRun, resolver, totals);
      } catch (e) {
        // Нэг зээлийн алдаа бусдын сануулгыг зогсоохгүй; dedupeKey учир дараагийн ажиллалтаар нөхөгдөнө.
        this.logger.error(`Сануулга (хүсэлт ${app.id}, ${hit.kind}) амжилтгүй: ${e instanceof Error ? e.message : 'үл мэдэгдэх'}`);
      }
    }
  }

  private async remind(
    orgId: string, hit: ReminderHit, dueDate: string, outstanding: number,
    app: AppRow, customerIds: string[], dryRun: boolean, resolver: TemplateResolver, totals: Totals,
  ): Promise<void> {
    const overdue = hit.kind === 'OVERDUE';
    const payload: NotifyPayload = {
      applicationNo: app.appNo, contractNo: app.contractNo, amount: outstanding, currency: app.currency, dueDate, daysOverdue: overdue ? hit.offsetDays : 0,
    };
    const res = await this.notifications.notifyCustomers({
      orgId, customerIds, type: overdue ? 'PAYMENT_OVERDUE' : 'PAYMENT_DUE', applicationId: app.id, payload, dedupeBase: `reminder:${hit.key}`, dryRun, templates: resolver, branchId: app.branchId,
    });
    totals.scheduled += res.queued;
    totals.duplicates += res.duplicates;
    // Хугацаа хэтэрсэн: ЗЭЗ-д in-app — зөвхөн хүргэлт ШИНЭЭР үүссэн үед (дахин ажиллуулахад давхар мэдэгдэхгүй).
    if (overdue && !dryRun && app.officerId && res.queued + res.skipped > 0) {
      await this.notifications.notifyUsers({ orgId, userIds: [app.officerId], type: 'PAYMENT_OVERDUE', applicationId: app.id, payload });
    }
  }
}
