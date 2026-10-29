import {
  PortalCreatePaymentCommand,
  PortalPayment,
  PortalPaymentList,
  type PortalPaymentListQuery,
  PortalPaymentMethodLimit,
} from '@los/contracts';
import { z } from 'zod';
import type { CallContext } from '../../common/request-context';
import { InternalHttpClient, seg } from '../internal-http.client';
import type { PaymentCollectionPort } from './payment-collection.port';

const BASE = '/api/internal/portal';

/** origination `/api/internal/portal/payments*` ба `/loans/:id/payments*`. */
export class RealPaymentCollection implements PaymentCollectionPort {
  constructor(private readonly http: InternalHttpClient) {}

  listMethods(ctx: CallContext, loanId: string) {
    return this.http.json({
      method: 'GET',
      path: `${BASE}/loans/${seg(loanId)}/payment-methods`,
      ctx,
      schema: z.array(PortalPaymentMethodLimit),
      notFound: 'LOAN_NOT_FOUND',
    });
  }

  create(ctx: CallContext, cmd: PortalCreatePaymentCommand, idempotencyKey: string) {
    return this.http.json({
      method: 'POST',
      path: `${BASE}/loans/${seg(cmd.loanId)}/payments`,
      ctx,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: cmd,
      schema: PortalPayment,
      notFound: 'LOAN_NOT_FOUND',
    });
  }

  get(ctx: CallContext, paymentId: string) {
    return this.http.json({ method: 'GET', path: `${BASE}/payments/${seg(paymentId)}`, ctx, schema: PortalPayment, notFound: 'PAYMENT_NOT_FOUND' });
  }

  list(ctx: CallContext, loanId: string, query: PortalPaymentListQuery) {
    const qs = new URLSearchParams({ limit: String(query.limit) });
    if (query.cursor) qs.set('cursor', query.cursor);
    return this.http.json({
      method: 'GET',
      path: `${BASE}/loans/${seg(loanId)}/payments?${qs}`,
      ctx,
      schema: PortalPaymentList,
      notFound: 'LOAN_NOT_FOUND',
      passThrough: ['INVALID_REQUEST'], // origination мэдэхгүй cursor → харилцагчид 400 (бусад endpoint-д гэрээний зөрчил 502 хэвээр)
    });
  }
}
