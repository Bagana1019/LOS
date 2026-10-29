import type { PortalCreatePayment, PortalLoanBalance, PortalPaymentMethodLimit } from '@los/contracts';
import { PortalError } from '../../common/portal-error';
import { round2 } from '../../common/date';

/** Дараагийн төлөлтийн дүн: бүрэн хаах дүнгээс хэтрэхгүй (сүүлийн төлөлтийг хугацаанаас өмнө төлөхөд хүү бага хуримтлагдсан байдаг). */
export function offeredInstallment(balance: PortalLoanBalance): number | null {
  const next = balance.nextInstallment;
  if (!next || next.amountDue <= 0 || balance.payoff.amount <= 0) return null;
  return round2(Math.min(next.amountDue, balance.payoff.amount));
}

/** Хугацаа хэтэрсэн нийт дүн: бүрэн хаах дүнгээс хэтрэхгүй. */
export function offeredOverdue(balance: PortalLoanBalance): number | null {
  if (balance.overdue.total <= 0 || balance.payoff.amount <= 0) return null;
  return round2(Math.min(balance.overdue.total, balance.payoff.amount));
}

/**
 * Төлөх дүнг СЕРВЕР тодорхойлно (клиентийн илгээсэн дүнд зөвхөн CUSTOM үед итгэнэ).
 * Бүх төрөл «бүрэн хаах дүн»-гээс хэтэрч болохгүй (илүү төлөлт хориотой).
 */
export function resolveAmount(body: PortalCreatePayment, balance: PortalLoanBalance): number {
  const payoff = balance.payoff.amount;
  if (payoff <= 0) throw new PortalError('LOAN_NOT_PAYABLE');

  switch (body.amountType) {
    case 'INSTALLMENT': {
      const amount = offeredInstallment(balance);
      if (amount === null) throw new PortalError('LOAN_NOT_PAYABLE');
      return amount;
    }
    case 'OVERDUE': {
      const amount = offeredOverdue(balance);
      if (amount === null) throw new PortalError('NO_OVERDUE');
      return amount;
    }
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

/**
 * Сонгосон төлбөрийн хэрэгслийн идэвхтэй байдал ба дүнгийн хязгаар (origination-оос ирнэ).
 * Зээлийг бүрэн хаах төлөлтөд доод хязгаар үйлчлэхгүй: үгүй бол хэрэгслийн доод хязгаараас бага үлдэгдэл хэзээ ч төлөгдөхгүй.
 * (Эцсийн шийдвэр origination-д: дүнг дахин шалгаж AMOUNT_OUT_OF_RANGE буцааж болно.)
 */
export function checkMethodLimit(method: PortalCreatePayment['method'], amount: number, limits: PortalPaymentMethodLimit[], payoff: number): void {
  const limit = limits.find((l) => l.method === method);
  if (!limit) throw new PortalError('METHOD_NOT_AVAILABLE');
  const closesLoan = amount >= payoff - 0.005;
  if ((amount < limit.minAmount && !closesLoan) || amount > limit.maxAmount) {
    throw new PortalError('AMOUNT_OUT_OF_RANGE', [{ path: 'amount', message: `allowed ${limit.minAmount}..${limit.maxAmount}` }]);
  }
}
