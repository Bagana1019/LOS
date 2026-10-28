// Admin-ийн оруулсан REGEX дүрмийг аюулгүй compile/ажиллуулах (BSA-FR-3.5; ReDoS хамгаалалт).
//
// Яагаад: V8-ийн regex нь backtracking тул `(a+)+$` шиг хэв нь экспоненциал хугацаа зарж, нэг thread-тэй Node процессыг гацаана.
// Node-д regex-д timeout байхгүй тул ГУРВАН давхар хамгаалалт хэрэглэнэ:
//  1. Compile-ийн өмнөх STATIC шинжилгээ (энэ файл): давтагдах бүлэг дотор давталт/сонголт (`(a+)+`, `(a|aa)*`, `(a?){30}`) орсон,
//     back-reference (`\1`, `\k<n>`), хэт том `{n,m}`, хоосон текстэд таардаг, хязгааргүй давталт (`*`, `+`, `{n,}`) 2-оос олон
//     хэв бүгдийг НЭГ ТАЛААС зөвшөөрөхгүй (консерватив: зарим аюулгүй хэв ч татгалзагдана — admin энгийн хэлбэрээр бичнэ).
//  2. Оролтын текстийг maxInputLength (300)-аар тайрна → зөвшөөрөгдсөн (k ≤ 2 хязгааргүй давталттай) хэвийн хамгийн муу хугацаа O(300²).
//  3. Дүрэм бүрийг compile-д нэг удаа шалгаж, буруу бол ТАСЛАХ (ангилагч бусад дүрмээрээ үргэлжилнэ, issue буцаана).
// Тусгай flag: 'iu' (том/жижиг үл ялгах, unicode); 'g'/'y' ашиглахгүй тул lastIndex төлөвгүй.
import { REGEX_LIMITS } from './classify.defaults';

export type RegexRejectCode = 'REGEX_EMPTY' | 'REGEX_TOO_LONG' | 'REGEX_INVALID' | 'REGEX_UNSAFE';
export type SafeRegexResult = { ok: true; regex: RegExp } | { ok: false; code: RegexRejectCode; reason: string };
export type RegexLimits = { [K in keyof typeof REGEX_LIMITS]: number };

interface Frame {
  /** Бүлэг (эсвэл түүний дотор) хувьсах давталт (`*`, `+`, `?`, `{n,m}` n<m) агуулсан */
  variable: boolean;
  /** Бүлэг (эсвэл түүний дотор) сонголт `|` агуулсан */
  alternation: boolean;
}

interface Quantifier {
  end: number;
  min: number;
  max: number;
}

const BRACE_QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

function parseQuantifier(src: string, i: number): Quantifier | null {
  let q: Omit<Quantifier, 'end'> | null = null;
  let end = i + 1;
  const ch = src[i];
  if (ch === '*') q = { min: 0, max: Infinity };
  else if (ch === '+') q = { min: 1, max: Infinity };
  else if (ch === '?') q = { min: 0, max: 1 };
  else if (ch === '{') {
    const m = BRACE_QUANTIFIER.exec(src.slice(i, i + 24));
    if (!m) return null;
    end = i + m[0].length;
    const min = Number(m[1]);
    q = { min, max: m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]) };
  }
  if (!q) return null;
  if (src[end] === '?') end++; // lazy marker
  return { ...q, end };
}

/** Аюултай бол шалтгааг, аюулгүй бол null буцаана. `src` нь аль хэдийн `new RegExp(src, 'iu')`-д зөв гэж батлагдсан байх ёстой. */
export function findUnsafeRegexReason(src: string, limits: RegexLimits = REGEX_LIMITS): string | null {
  const stack: Frame[] = [];
  let cur: Frame = { variable: false, alternation: false };
  let closedGroup: Frame | null = null;
  let unbounded = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if ((next >= '1' && next <= '9') || next === 'k') return 'back-reference is not allowed';
      if ((next === 'p' || next === 'P' || next === 'u') && src[i + 2] === '{') {
        const close = src.indexOf('}', i + 2);
        i = close < 0 ? src.length : close + 1;
      } else i += 2;
      closedGroup = null;
      continue;
    }
    if (ch === '[') {
      i++;
      if (src[i] === '^') i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      closedGroup = null;
      continue;
    }
    if (ch === '(') {
      stack.push(cur);
      cur = { variable: false, alternation: false };
      i++;
      if (src[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i++;
        if (src[i] === '<' && (src[i + 1] === '=' || src[i + 1] === '!')) i += 2;
        else if (src[i] === '<') i = src.indexOf('>', i) + 1 || src.length;
        else i++;
      }
      closedGroup = null;
      continue;
    }
    if (ch === ')') {
      const parent = stack.pop() ?? { variable: false, alternation: false };
      parent.variable ||= cur.variable;
      parent.alternation ||= cur.alternation;
      closedGroup = cur;
      cur = parent;
      i++;
      continue;
    }
    if (ch === '|') {
      cur.alternation = true;
      closedGroup = null;
      i++;
      continue;
    }
    const q = parseQuantifier(src, i);
    if (q) {
      if (q.max !== Infinity && q.max > limits.maxBoundedRepeat) return `repeat count exceeds ${limits.maxBoundedRepeat}`;
      if (q.max === Infinity && ++unbounded > limits.maxUnboundedQuantifiers) {
        return `more than ${limits.maxUnboundedQuantifiers} unbounded quantifiers`;
      }
      if (closedGroup && q.max > 1 && (closedGroup.variable || closedGroup.alternation)) {
        return 'repeated group contains a quantifier or alternation (nested quantifier)';
      }
      if (q.min !== q.max) cur.variable = true;
      closedGroup = null;
      i = q.end;
      continue;
    }
    closedGroup = null;
    i++;
  }
  return null;
}

/** Admin-ийн regex-ийг шалгаж compile хийнэ. Татгалзвал шалтгааны код + (PII-гүй) тайлбар. */
export function compileSafeRegex(pattern: string, limits: RegexLimits = REGEX_LIMITS): SafeRegexResult {
  if (typeof pattern !== 'string' || pattern.trim() === '') return { ok: false, code: 'REGEX_EMPTY', reason: 'pattern is empty' };
  if (pattern.length > limits.maxPatternLength) {
    return { ok: false, code: 'REGEX_TOO_LONG', reason: `pattern is longer than ${limits.maxPatternLength} characters` };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'iu');
  } catch {
    return { ok: false, code: 'REGEX_INVALID', reason: 'pattern has a syntax error' };
  }
  const unsafe = findUnsafeRegexReason(pattern, limits);
  if (unsafe) return { ok: false, code: 'REGEX_UNSAFE', reason: unsafe };
  if (regex.test('')) return { ok: false, code: 'REGEX_UNSAFE', reason: 'pattern matches the empty text' };
  return { ok: true, regex };
}

/** Оролтыг maxInputLength-аар тайрч regex ажиллуулна. Зөвхөн compileSafeRegex-ээр гарсан regex-д хэрэглэнэ. */
export function testSafeRegex(regex: RegExp, text: string, limits: RegexLimits = REGEX_LIMITS): boolean {
  return regex.test(text.length > limits.maxInputLength ? text.slice(0, limits.maxInputLength) : text);
}
