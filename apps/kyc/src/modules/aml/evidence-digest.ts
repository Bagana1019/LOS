import { createHash } from 'node:crypto';
import type { HitCandidate } from './engine/screening-engine';

/** Service нэмдэг тэмдэглэгээнүүд: нотолгооны хуруун мөрөнд ОРОХГҮЙ (engine-ийн candidate-д байхгүй, давтан бодоход тогтвортой байлгана). */
const SERVICE_MARKERS = ['carriedOverFrom', 'evidenceDigest', 'reopenedBecause'] as const;

/** Түлхүүрийг эрэмбэлсэн (каноник) JSON: ижил утга үргэлж ижил текст. Массивын дараалал хадгалагдана, undefined түлхүүр алгасагдана. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['toJSON'] === 'function') return canonicalJson((obj['toJSON'] as () => unknown)());
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hit-ийн нотолгооны хуруун мөр (FR-3.4): жагсаалт, бүртгэл, тохирлын төрөл, severity, оноо болон engine-ийн details (төрсөн он, FATF ангилал,
 * нэрс…) -ийн sha256 hex. Жагсаалтын ХУВИЛБАР ороогүй — нотолгоо өөрчлөгдөөгүй бол хувилбар солигдсон ч ижил. FALSE_POSITIVE шийдвэр
 * зөвхөн хуруун мөр тэнцүү үед дамжина; өөрчлөгдсөн бол hit дахин нээгдэнэ.
 */
export function evidenceDigestOf(candidate: Pick<HitCandidate, 'list' | 'entryRef' | 'matchType' | 'severity' | 'score' | 'details'>): string {
  const details = { ...candidate.details };
  for (const marker of SERVICE_MARKERS) delete details[marker];
  const { list, entryRef, matchType, severity, score } = candidate;
  return createHash('sha256').update(canonicalJson({ list, entryRef, matchType, severity, score, details })).digest('hex');
}
