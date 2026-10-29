// ExtractedField бүтээх ба итгэл нэгтгэх. Итгэл = тааруулсан хэсгийн OCR үгсийн итгэл, баталгаажуулалтаар (checksum/хуанли) өсч/унана.
import { EXTRACT_DEFAULTS, type ExtractSettings } from './defaults';
import type { ExtractedField, ExtractedValue } from './types';

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface ConfidenceFactors {
  /** checksum/хуанлийн шалгалт өнгөрсөн */
  validated?: boolean;
  /** шалгалт бүтэлгүйтсэн */
  failed?: boolean;
  /** шошго шуугиантай (засварын зай) */
  labelDistance?: number;
  /** шошгогүй, зөвхөн хэв маягаар олсон */
  heuristic?: boolean;
  /** өөр талбараас тооцоолсон */
  derived?: boolean;
}

/** spanConf (0..1) ба хүчин зүйлсээс эцсийн итгэл (3 орон). */
export function combineConfidence(spanConf: number, f: ConfidenceFactors = {}): number {
  let c = clamp01(spanConf);
  if (f.validated) c += (1 - c) * EXTRACT_DEFAULTS.validationBoost;
  if (f.failed) c *= EXTRACT_DEFAULTS.invalidPenalty;
  if (f.heuristic) c *= EXTRACT_DEFAULTS.heuristicFactor;
  if (f.derived) c *= EXTRACT_DEFAULTS.derivedFactor;
  c -= (f.labelDistance ?? 0) * EXTRACT_DEFAULTS.labelTypoPenalty;
  return round3(clamp01(c));
}

export const emptyField = (note?: string): ExtractedField => (note ? { value: null, confidence: 0, raw: null, note } : { value: null, confidence: 0, raw: null });

export interface MakeFieldArgs {
  value: ExtractedValue;
  raw: string | null;
  confidence: number;
  notes?: Array<string | undefined>;
  alternatives?: Array<string | number>;
}

/** Талбар бүтээнэ; итгэл босгоноос бага (ба утгатай) бол note-д анхааруулга нэмнэ. */
export function makeField(a: MakeFieldArgs, settings: Pick<ExtractSettings, 'lowConfidenceThreshold'>): ExtractedField {
  const notes = (a.notes ?? []).filter((n): n is string => Boolean(n));
  const hasValue = a.value !== null && !(Array.isArray(a.value) && a.value.length === 0);
  if (hasValue && a.confidence < settings.lowConfidenceThreshold) notes.push(`Итгэл бага (${Math.round(a.confidence * 100)}%) - гараар шалгана уу`);
  const field: ExtractedField = { value: a.value, confidence: a.confidence, raw: a.raw };
  if (notes.length > 0) field.note = notes.join('; ');
  if (a.alternatives && a.alternatives.length > 0) field.alternatives = a.alternatives;
  return field;
}

/** 'Бат-Эрдэнэ', 'ДОРЖ' → зөвхөн БҮХЭЛДЭЭ том үсэгтэй үгийг Title Case болгоно (бусдыг хэвээр). */
export function titleCaseIfAllUpper(word: string): string {
  if (word.length < 2 || word !== word.toUpperCase() || word === word.toLowerCase()) return word;
  return word
    .split('-')
    .map((p) => (p === '' ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join('-');
}
