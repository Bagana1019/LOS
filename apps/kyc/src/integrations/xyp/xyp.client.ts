// ХУР (Төрийн мэдээлэл солилцооны систем) — иргэн/хуулийн этгээдийн үндсэн мэдээлэл (FR-2.2), үл хөдлөх хөрөнгө ба тээврийн хэрэгсэл (FR-6.3, FR-6.5).
// Interface + MockXypClient + RealXypClient (CLAUDE.md §3.2.7). INTEGRATION_MODE=mock|real.
// Лавлагааны бусад төрөл (тэтгэвэр …) Модуль 3-т энэ interface-д нэмэгдэнэ.
import type { XypAssetsResponse, XypCitizen, XypPropertyAsset } from '@los/contracts';

export interface XypClient {
  /**
   * Иргэний зөвшөөрөл: иргэний ХУР-д БҮРТГЭЛТЭЙ утсанд нэг удаагийн код (OTP) илгээнэ (WS100008). Утсыг дуудагч СОНГОХГҮЙ — ажилтан өөр утас руу чиглүүлж болохгүй.
   * @returns `false` — регистр ХУР-д олдсонгүй. ХУР код илгээж чадсангүй (1005 / 1006) → XypOtpNotSentError. Код явсан эсэх тодорхойгүй алдаа → XypUnavailableError (иргэнд SMS давхар явахаас сэргийлж дахин оролдохгүй).
   */
  requestCitizenOtp(registerNo: string): Promise<boolean>;
  /**
   * @param registerNo нормчилсон регистр (том үсэг, зайгүй). Олдохгүй бол `null`.
   * @param otp иргэний утсанд ирсэн код (4–8 цифр). Буруу / хугацаа дууссан / ХУР татгалзсан → XypOtpRejectedError. Код нууц: лог, алдаанд орохгүй.
   */
  getCitizen(registerNo: string, otp: string): Promise<XypCitizen | null>;
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

/**
 * Иргэний кодыг өгсний дараа ХУР ХАРИУЛСАН (SOAP fault / resultCode≠0) ч иргэний мэдээллийг өгсөнгүй: код буруу, хугацаа дууссан, ашиглагдсан эсвэл ХУР татгалзсан.
 * Vendor-ийн алдааны хүснэгт repo-д байхгүй тул шалтгааныг ялгахгүй. Сүлжээ / timeout / хэлбэр буруу хариу нь ЭНЭ БИШ (XypUnavailableError).
 * `faultCode` / `resultCode` нь зөвхөн оношлогоонд (PII, нууц биш: SOAP faultcode, тоон код); мессеж нь код, регистр, vendor-ийн текстийг агуулахгүй.
 */
export class XypOtpRejectedError extends Error {
  readonly faultCode?: string;
  readonly resultCode?: number;
  constructor(detail: { faultCode?: string; resultCode?: number } = {}) {
    super('ХУР иргэний кодыг хүлээн авсангүй');
    this.name = 'XypOtpRejectedError';
    this.faultCode = detail.faultCode;
    this.resultCode = detail.resultCode;
  }
}

/**
 * WS100008: ХУР иргэний утсанд код илгээж ЧАДСАНГҮЙ — албан ёсны resultCode 1005 OTP_NOT_SENT (илгээлт амжилтгүй / иргэн рүү илгээх боломжгүй),
 * 1006 REG_PHONE_NOT_MATCH (иргэний утас операторын бүртгэлд түүний нэр дээр бүртгэлгүй). ХУР-ын доголдол БИШ: дахин оролдоход ижил үр дүн гарна,
 * иргэн утасны бүртгэлээ засуулах эсвэл ажилтан гараар бөглөнө. `resultCode` нь зөвхөн оношлогоонд (нууц, PII биш).
 */
export class XypOtpNotSentError extends Error {
  readonly resultCode?: number;
  constructor(detail: { resultCode?: number } = {}) {
    super('ХУР иргэний утсанд код илгээж чадсангүй');
    this.name = 'XypOtpNotSentError';
    this.resultCode = detail.resultCode;
  }
}

/** ХУР түр ажиллахгүй/хугацаа хэтэрсэн (дахин оролдож болно). Зохиомол алдааг mock мөн гаргана. */
export class XypUnavailableError extends Error {
  /** Зөвхөн оношлогоонд (SOAP faultcode, тоон resultCode — нууц, PII биш): ХУР fault-аар ХАРИУЛСАН ч «код буруу» биш (доголдол, token / гарын үсгийн алдаа гэх мэт). */
  readonly faultCode?: string;
  readonly resultCode?: number;
  constructor(message = 'ХУР-ын сервис түр ажиллахгүй байна', detail: { faultCode?: string; resultCode?: number } = {}) {
    super(message);
    this.name = 'XypUnavailableError';
    this.faultCode = detail.faultCode;
    this.resultCode = detail.resultCode;
  }
}
