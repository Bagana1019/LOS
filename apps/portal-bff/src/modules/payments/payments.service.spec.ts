import type { PortalCreatePaymentCommand, PortalLoanBalance, PortalPayment } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../../audit/audit.service';
import type { CallContext } from '../../common/request-context';
import type { LoanServicingPort } from '../../integrations/loan-servicing/loan-servicing.port';
import type { PaymentCollectionPort } from '../../integrations/payment-collection/payment-collection.port';
import { IdempotencyService } from '../../security/idempotency.service';
import { MemoryKvStore } from '../../store/memory-kv-store';
import { FakeClock, MemoryAuditSink } from '../../testing/test-app';
import type { LoanOwnershipService } from '../loans/loan-ownership.service';
import { PaymentsService } from './payments.service';

const ctx: CallContext = { correlationId: 'corr-unit-0001', customerId: 'cust_1' } as CallContext;

// Сүүлийн төлөлтийг хугацаанаас өмнө төлөх: хуваарьт хүү бүтэн, харин бүрэн хаах дүнд хуримтлагдсан хүү л орсон тул payoff < amountDue
const balance: PortalLoanBalance = {
  loanId: 'l1',
  currency: 'MNT',
  asOf: '2026-10-28T04:00:00.000Z',
  outstandingPrincipal: 900_000,
  accruedInterest: 51_093.91,
  accruedPenalty: 0,
  overdue: { principal: 0, interest: 0, penalty: 0, total: 0, days: 0 },
  nextInstallment: { seq: 36, dueDate: '2026-11-25', principal: 900_000, interest: 74_871.26, total: 974_871.26, amountDue: 974_871.26 },
  payoff: { amount: 951_093.91, validUntil: '2026-10-28' },
};

function make() {
  const created: PortalCreatePaymentCommand[] = [];
  const loans = { getBalance: async () => balance } as unknown as LoanServicingPort;
  const payments = {
    listMethods: async () => [{ method: 'QPAY' as const, minAmount: 100, maxAmount: 50_000_000 }],
    create: async (_c: CallContext, cmd: PortalCreatePaymentCommand) => {
      created.push(cmd);
      return { paymentId: 'pay_1', status: 'PENDING', ...cmd } as unknown as PortalPayment;
    },
  } as unknown as PaymentCollectionPort;
  const ownership = { assertOwned: async () => undefined } as unknown as LoanOwnershipService;
  const clock = new FakeClock(new Date('2026-10-28T04:00:00Z'));
  const svc = new PaymentsService(loans, payments, ownership, new IdempotencyService(new MemoryKvStore(clock)), new AuditService(new MemoryAuditSink(), clock));
  return { svc, created };
}

describe('PaymentsService', () => {
  it('payment-options advertise the amount a payment is created for, even when the payoff is below the instalment', async () => {
    const { svc, created } = make();
    const options = await svc.options(ctx, 'l1');
    expect(options.installment?.amount).toBe(951_093.91); // 974,871.26 биш: QR-д гарах дүнтэй ижил
    await svc.create(ctx, 'l1', { amountType: 'INSTALLMENT', method: 'QPAY' }, 'unit-key-0001');
    expect(created[0].amount).toBe(options.installment?.amount);
  });
});
