// Мөнгө/хувийн оролтын цэвэр логик (I/O-гүй). antd InputNumber нь тоо биш тэмдэгтийг (сая, -, үсэг) өөрөө чимээгүй хаяж, `min`-ээс бага утгыг clamp хийдэг
// (F2-8/F2-17) тул оролтыг ТЕКСТээр барьж, ойлгосон утга эсвэл "invalid" гэж ялгана. Хэзээ ч өөр утга болгож тасалдахгүй.

export type ParsedNumber = { kind: 'empty' } | { kind: 'ok'; value: number } | { kind: 'invalid' };

export interface NumberCodec {
  /** "5сая" = 5,000,000, "500мянга" = 500,000 (хатуу хэлбэр л). */
  units: boolean;
  /** Мянгатын тусгаарлагч: 5,000,000 · 5 000 000 · 2.000.000. Хувьд байхгүй: таслал нь аравтын. */
  grouping: boolean;
  /** Төгсгөлд нь хасаж болох тэмдэг (₮ эсвэл %). */
  suffix: string;
}
export const MONEY_CODEC: NumberCodec = { units: true, grouping: true, suffix: '₮' };
export const PERCENT_CODEC: NumberCodec = { units: false, grouping: false, suffix: '%' };

const UNIT_MULTIPLIER: Readonly<Record<string, number>> = { сая: 1_000_000, мянга: 1_000 };
// Нэгжтэй хэлбэр: бүхэл эсвэл 1–2 оронтой аравтын (3 оронтой "1,500сая" нь мянгатын таслалтай адил тул ойлгомжгүй → invalid).
const UNIT_FORM = /^(\d+)(?:[.,](\d{1,2}))?(сая|мянга)$/i;
const GROUPED_INT = /^\d{1,3}(?:,\d{3})+$|^\d{1,3}(?:\.\d{3})+$/;
const MINUS = /^[-−–]/;

const count = (s: string, ch: string): number => s.split(ch).length - 1;
const INVALID: ParsedNumber = { kind: 'invalid' };
const finite = (value: number): ParsedNumber => (Number.isFinite(value) ? { kind: 'ok', value } : INVALID);

/** Бүхэл + бутархай цифрийн мөрөөс тоо. Мянгатын тусгаарлагч буруу бүтэцтэй бол null. */
function digitsToNumber(body: string, grouping: boolean): number | null {
  const dots = count(body, '.');
  const commas = count(body, ',');
  let decimalAt = -1;
  if (dots > 0 && commas > 0) decimalAt = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
  else if (dots === 1) decimalAt = body.indexOf('.');
  else if (commas === 1 && !(grouping && /^\d{1,3},\d{3}$/.test(body))) decimalAt = body.indexOf(',');
  const head = decimalAt === -1 ? body : body.slice(0, decimalAt);
  const frac = decimalAt === -1 ? '' : body.slice(decimalAt + 1);
  if (/\D/.test(frac)) return null;
  let intDigits = head;
  if (/[.,]/.test(head)) {
    if (!grouping || !GROUPED_INT.test(head)) return null;
    intDigits = head.replace(/[.,]/g, '');
  }
  if (intDigits === '' && frac === '') return null;
  return Number(`${intDigits || '0'}.${frac || '0'}`);
}

function parseUnitForm(s: string): number | null {
  const m = UNIT_FORM.exec(s);
  if (!m) return null;
  const mult = UNIT_MULTIPLIER[(m[3] ?? '').toLowerCase()] ?? 0;
  return Number(m[1]) * mult + Math.round(Number(`0.${m[2] ?? '0'}`) * mult);
}

