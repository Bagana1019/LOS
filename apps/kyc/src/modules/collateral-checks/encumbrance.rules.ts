import { EncumbranceSourceId, normalizePlateNo, type EncumbranceSourceResult, type EncumbranceStatus } from '@los/contracts';
import type { EncumbranceAssetType } from '../../integrations/encumbrance/encumbrance.registry';

// FR-6.6: ЗМС + ЭБ-ийн үр дүнг нэг дүгнэлт болгох цэвэр дүрэм (I/O байхгүй).

/** Эх сурвалжийн хариу дутуу/шалгах боломжгүй — "цэвэр" гэж дүгнэх үндэслэлгүй (fail closed). */
export class EncumbranceIncompleteError extends Error {
  constructor(message = 'ЗМС/ЭБ-ийн хариу дутуу') {
    super(message);
    this.name = 'EncumbranceIncompleteError';
  }
}

/**
 * Бүртгэлд илгээх дугаарын хэлбэр: VEHICLE → улсын дугаар (зай, зураас хасч том үсэг); бусад → хоосон зай тайрч NFC, том үсэг (mn).
 * Хоосон болбол `null` (жишээ нь "---").
 */
export function normalizeEncumbranceIdentifier(assetType: EncumbranceAssetType, identifier: string): string | null {
  const v = assetType === 'VEHICLE' ? normalizePlateNo(identifier.normalize('NFC')) : identifier.normalize('NFC').trim().toLocaleUpperCase('mn');
  return v === '' ? null : v;
}

/**
 * Нэгдсэн дүгнэлт: DISPUTED > ENCUMBERED > CLEAR.
 * Fail closed: ЗМС, ЭБ хоёр бүрийн ≥ 1 мөр заавал байх ба ядаж нэг мөр `NOT_APPLICABLE` биш байх ёстой; үгүй бол {@link EncumbranceIncompleteError}.
 * `NOT_APPLICABLE` мөр (бүртгэл тухайн хөрөнгийг хамрахгүй) дүгнэлтэд нөлөөлөхгүй.
 */
export function combineEncumbranceStatus(sources: readonly EncumbranceSourceResult[]): EncumbranceStatus {
  for (const id of EncumbranceSourceId) if (!sources.some((s) => s.source === id)) throw new EncumbranceIncompleteError();
  if (sources.some((s) => s.status === 'DISPUTED')) return 'DISPUTED';
  if (sources.some((s) => s.status === 'ENCUMBERED')) return 'ENCUMBERED';
  if (sources.some((s) => s.status === 'CLEAR')) return 'CLEAR';
  throw new EncumbranceIncompleteError('ЗМС/ЭБ-ийн аль нь ч хөрөнгийг шалгаагүй');
}

/** ЗМС эхэлж, дараа нь ЭБ; нэг эх сурвалжийн дотор registry-ийн дарааллыг хадгална (тогтвортой эрэмбэ). */
export const sortSources = (sources: readonly EncumbranceSourceResult[]): EncumbranceSourceResult[] =>
  EncumbranceSourceId.flatMap((id) => sources.filter((s) => s.source === id));
