import type { PortalCreatePayment, PortalLoanBalance, PortalPaymentMethodLimit } from '@los/contracts';
import { PortalError } from '../../common/portal-error';
import { round2 } from '../../common/date';

/**
 * Төлөх дүнг СЕРВЕР тодорхойлно (клиентийн илгээсэн дүнд зөвхөн CUSTOM үед итгэнэ).
 * Бүх төрөл «бүрэн хаах дүн»-гээс хэтэрч болохгүй (илүү төлөлт хориотой).
 */
export function resolveAmount(body: PortalCreatePayment, balance: PortalLoanBalance): number {
  const payoff = balance.payoff.amount;
  if (payoff <= 0) throw new PortalError('LOAN_NOT_PAYABLE');

  switch (body.amountType) {
    case 'INSTALLMENT': {
      const next = balance.nextInstallment;
      if (!next || next.amountDue <= 0) throw new PortalError('LOAN_NOT_PAYABLE');
      return round2(Math.min(next.amountDue, payoff));
    }
    case 'OVERDUE':
      if (balance.overdue.total <= 0) throw new PortalError('NO_OVERDUE');
      return round2(Math.min(balance.overdue.total, payoff));
    case 'PAYOFF':
      return round2(payoff);
    case 'CUSTOM': {
      const amount = body.amount as number; // схем CUSTOM үед заавал гэж баталгаажуулсан
      if (amount > payoff) {
        throw new PortalError('AMOUNT_OUT_OF_RANGE', [{ path: 'amount', message: `must not exceed payoff ${payoff}` }]);
      }
      return amount;
    }
  }
}

/** Сонгосон төлбөрийн хэрэгслийн идэвхтэй байдал ба дүнгийн хязгаар (origination-оос ирнэ). */
export function checkMethodLimit(method: PortalCreatePayment['method'], amount: number, limits: PortalPaymentMethodLimit[]): void {
  const limit = limits.find((l) => l.method === method);
  if (!limit) throw new PortalError('METHOD_NOT_AVAILABLE');
  if (amount < limit.minAmount || amount > limit.maxAmount) {
    throw new PortalError('AMOUNT_OUT_OF_RANGE', [{ path: 'amount', message: `allowed ${limit.minAmount}..${limit.maxAmount}` }]);
  }
}