/** Хэрэглэгчийн бичсэн текст → утга. Сөрөг тоо (-100) нь `ok(-100)`: форм дүрэм нь тодорхой алдаа үзүүлнэ, энд тасалдаггүй. */
export function parseNumberText(raw: string, codec: NumberCodec): ParsedNumber {
  let s = raw.replace(/[\s'’]/g, ''); // \s нь NBSP, нарийн зайг ч хамарна
  if (s.endsWith(codec.suffix)) s = s.slice(0, -codec.suffix.length);
  if (s === '') return { kind: 'empty' };
  const negative = MINUS.test(s);
  if (negative) s = s.slice(1);
  const unit = codec.units ? parseUnitForm(s) : null;
  const value = unit ?? (/^[\d.,]+$/.test(s) ? digitsToNumber(s, codec.grouping) : null);
  if (value === null) return INVALID;
  return finite(negative ? -value || 0 : value); // -0 → 0
}

/** Форм талбарын утга: хоосон → undefined, тоо → тоо, ойлгогдохгүй → NaN (дүрэм "зөвхөн тоо" гэж мэдэгдэнэ; хэзээ ч серверт явахгүй). */
export function toFieldValue(p: ParsedNumber): number | undefined {
  if (p.kind === 'empty') return undefined;
  return p.kind === 'ok' ? p.value : Number.NaN;
}

const groupInt = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plain = (v: number): string => {
  const s = String(v);
  return /e/i.test(s) ? v.toFixed(8).replace(/\.?0+$/, '') : s;
};

/** Харуулах текст. Мөнгө: 5000000 → "5,000,000"; хувь: 1.5 → "1.5". Тоо биш → "". */
export function formatNumberText(value: number | null | undefined, grouping: boolean): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const s = plain(value);
  if (!grouping) return s;
  const [int = '', frac] = s.replace('-', '').split('.');
  return `${value < 0 ? '-' : ''}${groupInt(int)}${frac !== undefined ? `.${frac}` : ''}`;
}

const strip = (s: string): string => s.replace(/[\s'’]/g, '');
const GROUPED_WITH_FRACTION = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Таслал нь манай өмнөх форматлалтынх (хэрэглэгч шинээр бичээгүй) эсэх: өмнөх харагдсан текст зөв бүлэглэгдсэн, таслал нэмэгдээгүй, нэг тэмдэгтийн засвар.
 * Тэгвэл "1,2345" (1,234-д цифр нэмсэн) эсвэл "1,23" (backspace) нь аравтын таслал биш, дахин бүлэглэх ёстой текст.
 */
function isEditOfOwnGrouping(raw: string, prev: string): boolean {
  return GROUPED_WITH_FRACTION.test(strip(prev)) && count(raw, ',') <= count(prev, ',') && Math.abs(raw.length - prev.length) <= 1;
}

/**
 * Бичиж байх үеийн бүлэглэлт. Цэвэр цифр (+ зөв бүлэглэсэн таслал, ганц ".бутархай") л дахин форматлана; бусад бүх тохиолдолд (1,5 · 2.000.000 · 5сая · -100)
 * хэрэглэгчийн бичсэнийг хэвээр үлдээнэ — тэгэхгүй бол утгыг чимээгүй өөрчилнө. `prev` = өмнө нь харагдаж байсан текст: түүний таслалтай нэг тэмдэгтийн засварыг
 * (цифр нэмэх/хасах) дахин бүлэглэнэ; хэрэглэгчийн шинээр бичсэн/буулгасан таслалд хатуу шалгалт хэвээр ("1,5" → аравтын таслал, "15" болгохгүй).
 */
export function liveFormat(raw: string, grouping: boolean, prev = ''): string {
  if (!grouping) return raw;
  const m = /^(\d[\d,]*)?(\.\d*)?$/.exec(strip(raw));
  if (!m) return raw;
  const intPart = m[1] ?? '';
  if (intPart.includes(',') && !/^\d{1,3}(?:,\d{3})+$/.test(intPart) && !isEditOfOwnGrouping(raw, prev)) return raw;
  const digits = intPart.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  return `${groupInt(digits)}${m[2] ?? ''}`;
}

/** Курсорын өмнөх "чухал" тэмдэгт (цифр, цэг) — таслал/зай нь бүлэглэлтээр өөрчлөгддөг тул тоолохгүй. */
export function significantBefore(text: string, caret: number): number {
  return (text.slice(0, caret).match(/[\d.]/g) ?? []).length;
}

/** `significantBefore`-ийн урвуу: n дэх чухал тэмдэгтийн ард байрлах курсорын байрлал. */
export function caretAfter(text: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[\d.]/.test(text[i] ?? '')) seen += 1;
    if (seen === n) return i + 1;
  }
  return text.length;
}
