import { UpdateDisbursementRequest } from '@los/contracts';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';

// F5-5 / F5-16: олголтын маягтын клиент талын шалгалт (цэвэр функц). Мессеж нь монгол; `null` = зөв.
// Хязгаар бүр серверийн бодит дүрмээс: дансны урт = `UpdateDisbursementRequest.accountNo`, дүн ≤ батлагдсан дүн (BR-10, `amountWithinApproved`).

const ACCOUNT_SCHEMA = UpdateDisbursementRequest.shape.accountNo.unwrap();
const ACCOUNT_MIN = ACCOUNT_SCHEMA.minLength ?? 1;
const ACCOUNT_MAX = ACCOUNT_SCHEMA.maxLength ?? Number.MAX_SAFE_INTEGER;
const DIGITS = /^[0-9]+$/;
/** emoji (Extended_Pictographic, туг, keycap, ZWJ/variation selector) болон HTML-тэй төстэй тэмдэгт. */
const HOLDER_FORBIDDEN = /[<>&]|‍|️|⃣|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const GROUPED_NUMBER = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/** Серверийн `money2`-тэй ижил: 2 оронд бөөрөнхийлж харьцуулна. */
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

/** Дансны дугаар (заавал биш: хоосон = хадгалсан дансыг хэвээр үлдээнэ). Зөвхөн цифр, урт нь contract-ынхтай ижил. */
export function accountNoProblem(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!DIGITS.test(value)) return t('disb.err.accountDigits');
  return value.length < ACCOUNT_MIN || value.length > ACCOUNT_MAX ? t('disb.err.accountLength', { min: ACCOUNT_MIN, max: ACCOUNT_MAX }) : null;
}

/** Эзэмшигчийн нэр (заавал биш): emoji болон `<` `>` `&`-г хүлээж авахгүй. */
export function holderNameProblem(value: string | null | undefined): string | null {
  if (!value) return null;
  return HOLDER_FORBIDDEN.test(value) ? t('disb.err.holderChars') : null;
}

/**
 * Хэрэглэгчийн бичсэн текстийг ЯГ тоо болгоно; тэмдэгт хаяж/засдаггүй ("5сая" → null, "5,5" → null).
 * Зөвшөөрөх: `5000000`, `0.01`, `-5` (дараа нь > 0 шалгалтаар унана), зөв мянгатын таслал `5,000,000`.
 */
export function parseAmount(text: string): number | null {
  const s = text.trim();
  if (PLAIN_NUMBER.test(s)) return Number(s);
  if (GROUPED_NUMBER.test(s)) return Number(s.replace(/,/g, ''));
  return null;
}

/** Олгох дүн: > 0 ба ≤ батлагдсан дүн. Тоо биш текстийг чимээгүй тоо болгохгүй, тодорхой алдаа өгнө. */
export function amountProblem(text: string | null | undefined, approved: number): string | null {
  if (text === null || text === undefined || text.trim() === '') return t('disb.err.amount');
  const n = parseAmount(text);
  if (n === null) return t('disb.err.amountNotNumber');
  if (n <= 0 || round2(n) <= 0) return t('disb.err.amount');
  return round2(n) > round2(approved) ? t('disb.err.amountMax', { max: formatMnt(approved) }) : null;
}
