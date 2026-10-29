import { Injectable } from '@nestjs/common';
import { installmentState, payNowAmount } from '@los/calc';
import { RepaymentStatusView, type InstallmentView } from '@los/contracts';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { Clock } from '@los/nest-common';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { PAYABLE_STATUSES } from './invoice.service';
import { PAYMENT_INCLUDE, toPaymentView } from './payment.mapper';
import { loadCurrentSchedule } from './schedule-state';
import { todayUB } from '../../shared/clock';

const Decimal = Prisma.Decimal;

/** GET applications/:applicationId/repayment-status — одоогийн ЭТХ-ийн мөр бүрийн төлөв (allocation-аас), "одоо төлөх" дүн, сүүлийн төлбөрүүд. */
@Injectable()
export class RepaymentStatusService {
  constructor(private readonly prisma: PrismaService, private readonly access: ApplicationAccessService, private readonly clock: Clock) {}

  async get(ctx: RequestContext, applicationId: string): Promise<RepaymentStatusView> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const asOf = todayUB(this.clock);
    const [schedule, recent] = await Promise.all([
      loadCurrentSchedule(this.prisma, app.id),
      this.prisma.payment.findMany({ where: { applicationId: app.id }, orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }], take: 10, include: PAYMENT_INCLUDE }),
    ]);

    const rows = schedule?.installments ?? [];
    const installments: InstallmentView[] = rows.map((r) => {
      const st = installmentState(r, asOf);
      return {
        id: r.id, seq: r.seq, dueDate: r.dueDate, principal: r.principal, interest: r.interest, total: r.total,
        paidInterest: r.paidInterest, paidPrincipal: r.paidPrincipal, paidTotal: st.paidTotal, outstanding: st.outstanding, status: st.status, daysOverdue: st.daysOverdue,
      };
    });
    const sum = (xs: number[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0)).toDecimalPlaces(2).toNumber();
    const outstanding = sum(installments.map((i) => i.outstanding));
    const next = [...installments].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.seq - b.seq)).find((i) => i.outstanding > 0);

    return RepaymentStatusView.parse({
      applicationId: app.id, currency: app.currency, asOf, applicationStatus: app.status,
      payable: PAYABLE_STATUSES.includes(app.status) && !!schedule && outstanding > 0,
      scheduleGeneratedAt: schedule ? schedule.generatedAt.toISOString() : null,
      installments,
      totals: { scheduled: sum(installments.map((i) => i.total)), paid: sum(installments.map((i) => i.paidTotal)), outstanding, overdue: sum(installments.filter((i) => i.status === 'OVERDUE').map((i) => i.outstanding)) },
      payNowAmount: payNowAmount(rows, asOf),
      nextDue: next ? { scheduleRowId: next.id, dueDate: next.dueDate, outstanding: next.outstanding } : null,
      recentPayments: recent.map(toPaymentView),
    });
  }
}
