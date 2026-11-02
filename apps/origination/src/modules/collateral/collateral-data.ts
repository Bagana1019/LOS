import { createHash } from 'node:crypto';
import { addDays, ulaanbaatarDate } from '@los/calc';
import type { CollateralValuationRecord, ValuationSource } from '@los/contracts';
import { Prisma, type Collateral } from '.prisma/client-origination';

// Барьцааны мөр ↔ domain хөрвүүлэлт (цэвэр). Хувийн мэдээлэл (улсын дугаар, регистр, нэр) аудитад орохгүй.

export const num = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));

/** DATE багана (UTC шөнө дунд) → YYYY-MM-DD. */
export const isoDate = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** YYYY-MM-DD → DATE баганад. */
export const dateOnly = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** Түлхүүрийн дарааллаас үл хамаарсан тогтвортой JSON (fingerprint, description харьцуулалт). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export const descriptionOf = (row: Pick<Collateral, 'descriptionJson'>): Record<string, unknown> =>
  row.descriptionJson && typeof row.descriptionJson === 'object' && !Array.isArray(row.descriptionJson) ? (row.descriptionJson as Record<string, unknown>) : {};

/**
 * Үнэлгээ/шалгалт хэний тухай вэ гэдгийг тодорхойлогч хурууны хээ: хөрөнгийн төрөл + өмчлөгч + тодорхойлолт.
 * Гадны дуудлага (valuation, kyc) явж байх хооронд эдгээр өөрчлөгдсөн бол үр дүнг хэрэглэхгүй (409).
 */
export function collateralFingerprint(row: Pick<Collateral, 'assetType' | 'ownerCustomerId' | 'descriptionJson'>): string {
  return createHash('sha256').update(stableStringify({ t: row.assetType, o: row.ownerCustomerId, d: descriptionOf(row) })).digest('hex');
}

/** PATCH-аар тодорхойлогч/өмчлөгч/тодорхойлолт өөрчлөгдвөл хүчингүй болох талбарууд (FR-6.5, FR-6.6, FR-14). */
export const CLEARED_VALUATION = {
  marketValue: null, haircutRate: null, collateralValue: null, valuationId: null, valuationSource: null, valuedAt: null,
  valuationValidUntil: null, valuationOverrideReason: null, externalValuationRequired: false, nextRevaluationAt: null,
} as const satisfies Prisma.CollateralUncheckedUpdateInput;

/** Өмчлөл/ачааллын шалгалтын үр дүнг хүчингүй болгоно (Json багана → DbNull). */
export const clearedChecks = (): Prisma.CollateralUncheckedUpdateInput => ({
  ownershipVerified: false, ownershipCheckJson: Prisma.DbNull, encumbranceCheckJson: Prisma.DbNull, encumbranceStatus: null,
});

export interface ValuationColumns {
  marketValue: number;
  haircutRate: number;
  collateralValue: number;
  valuationId: string;
  valuationSource: ValuationSource;
  valuedAt: Date;
  valuationValidUntil: Date | null;
  valuationOverrideReason: string | null;
  externalValuationRequired: boolean;
  nextRevaluationAt: Date;
}

/** FR-6.9: дараагийн дахин үнэлгээ = үнэлсэн өдөр (УБ) + setting `collateral.revaluation_interval_days`. */
export const nextRevaluationDate = (valuedAt: Date, intervalDays: number): Date => dateOnly(addDays(ulaanbaatarDate(valuedAt), intervalDays));

/** valuation-ий `collateral_valuation` мөр → барьцааны мөрийн үнэлгээний багана (docs/05 §2: sync хариуг шууд хуулна). */
export function valuationColumnsFromRecord(r: CollateralValuationRecord, revaluationIntervalDays: number): ValuationColumns {
  const valuedAt = new Date(r.valuedAt);
  return {
    marketValue: r.marketValue, haircutRate: r.haircutRate, collateralValue: r.collateralValue, valuationId: r.id, valuationSource: r.source, valuedAt,
    valuationValidUntil: r.validUntil ? new Date(r.validUntil) : null, valuationOverrideReason: r.overrideReason, externalValuationRequired: r.externalRequired,
    nextRevaluationAt: nextRevaluationDate(valuedAt, revaluationIntervalDays),
  };
}

/** Аудитад: PII-гүй хураангуй (улсын дугаар, регистр, нэр, тодорхойлолт ОРОХГҮЙ). */
export function auditSnapshot(row: Collateral): Record<string, unknown> {
  return {
    assetType: row.assetType, kind: row.kind, source: row.source, ownerCustomerId: row.ownerCustomerId,
    ownershipVerified: row.ownershipVerified, encumbranceStatus: row.encumbranceStatus,
    marketValue: num(row.marketValue), haircutRate: num(row.haircutRate), collateralValue: num(row.collateralValue), valuationId: row.valuationId,
    valuationSource: row.valuationSource, valuedAt: row.valuedAt?.toISOString() ?? null, registered: row.registryNo != null, releasedAt: row.releasedAt?.toISOString() ?? null,
  };
}
