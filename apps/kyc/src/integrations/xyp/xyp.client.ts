// ХУР (Төрийн мэдээлэл солилцооны систем) — иргэн/хуулийн этгээдийн үндсэн мэдээлэл (FR-2.2).
// Interface + MockXypClient + RealXypClient (CLAUDE.md §3.2.7). INTEGRATION_MODE=mock|real.
// Лавлагааны бусад 7 төрөл (үл хөдлөх, тээвэр, тэтгэвэр …) Модуль 3-т энэ interface-д нэмэгдэнэ.
import type { XypCitizen } from '@los/contracts';

export interface XypClient {
  /** @param registerNo нормчилсон регистр (том үсэг, зайгүй). Олдохгүй бол `null`. */
  getCitizen(registerNo: string): Promise<XypCitizen | null>;
}
export const XYP_CLIENT = Symbol('XYP_CLIENT');

/** ХУР түр ажиллахгүй/хугацаа хэтэрсэн (дахин оролдож болно). Зохиомол алдааг mock мөн гаргана. */
export class XypUnavailableError extends Error {
  constructor(message = 'ХУР-ын сервис түр ажиллахгүй байна') {
    super(message);
    this.name = 'XypUnavailableError';
  }
}
