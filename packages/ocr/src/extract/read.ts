// Шошгоны дараах утгыг уншиж задлах нийтлэг туслахууд (ID карт, цалингийн тодорхойлолт хуваалцана).
import { toMatchKey } from '../text';
import { resolveMixedScriptWords } from '../text/script';
import { EXTRACT_DEFAULTS } from './defaults';
import type { OcrDoc } from './doc';
import { titleCaseIfAllUpper } from './field';
import { valueCandidates, type LabelHit, type ValueCandidate } from './labels';

export interface Segment {
  /** Эх текст */
  text: string;
  /** Тоон задлалтад зориулсан (O→0 гэх мэт засагдсан) хуулбар, ижил урт */
  num: string;
  start: number;
  end: number;
}

export interface LabelRead<T> {
  value: T;
  seg: Segment;
  cand: ValueCandidate;
}

/** Талбарын нэр дэвшигчдийг дарааллаар нь parse хийж, анхных нь амжилттайг буцаана. */
export function readLabelled<T>(doc: OcrDoc, hits: readonly LabelHit[], field: string, parse: (seg: Segment) => T | null): LabelRead<T> | null {
  const seen = new Set<string>();
  for (const cand of valueCandidates(doc, hits, field)) {
    const key = `${cand.start}:${cand.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const seg: Segment = { text: doc.text.slice(cand.start, cand.end), num: doc.numText.slice(cand.start, cand.end), start: cand.start, end: cand.end };
    const value = parse(seg);
    if (value !== null) return { value, seg, cand };
  }
  return null;
}

/** Шошгоны дараах түүхий хэсгийн захын тусгаарлагч ( : / | . - _ = ) ба зайг хасна (raw талбарт). */
export const trimSeparators = (s: string): string => s.replace(/^[\s:;/|\\.,\-–—_=]+|[\s:;/|\\,_=]+$/g, '');

export interface CleanName {
  value: string;
  /** Нэрэнд тоо орсон эсвэл илүү үг тайрагдсан */
  noisy: boolean;
}

/**
 * Шошгоны дараах хэсгээс хүний нэр гаргана: '/' эсвэл '|' өмнөх хэсэг (хоёр хэлтэй "Дорж / Dorj"), зөвхөн үсэг, ганц латин үсэг
 * (OCR-ийн '|' 'l' 'I') хаяна, холимог үсгийн үгийг кирилл/латин болгож нэгтгэнэ, БҮХЭЛДЭЭ том үсэгтэй үгийг Title Case болгоно.
 */
export function cleanName(segment: string, maxTokens: number = EXTRACT_DEFAULTS.maxNameTokens): CleanName | null {
  const first = segment.split(/[/|\\]/).map((s) => s.trim()).find((s) => /\p{L}/u.test(s));
  if (!first) return null;
  const tokens = (first.match(/\p{L}[\p{L}'’.-]*/gu) ?? []).map((t) => t.replace(/[.-]+$/, '')).filter((t) => t !== '' && !(t.length === 1 && /[A-Za-z]/.test(t)));
  if (tokens.length === 0) return null;
  const kept = tokens.slice(0, maxTokens).map((t) => titleCaseIfAllUpper(resolveMixedScriptWords(t)));
  return { value: kept.join(' '), noisy: /\d/.test(first) || tokens.length > maxTokens };
}

const MALE_KEYS = new Set(['Эр', 'Эрэгтэй', 'Male', 'M'].map((s) => toMatchKey(s)));
const FEMALE_KEYS = new Set(['Эм', 'Эмэгтэй', 'Female', 'F'].map((s) => toMatchKey(s)));

/** 'Эр / Male', 'ЭМ', 'Эмэгтэй' → 'M' | 'F'. Зөрчилтэй/танигдаагүй бол null. */
export function parseGender(segment: string): 'M' | 'F' | null {
  const found = new Set<'M' | 'F'>();
  for (const tok of (segment.match(/\p{L}+/gu) ?? []).slice(0, 4)) {
    const key = toMatchKey(tok);
    if (MALE_KEYS.has(key)) found.add('M');
    else if (FEMALE_KEYS.has(key)) found.add('F');
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Үнэмлэхний дугаар: ≥ 4 цифртэй, 5-14 тэмдэгтийн үсэг/цифрийн үг. Том үсэг болгоно. */
export function parseCardNumber(segment: string): string | null {
  for (const tok of segment.match(/[\p{L}\p{N}]{5,14}/gu) ?? []) {
    if ((tok.match(/\d/g) ?? []).length >= 4) return tok.toUpperCase();
  }
  return null;
}
