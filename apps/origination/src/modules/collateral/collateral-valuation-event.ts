import type { DomainEvent } from '@los/contracts';
import type { Collateral } from '.prisma/client-origination';
import { nextRevaluationDate, type ValuationColumns } from './collateral-data';

export type ValuationCompletedEvent = Extract<DomainEvent, { type: 'ValuationCompleted' }>;

export type EventDecision =
  | { apply: true; columns: ValuationColumns }
  | { apply: false; reason: 'NO_VALUATION_ID' | 'MISSING_FIELDS' | 'ASSET_MISMATCH' | 'DUPLICATE' | 'OLDER' | 'SUPERSEDED' };

/**
 * docs/05 §2, §8: `ValuationCompleted` нь sync хариуны НӨӨЦ (идемпотент синк). ЦЭВЭР шийдвэр — event-ийг барьцаанд хэрэглэх үү.
 * Хэрэглэхгүй:
 *  - `valuationId` байхгүй (хуучин хэлбэр) эсвэл эх сурвалж/огноо/haircut тодорхойгүй;
 *  - хөрөнгийн төрөл таарахгүй;
 *  - DUPLICATE: энэ үнэлгээ аль хэдийн хэрэглэгдсэн (sync хариугаар);
 *  - OLDER: `valuedAt` нь барьцааны одоогийн `valued_at`-аас шинэ биш;
 *  - SUPERSEDED: event үүссэний дараа барьцаа өөрчлөгдсөн (`updated_at` > `occurredAt`) — PATCH-ээр үнэлгээ хүчингүй болсон, эсвэл гадны үнэлгээ
 *    (өмнөх огноотой тайлан) дараа нь sync-ээр хэрэглэгдсэн. Хуучин үнэлгээг буцааж амилуулахгүйн тулд (аюулгүй тал).
 * Event дотор `overrideReason` дамжихгүй тул хэрэглэгдсэн үнэлгээнд null.
 */
export function decideValuationEvent(c: Pick<Collateral, 'assetType' | 'valuationId' | 'valuedAt' | 'updatedAt'>, e: ValuationCompletedEvent, revaluationIntervalDays: number): EventDecision {
  if (!e.valuationId) return { apply: false, reason: 'NO_VALUATION_ID' };
  if (!e.source) return { apply: false, reason: 'MISSING_FIELDS' };
  const haircutRate = e.haircutRate ?? (e.marketValue > 0 ? Math.round((e.collateralValue / e.marketValue) * 10_000) / 10_000 : null);
  if (haircutRate == null || !Number.isFinite(haircutRate)) return { apply: false, reason: 'MISSING_FIELDS' };
  if (e.assetType && e.assetType !== c.assetType) return { apply: false, reason: 'ASSET_MISMATCH' };
  if (c.valuationId === e.valuationId) return { apply: false, reason: 'DUPLICATE' };
  const valuedAt = new Date(e.valuedAt ?? e.occurredAt);
  if (c.valuedAt && valuedAt.getTime() <= c.valuedAt.getTime()) return { apply: false, reason: 'OLDER' };
  if (new Date(e.occurredAt).getTime() < c.updatedAt.getTime()) return { apply: false, reason: 'SUPERSEDED' };
  return {
    apply: true,
    columns: {
      marketValue: e.marketValue, haircutRate, collateralValue: e.collateralValue, valuationId: e.valuationId, valuationSource: e.source, valuedAt,
      valuationValidUntil: e.validUntil ? new Date(e.validUntil) : null, valuationOverrideReason: null, externalValuationRequired: e.externalRequired ?? false,
      nextRevaluationAt: nextRevaluationDate(valuedAt, revaluationIntervalDays),
    },
  };
}
