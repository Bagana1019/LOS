import type { PosLeaseAction, PosLeaseStatus, PosLeaseView, PosPublicReason, MerchantStatus } from '@los/contracts';
import { t } from '../../lib/i18n';
import type { TagTone } from './tag-tones';
// Төлөв, үйлдэл, timeline-ы харуулалтын туслахууд (цэвэр функц). Бизнес дүрэм (allowedActions) серверээс ирнэ — UI давтахгүй (docs/05 §4).

/** Tag-ийн өнгөний нэр (`TAG_TONES`; контраст нь AA — tag-tones.test.ts). Өнгө дангаараа биш — Tag үргэлж текстэй. */
export const STATUS_COLOR: Record<PosLeaseStatus, TagTone> = {
  DRAFT: 'default', REFERRED: 'gold', APPROVED: 'green', DECLINED: 'red', ACCEPTED: 'blue', DELIVERED: 'cyan', SETTLED: 'purple', CANCELLED: 'default', EXPIRED: 'volcano',
};
export const MERCHANT_STATUS_COLOR: Record<MerchantStatus, TagTone> = { PENDING: 'gold', ACTIVE: 'green', SUSPENDED: 'orange', TERMINATED: 'red' };

export const statusLabel = (s: PosLeaseStatus): string => t(`pos.status.${s}`);
export const merchantStatusLabel = (s: MerchantStatus): string => t(`merchant.status.${s}`);
export const actionLabel = (a: PosLeaseAction): string => t(`pos.action.${a}`);
export const publicReasonLabel = (r: PosPublicReason): string => t(`pos.public.${r}`);

export const TERMINAL_STATUSES: readonly PosLeaseStatus[] = ['DECLINED', 'SETTLED', 'CANCELLED', 'EXPIRED'];
export const isTerminal = (s: PosLeaseStatus): boolean => TERMINAL_STATUSES.includes(s);

/** Серверийн allowedActions-д тухайн үйлдэл байгаа эсэх. */
export const can = (lease: Pick<PosLeaseView, 'allowedActions'>, action: PosLeaseAction): boolean => lease.allowedActions.includes(action);

/** Мерчант дэлгүүр нь шинэ лизинг үүсгэж болох төлөвтэй эсэх (POS-BR-10). */
export const canCreateLeases = (status: MerchantStatus): boolean => status === 'ACTIVE';

// ───────────── Алхамт урсгал (docs/05 §12): 1 Бараа → 2 Худалдан авагч → 3 Код → 4 Шийдвэр → 5 Баталгаажуулах → 6 Хүлээлгэн өгөх ─────────────
export const FLOW_STEP_KEYS = ['pos.step.goods', 'pos.step.buyer', 'pos.step.consent', 'pos.step.decision', 'pos.step.accept', 'pos.step.deliver'] as const;

/** Идэвхтэй алхамын индекс (0-based). `acceptStage` = кассир "Баталгаажуулах" дараад код хүлээж буй эсэх. */
export function flowStepIndex(status: PosLeaseStatus, acceptStage = false): number {
  switch (status) {
    case 'DRAFT': return 2;
    case 'REFERRED': case 'DECLINED': return 3;
    case 'APPROVED': return acceptStage ? 4 : 3;
    case 'ACCEPTED': return 5;
    case 'DELIVERED': case 'SETTLED': return FLOW_STEP_KEYS.length;
    default: return 3;
  }
}

// ───────────── Timeline ─────────────
const KNOWN_TIMELINE_ACTIONS = ['CREATED', 'CONSENT_VERIFIED', 'SUBMITTED', 'DECIDED', 'REVIEWED', 'ACCEPTED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'REQUOTED'];

export function timelineActionLabel(action: string): string {
  return KNOWN_TIMELINE_ACTIONS.includes(action) ? t(`pos.timeline.${action}`) : t('pos.timeline.UNKNOWN');
}

/** actor: SYSTEM | BUYER | MERCHANT:<id> | LENDER:<id> → зөвхөн дүрийн нэр (ID хэзээ ч харуулахгүй). */
export function actorLabel(actor: string): string {
  const role = actor.split(':', 1)[0];
  if (role === 'SYSTEM' || role === 'BUYER' || role === 'MERCHANT' || role === 'LENDER') return t(`pos.actor.${role}`);
  return t('pos.actor.UNKNOWN');
}
