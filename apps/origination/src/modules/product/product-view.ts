import type { Product } from '.prisma/client-origination';
import type { ProductAdminDto, ProductEditable } from '@los/contracts';

const num = (v: { toString(): string } | null | undefined): number | null => (v == null ? null : Number(v.toString()));

/** FR-13 · Админ харагдац (origination.product → DTO). `documentChecklist` гэх мэт JSON талбар шууд дамжина. */
export function toAdminDto(p: Product, applicationCount: number): ProductAdminDto {
  return {
    id: p.id, code: p.code, productType: p.productType, currency: p.currency, isActive: p.isActive, name: p.name,
    minAmount: num(p.minAmount)!, maxAmount: num(p.maxAmount)!, minTerm: p.minTerm, maxTerm: p.maxTerm,
    minRate: num(p.minRate)!, maxRate: num(p.maxRate)!, defaultFeeRate: num(p.defaultFeeRate), requiresCollateral: p.requiresCollateral,
    maxLtv: num(p.maxLtv), maxDti: num(p.maxDti), minDscr: num(p.minDscr), calcWeightThreshold: num(p.calcWeightThreshold),
    contractTemplateId: p.contractTemplateId,
    documentChecklist: p.documentChecklistJson ?? null, collateralChecklist: p.collateralChecklistJson ?? null, haircut: p.haircutJson ?? null,
    externalValuationThreshold: num(p.externalValuationThreshold), costOfGoodsRate: num(p.costOfGoodsRate), applicationCount,
    updatedAt: p.updatedAt.toISOString(), updatedBy: p.updatedBy,
  };
}

/** Засварлаж болох талбаруудыг DB-ийн баганад буулгана (JSON null → Prisma.DbNull-ийг дуудагч шийднэ). */
export function editableColumns(p: ProductEditable) {
  return {
    name: p.name, minAmount: p.minAmount, maxAmount: p.maxAmount, minTerm: p.minTerm, maxTerm: p.maxTerm, minRate: p.minRate, maxRate: p.maxRate,
    defaultFeeRate: p.defaultFeeRate, requiresCollateral: p.requiresCollateral, maxLtv: p.maxLtv, maxDti: p.maxDti, minDscr: p.minDscr,
    calcWeightThreshold: p.calcWeightThreshold, contractTemplateId: p.contractTemplateId,
    externalValuationThreshold: p.externalValuationThreshold, costOfGoodsRate: p.costOfGoodsRate,
  };
}

/** Аудит/diff-д ашиглах товч, тогтвортой хэлбэр (JSON түлхүүрүүд эрэмбэтэй биш байж болох тул DTO-оос) */
export function auditShape(d: ProductAdminDto) {
  const { applicationCount: _c, updatedAt: _u, updatedBy: _b, ...rest } = d;
  return rest;
}
