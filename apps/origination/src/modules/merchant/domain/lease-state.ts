import type { MerchantStatus, PosLeaseAction, PosLeaseStatus } from '@los/contracts';
import { DomainError } from './errors';
import type { LeaseRecord } from './records';

// docs/05 §4 — төлвийн мөчлөг. Шилжилт зөвхөн энэ хүснэгтээр.
export const POS_LEASE_TRANSITIONS: Readonly<Record<PosLeaseStatus, readonly PosLeaseStatus[]>> = {
  DRAFT: ['APPROVED', 'REFERRED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  REFERRED: ['APPROVED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  DECLINED: [],
  ACCEPTED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** Хугацаа дуусалтаар (lazy expiry) EXPIRED болж болох төлвүүд. */
export const EXPIRING_STATUSES: readonly PosLeaseStatus[] = ['DRAFT', 'REFERRED', 'APPROVED'];

export function canTransition(from: PosLeaseStatus, to: PosLeaseStatus): boolean {
  return POS_LEASE_TRANSITIONS[from].includes(to);
}

/** Хориотой шилжилт → 409 INVALID_TRANSITION {from,to}. */
export function assertTransition(from: PosLeaseStatus, to: PosLeaseStatus): void {
  if (!canTransition(from, to)) throw new DomainError('INVALID_TRANSITION', `Lease cannot move from ${from} to ${to}`, { from, to });
}

/** Гарах шилжилтгүй төлөв (терминал). */
export function isTerminal(status: PosLeaseStatus): boolean {
  return POS_LEASE_TRANSITIONS[status].length === 0;
}

/** Lazy expiry: DRAFT/REFERRED/APPROVED ба expiresAt < now бол EXPIRED гэж үзнэ (хадгалагдсан төлөвийг өөрчлөхгүй). */
export function effectiveStatus(lease: Pick<LeaseRecord, 'status' | 'expiresAt'>, now: Date): PosLeaseStatus {
  return EXPIRING_STATUSES.includes(lease.status) && lease.expiresAt !== null && lease.expiresAt.getTime() < now.getTime() ? 'EXPIRED' : lease.status;
}

export function isExpired(lease: Pick<LeaseRecord, 'status' | 'expiresAt'>, now: Date): boolean {
  return effectiveStatus(lease, now) === 'EXPIRED';
}

/**
 * Мерчантын хийж болох үйлдлүүд (сервер-удирдсан UI, docs/05 §4). `merchantStatus` өгвөл POS-BR-10-ыг тусгана:
 * TERMINATED/PENDING → хоосон; SUSPENDED → зөвхөн нээлттэй лизингийг дуусгах (DELIVER) ба цуцлах.
 */
export function allowedActions(lease: Pick<LeaseRecord, 'status' | 'expiresAt' | 'consentVerifiedAt'>, now: Date, merchantStatus?: MerchantStatus): PosLeaseAction[] {
  if (merchantStatus !== undefined && merchantStatus !== 'ACTIVE' && merchantStatus !== 'SUSPENDED') return [];
  let actions: PosLeaseAction[];
  switch (effectiveStatus(lease, now)) {
    case 'DRAFT': actions = lease.consentVerifiedAt ? ['SUBMIT', 'CANCEL'] : ['SUBMIT', 'RESEND_CONSENT_OTP', 'CANCEL']; break;
    case 'REFERRED': actions = ['CANCEL']; break;
    case 'APPROVED': actions = ['REQUEST_ACCEPT_OTP', 'ACCEPT', 'CANCEL']; break;
    case 'ACCEPTED': actions = ['DELIVER', 'CANCEL']; break;
    default: actions = [];
  }
  return merchantStatus === 'SUSPENDED' ? actions.filter((a) => a === 'DELIVER' || a === 'CANCEL') : actions;
}
