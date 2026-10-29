import type { MerchantStatus } from '@los/contracts';
import { DomainError } from './errors';

// POS-FR-1: PENDING → ACTIVE → SUSPENDED → TERMINATED. Дахин идэвхжүүлэх (SUSPENDED → ACTIVE) боломжтой; TERMINATED терминал.
export const MERCHANT_TRANSITIONS: Readonly<Record<MerchantStatus, readonly MerchantStatus[]>> = {
  PENDING: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: [],
};

export function assertMerchantTransition(from: MerchantStatus, to: MerchantStatus): void {
  if (!MERCHANT_TRANSITIONS[from].includes(to)) throw new DomainError('INVALID_TRANSITION', `Merchant cannot move from ${from} to ${to}`, { from, to });
}

/** POS-BR-10: шинэ лизинг үүсгэх / submit / accept зөвхөн ACTIVE. */
export function assertMerchantActive(status: MerchantStatus): void {
  if (status !== 'ACTIVE') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant is not active', { status });
}

/** POS-BR-10: SUSPENDED үед нээлттэй лизингийг дуусгах (deliver/cancel) зөвшөөрнө; TERMINATED/PENDING бүгдийг хориглоно. */
export function assertMerchantOperable(status: MerchantStatus): void {
  if (status !== 'ACTIVE' && status !== 'SUSPENDED') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant is not active', { status });
}
