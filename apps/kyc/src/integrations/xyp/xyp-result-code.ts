// ХУР-ын албан ёсны resultCode хүснэгт (developer.xyp.gov.mn/docs/result-code, 2026-11-19-нд уншсан).
// Код нь мессежийн текстээс найдвартай: хүснэгтэд байгаа кодыг ЗӨВХӨН кодоор ангилна; текстийн дүрэм зөвхөн хүснэгтэд байхгүй (UNKNOWN) кодод.

export type XypResultOutcome =
  | 'OK' // 0 OK
  | 'NOT_FOUND' // 1 NOT_FOUND: мэдээлэл нийлүүлэгчээс мэдээлэл олдсонгүй
  | 'CODE_REJECTED' // 1001 OTP_NOT_FOUND, 1002 OTP_NOT_MATCH: иргэний код олдсонгүй / таарсангүй
  | 'CODE_NOT_SENT' // 1005 OTP_NOT_SENT, 1006 REG_PHONE_NOT_MATCH: ХУР иргэний утсанд код илгээж чадсангүй
  | 'FAILED' // хүснэгтэд байгаа бусад алдаа (дотоод, auth, гарын үсэг, сертификат, DB, код шалгах системийн алдаа)
  | 'UNKNOWN'; // хүснэгтэд байхгүй

/**
 * FAILED: 2 INTERNAL_ERROR, 3 INVALID_REQUEST, 200–203 AUTH_* / ACCESS_DENIED, 301–304 FINGER*, 401 SHOULD_RETURN_STATE_REGISTER, 402 NOT_OWNER,
 * 501 UNAUTHORIZED_ATTEMPT, 601–605 гарын үсэг / сертификат, 801–802 DATABASE_*, 1003 OTP_MATCH_TIMEOUT, 1004 OTP_MATCH_ERROR (код шалгах системийн алдаа — иргэний буруу код БИШ).
 */
const FAILED_CODES = [2, 3, 200, 201, 202, 203, 301, 302, 303, 304, 401, 402, 501, 601, 602, 603, 604, 605, 801, 802, 1003, 1004] as const;

const OUTCOMES: ReadonlyMap<number, XypResultOutcome> = new Map<number, XypResultOutcome>([
  [0, 'OK'],
  [1, 'NOT_FOUND'],
  [1001, 'CODE_REJECTED'],
  [1002, 'CODE_REJECTED'],
  [1005, 'CODE_NOT_SENT'],
  [1006, 'CODE_NOT_SENT'],
  ...FAILED_CODES.map((c): [number, XypResultOutcome] => [c, 'FAILED']),
]);

export const classifyXypResultCode = (code: number): XypResultOutcome => OUTCOMES.get(code) ?? 'UNKNOWN';

/** `resultCode`-ийг бүхэл тоо болгоно (SOAP int эсвэл цифрийн мөр); тоо биш / бүхэл биш бол `undefined`. */
export function parseXypResultCode(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) return Number(raw.trim());
  return undefined;
}
