// Барьцаа хөрөнгийн ачааллын бүртгэл: ЗМС (зээлийн мэдээллийн сан) + ЭБ (барьцаа хөрөнгийн бүртгэл) — FR-6.6.
// Interface + MockEncumbranceRegistry + RealEncumbranceRegistry (CLAUDE.md §3.2.7). INTEGRATION_MODE=mock|real.
import type { EncumbranceSourceResult } from '@los/contracts';

/** Ачаалал шалгадаг хөрөнгийн төрлүүд (docs/05 §5). Бусад төрөл (мал, бараа материал, бусад)-д бүртгэл байхгүй → 422 `ENCUMBRANCE_CHECK_NOT_APPLICABLE`. */
export const ENCUMBRANCE_ASSET_TYPES = ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND', 'EQUIPMENT'] as const;
export type EncumbranceAssetType = (typeof ENCUMBRANCE_ASSET_TYPES)[number];
export const isEncumbranceAssetType = (t: string): t is EncumbranceAssetType => (ENCUMBRANCE_ASSET_TYPES as readonly string[]).includes(t);

export interface EncumbranceRegistry {
  /**
   * Нэг хөрөнгийг ЗМС болон ЭБ-ээс шалгана; эх сурвалж бүрийн үр дүнг буцаана (ZMS, EB тус бүр ≥ 1 мөр).
   * @param identifier VEHICLE → улсын дугаар (нормчилсон); APARTMENT/HOUSE/LAND → өмчлөх эрхийн дугаар; EQUIPMENT → серийн дугаар.
   * Эх сурвалжийн АЛЬ НЭГ нь хариу өгөөгүй бол `EncumbranceUnavailableError` шиднэ — хэсэгчилсэн (зөвхөн нэг эх сурвалжийн) хариу буцаахгүй.
   * Дугаар нь хувийн мэдээлэл: лог-д бичихгүй, хадгалахгүй (CLAUDE.md §6.5).
   */
  check(assetType: EncumbranceAssetType, identifier: string): Promise<EncumbranceSourceResult[]>;
}
export const ENCUMBRANCE_REGISTRY = Symbol('ENCUMBRANCE_REGISTRY');

/** ЗМС/ЭБ-ийн аль нэг нь түр ажиллахгүй/хугацаа хэтэрсэн. Мессеж нь дугаар агуулахгүй (лог-д орж болно). */
export class EncumbranceUnavailableError extends Error {
  constructor(message = 'ЗМС/ЭБ-ийн бүртгэл түр ажиллахгүй байна') {
    super(message);
    this.name = 'EncumbranceUnavailableError';
  }
}
