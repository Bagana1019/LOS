import type { PortalCreatePaymentCommand, PortalPaymentListQuery } from '@los/contracts';
import type { CallContext } from '../../common/request-context';
import type { MockLedger } from '../mock/mock-ledger';
import type { PaymentCollectionPort } from './payment-collection.port';

export class MockPaymentCollection implements PaymentCollectionPort {
  constructor(private readonly ledger: MockLedger) {}

  async listMethods(ctx: CallContext, loanId: string) {
    return this.ledger.methods(ctx.customerId, loanId);
  }
  async create(ctx: CallContext, cmd: PortalCreatePaymentCommand, idempotencyKey: string) {
    return this.ledger.createPayment(ctx.customerId, cmd, idempotencyKey);
  }
  async get(ctx: CallContext, paymentId: string) {
    return this.ledger.getPayment(ctx.customerId, paymentId);
  }
  async list(ctx: CallContext, loanId: string, query: PortalPaymentListQuery) {
    return this.ledger.listPayments(ctx.customerId, loanId, query);
  }
}
