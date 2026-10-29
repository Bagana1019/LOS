import type { EncumbranceSourceResult } from '@los/contracts';
import { EncumbranceUnavailableError } from './encumbrance.registry';

// DEMO: ачааллын mock дүрэм (docs/05 §9). Эдгээр нь бодит ЗМС/ЭБ-ийн хариу БИШ — дугаарын хэлбэрээр хэрэглэгчид үр дүнг урьдчилан таамаглуулах зохиомол дүрэм.
// Дүрмийг ЗӨВХӨН энд солино (mock registry бусад бүх зүйлийг эндээс авна). Deterministic: Math.random/Date.now ашиглахгүй.
//   • дугаар `ERR`-ээр төгсвөл (том/жижиг үсэг ялгахгүй) → EncumbranceUnavailableError (эх сурвалж унасан дүр);
//   • дугаарын СҮҮЛИЙН ЦИФР (төгсгөлийн үсгийг тоохгүй: `5677УБА` → 7) 7 → ЗМС: ENCUMBERED (барьцаалагч "Жишээ ББСБ"), ЭБ: CLEAR;
//   • сүүлийн цифр 9 → ЭБ: DISPUTED (маргаантай), ЗМС: CLEAR;
//   • бусад → ЗМС, ЭБ хоёулаа CLEAR. Тоо огт байхгүй дугаар → CLEAR.
export const MOCK_ENCUMBRANCE_PLEDGEE = 'Жишээ ББСБ';
export const MOCK_ENCUMBRANCE_REGISTERED_AT = '2025-03-14';
export const MOCK_ENCUMBRANCE_ERROR_SUFFIX = /ERR$/i;

export const lastDigitOf = (identifier: string): string | null => /(\d)\D*$/u.exec(identifier)?.[1] ?? null;

const clear = (source: EncumbranceSourceResult['source']): EncumbranceSourceResult => ({ source, status: 'CLEAR', pledgee: null, registeredAt: null, note: null });

/** @throws EncumbranceUnavailableError дугаар `ERR`-ээр төгссөн үед. */
export function mockEncumbranceSources(identifier: string): EncumbranceSourceResult[] {
  const id = identifier.trim();
  if (MOCK_ENCUMBRANCE_ERROR_SUFFIX.test(id)) throw new EncumbranceUnavailableError();
  const digit = lastDigitOf(id);
  return [
    digit === '7'
      ? { source: 'ZMS', status: 'ENCUMBERED', pledgee: MOCK_ENCUMBRANCE_PLEDGEE, registeredAt: MOCK_ENCUMBRANCE_REGISTERED_AT, note: 'DEMO: зохиомол барьцаа (сүүлийн цифр 7)' }
      : clear('ZMS'),
    digit === '9'
      ? { source: 'EB', status: 'DISPUTED', pledgee: null, registeredAt: MOCK_ENCUMBRANCE_REGISTERED_AT, note: 'DEMO: зохиомол маргаан (сүүлийн цифр 9)' }
      : clear('EB'),
  ];
}
