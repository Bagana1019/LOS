// ХУР (Төрийн мэдээлэл солилцооны систем) — иргэн/хуулийн этгээдийн үндсэн мэдээлэл (FR-2.2), үл хөдлөх хөрөнгө ба тээврийн хэрэгсэл (FR-6.3, FR-6.5).
// Interface + MockXypClient + RealXypClient (CLAUDE.md §3.2.7). INTEGRATION_MODE=mock|real.
// Лавлагааны бусад төрөл (тэтгэвэр …) Модуль 3-т энэ interface-д нэмэгдэнэ.
import type { XypAssetsResponse, XypCitizen, XypPropertyAsset } from '@los/contracts';

export interface XypClient {
  /** @param registerNo нормчилсон регистр (том үсэг, зайгүй). Олдохгүй бол `null`. */
  getCitizen(registerNo: string): Promise<XypCitizen | null>;
  /**
   * FR-6.3: регистрийн эзэмшлийн үл хөдлөх хөрөнгө (өмчлөгчидтэй нь) ба тээврийн хэрэгсэл.
   * @param registerNo нормчилсон регистр. Регистр ХУР-д олдохгүй бол `null` (хөрөнгөгүй регистр нь хоосон жагсаалттай хариу).
   */
  getAssets(registerNo: string): Promise<XypAssetsResponse | null>;
  /**
   * FR-6.5: өмчлөх эрхийн дугаараар хөрөнгө ба бүх өмчлөгч (хамтран өмчлөгч орно). Олдохгүй бол `null`.
   * @param propertyId ХУР-ын өмчлөх эрхийн дугаар (mock-д DEMO формат `MOCK-<РЕГИСТР>-<n>`).
   */
  getProperty(propertyId: string): Promise<XypPropertyAsset | null>;
}
export const XYP_CLIENT = Symbol('XYP_CLIENT');

/** ХУР түр ажиллахгүй/хугацаа хэтэрсэн (дахин оролдож болно). Зохиомол алдааг mock мөн гаргана. */
export class XypUnavailableError extends Error {
  constructor(message = 'ХУР-ын сервис түр ажиллахгүй байна') {
    super(message);
    this.name = 'XypUnavailableError';
  }
}
