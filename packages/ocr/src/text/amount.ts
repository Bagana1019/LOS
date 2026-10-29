// Мөнгөн дүн задлах (BSA-FR-2.2 parser-ийн нийтлэг хэрэгсэл). parseFloat-г түүхий оролт дээр хэзээ ч ашиглахгүй:
// эхлээд хэлбэрийг мөрдөж шалгаад, зөвхөн цэвэр цифрийн мөрийг Number()-д өгнө.

/** Оролтын дээд урт (тримлэсний дараа). Бодит дүн ~40 тэмдэгтээс хэтрэхгүй → адверсари урт мөрийг шууд хаана. */
export const AMOUNT_MAX_INPUT_LENGTH = 100;
/** Бүхэл хэсгийн цифрийн дээд тоо: Number-ийн үнэн зөв хүрээ + дансны дугаар (> 15 цифр) дүн гэж ойлгогдохоос сэргийлнэ. */
export const AMOUNT_MAX_INTEGER_DIGITS = 15;
/** Бутархай хэсгийн цифрийн дээд тоо (MNT 2, ханш 4...) */
export const AMOUNT_MAX_FRACTION_DIGITS = 6;

export interface ParseAmountOptions {
  /**
   * Аравтын таслал. Үл заавал: 'auto' (анхдагч) нь US/EU хэлбэрийг дараах дүрмээр таниулна —
   * хоёул байвал сүүлийнх нь аравтын; нэг л төрөл олон давтагдвал мянгатын; ганц таслал + яг 3 цифр (1-3 цифрийн дараа) = мянгатын;
   * бусад ганц цэг/таслал = аравтын. '.' эсвэл ',' өгвөл тэр нь аравтын, нөгөө нь мянгатын.
   */
  decimalSeparator?: 'auto' | '.' | ',';
}

// Валютын шуугиан: ₮, MNT, төг, төгрөг (+ латин бичлэг). Үсгийн өмнө үсэг байвал (өөр үгийн хэсэг) хүрэхгүй.
const CURRENCY_NOISE_RE = /₮|(?<!\p{L})(?:mnt|төгрөг|төг|tugrug|tugrik|tug)(?!\p{L})\.?/giu;
// Төрөл бүрийн хасах тэмдэг → '-'
const MINUS_RE = /[\u2212\u2012\u2013\u2014\u2010\u2011]/g;
const BODY_RE = /^\d+(?:[ .,]\d+)*$/;

const countOf = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * Монгол банкны хуулгын дүнг задална. Дэмжих хэлбэр: '1,234,567.89', '1 234 567', '1.234.567,89' (EU), '(1,000.00)' = -1000,
 * '1,000-' = -1000, '+500', '-500', '₮ 1,000', '1000 MNT', '1,000 төгрөг'. null: дүн биш, огноо, цаг, хоосон, > 15 цифрийн
 * тасралтгүй цифр (дансны дугаар), тэгээр эхэлсэн бүхэл ('007' — ID гэж үзнэ), эсвэл мянгатын бүлэглэл зөрсөн ('12 34').
 * Хоёрдмол утга ('1.234') анхдагчаар аравтын; EU мянгатыг opts.decimalSeparator=',' гэж заана.
 */
export function parseMnAmount(input: string, opts: ParseAmountOptions = {}): number | null {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (s === '' || s.length > AMOUNT_MAX_INPUT_LENGTH) return null;
  s = s.replace(MINUS_RE, '-').replace(CURRENCY_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();

  // Тэмдэг: хаалт, ахлах +/-, төгсгөлийн +/- (зөвхөн нэг хэлбэр)
  let sign = 1;
  let signForms = 0;
  const paren = /^\(\s*(.*?)\s*\)$/.exec(s);
  if (paren) {
    s = paren[1];
    sign = -1;
    signForms++;
  }
  const lead = /^([+-])\s*/.exec(s);
  if (lead) {
    s = s.slice(lead[0].length);
    sign = lead[1] === '-' ? -1 : 1;
    signForms++;
  }
  const trail = /\s*([+-])$/.exec(s);
  if (trail) {
    s = s.slice(0, s.length - trail[0].length);
    sign = trail[1] === '-' ? -1 : 1;
    signForms++;
  }
  if (signForms > 1) return null;

  s = s.replace(/['\u2019 ]+/g, ' '); // апостроф ба зайг мянгатын тусгаарлагч гэж нэгтгэнэ
  if (!BODY_RE.test(s)) return null; // огноо (2026-03-10, 10/03/2026), цаг, үсэг, зэрэгцсэн тусгаарлагч → null

  // Аравтын тусгаарлагчийг тодорхойлно
  const nDot = countOf(s, '.');
  const nComma = countOf(s, ',');
  const nSpace = countOf(s, ' ');
  const forced = opts.decimalSeparator && opts.decimalSeparator !== 'auto' ? opts.decimalSeparator : null;
  let dec: '.' | ',' | null = null;
  if (forced) dec = forced;
  else if (nDot > 0 && nComma > 0) dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (nDot + nComma > 0) {
    const p = nDot > 0 ? '.' : ',';
    if (nSpace > 0) dec = p;
    else if (nDot + nComma === 1) {
      const [head, tail] = s.split(p);
      dec = p === ',' && tail.length === 3 && head.length <= 3 ? null : p;
    }
  }

  let intPart = s;
  let fracPart = '';
  if (dec && s.includes(dec)) {
    const at = s.indexOf(dec);
    if (at !== s.lastIndexOf(dec)) return null; // аравтын тусгаарлагч нэг л удаа
    intPart = s.slice(0, at);
    fracPart = s.slice(at + 1);
    if (fracPart.length < 1 || fracPart.length > AMOUNT_MAX_FRACTION_DIGITS || !/^\d+$/.test(fracPart)) return null;
  }
  if (/[ .,]/.test(intPart)) {
    // Мянгатын бүлэглэл: нэг төрлийн тусгаарлагч, эхний бүлэг 1-3, үлдсэн нь яг 3 цифр
    if (!/^\d{1,3}([ .,])\d{3}(?:\1\d{3})*$/.test(intPart)) return null;
    intPart = intPart.replace(/[ .,]/g, '');
  }
  if (intPart.length > AMOUNT_MAX_INTEGER_DIGITS) return null;
  if (intPart.length > 1 && intPart.startsWith('0')) return null; // '007', '0012345678' = ID, дүн биш

  const value = Number(fracPart ? `${intPart}.${fracPart}` : intPart); // зөвхөн баталгаажсан цифрийн мөр
  return value === 0 ? 0 : sign * value;
}
