import type { AllocatableInstallment } from '@los/calc';
import type { PrismaService, Tx } from '../../prisma.service';
import { dateOnly, num } from './payment.mapper';

type Db = PrismaService | Tx;

/** ЭТХ-ийн мөр + allocation-аас тооцсон төлөгдсөн дүн. `total` нь хуваарийн нийт төлбөр. */
export interface ScheduleInstallment extends AllocatableInstallment { total: number }
export interface CurrentSchedule { id: string; generatedAt: Date; installments: ScheduleInstallment[] }

/**
 * Одоогийн ЭТХ = stale БИШ хамгийн сүүлийн generatedAt. Төлсөн хүү/үндсэн нь `payment_allocation`-аас (цорын ганц эх сурвалж).
 * Олголтын мөр (үндсэн+хүү = 0, жишээ нь seq 0) төлбөр биш тул оруулахгүй.
 */
export async function loadCurrentSchedule(db: Db, applicationId: string): Promise<CurrentSchedule | null> {
  const schedule = await db.repaymentSchedule.findFirst({
    where: { applicationId, isStale: false }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }], include: { rows: { orderBy: { seq: 'asc' } } },
  });
  if (!schedule) return null;
  const rows = schedule.rows.filter((r) => num(r.principal) + num(r.interest) > 0);
  const sums = rows.length
    ? await db.paymentAllocation.groupBy({ by: ['scheduleRowId'], where: { scheduleRowId: { in: rows.map((r) => r.id) } }, _sum: { interestPaid: true, principalPaid: true } })
    : [];
  const paid = new Map(sums.map((s) => [s.scheduleRowId, { interest: num(s._sum.interestPaid), principal: num(s._sum.principalPaid) }]));
  return {
    id: schedule.id, generatedAt: schedule.generatedAt,
    installments: rows.map((r) => ({
      id: r.id, seq: r.seq, dueDate: dateOnly(r.dueDate), interest: num(r.interest), principal: num(r.principal), total: num(r.total),
      paidInterest: paid.get(r.id)?.interest ?? 0, paidPrincipal: paid.get(r.id)?.principal ?? 0,
    })),
  };
}
