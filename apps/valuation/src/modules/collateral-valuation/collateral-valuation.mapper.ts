import type { CollateralValuationRecord } from '@los/contracts';
import type { CollateralValuationRow } from './collateral-valuation.repository';

/**
 * Row → API record. `collateralId` is origination's id (the row only holds the projection's own id).
 * Columns that are nullable in the base schema (method, haircut_rate, haircut_source, collateral_value) are always written by this service.
 */
export function toRecord(row: CollateralValuationRow, collateralId: string): CollateralValuationRecord {
  return {
    id: row.id,
    collateralId,
    source: row.source as CollateralValuationRecord['source'],
    method: row.method as CollateralValuationRecord['method'],
    appraiser: row.appraiser,
    licenseNo: row.licenseNo,
    valuedAt: row.valuedAt.toISOString(),
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    marketValue: Number(row.marketValue),
    suggestedValue: row.suggestedValue === null ? null : Number(row.suggestedValue),
    haircutRate: Number(row.haircutRate),
    haircutSource: row.haircutSource as CollateralValuationRecord['haircutSource'],
    collateralValue: Number(row.collateralValue),
    overrideReason: row.overrideReason,
    reportFileId: row.reportFileId,
    externalRequired: row.externalRequired,
    createdBy: row.createdBy,
  };
}
