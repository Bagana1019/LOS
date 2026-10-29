// SALARY_CERTIFICATE (Цалингийн тодорхойлолт) талбар задлалт: employerName, employeeName, registerNo, position, monthlySalary,
// issueDate, periodFrom/periodTo/periodMonths. Утга нь ихэвчлэн ӨГҮҮЛБЭРТ байдаг тул шошго + өгүүлбэрийн хэв маяг хоёуланг ашиглана.
// monthlySalary: 'цалин' түлхүүр үгийн ойролцоох, мөнгөн тэмдэгтэй дүнг сонгоно; утас, он, огноо, регистр, дугаарыг хасна.
// TODO(samples): бодит тодорхойлолтын загвар байхгүй — хэв маяг зохиомол, баталгаажаагүй.
import { foldLatinLookalikesToCyrillic } from '../text';
import { EXTRACT_DEFAULTS, type ExtractSettings } from './defaults';
import type { OcrDoc } from './doc';
import { combineConfidence, emptyField, makeField } from './field';
import { findAllLabelHits, type LabelDef } from './labels';
import { cleanName, readLabelled, trimSeparators } from './read';
import { resolveRegisterNo } from './register-field';
import { findAmounts, findIbans, findIsoDates, findPhones, findRegisterCandidates, findTimes, maskSpans, type AmountCandidate } from './scan';
import type { FieldsResult } from './id-card';
import type { ExtractedField } from './types';

export const SALARY_CERTIFICATE_LABELS: readonly LabelDef[] = [
  { field: 'employerName', labels: ['Байгууллагын нэр', 'Ажил олгогч', 'Компанийн нэр', 'Employer', 'Company name'] },
  { field: 'employeeName', labels: ['Ажилтны нэр', 'Овог нэр', 'Employee name'] },
  { field: 'registerNo', labels: ['Регистрийн дугаар', 'Регистр', 'РД', 'Register number', 'Register no'] },
  { field: 'position', labels: ['Албан тушаал', 'Ажил мэргэжил', 'Position', 'Job title'] },
  { field: 'issueDate', labels: ['Олгосон огноо', 'Огноо', 'Date of issue'] },
];

// Ө/Ү нь OCR-д О/У болж алдагддаг
const tol = (s: string): string => s.replace(/Ө/g, '[ӨО]').replace(/Ү/g, '[ҮУ]');
const LEGAL_FORMS = ['ХХК', 'ХК', 'ББСБ', 'ТӨҮГ', 'ОНӨҮГ', 'НӨҮГ', 'ОНӨААТҮГ', 'ТӨК', 'ТББ', 'СӨХ'].map(tol);
const LEGAL_FORM_RE = new RegExp(`(?<![\\p{L}])(?:${LEGAL_FORMS.join('|')})(?![\\p{L}])`, 'iu');
const HEADER_LINES = 12;

const SALARY_KEYWORD_RE = /цал[иi]н|х[оө]лс|сарын\s+[оө]рл[оө]г/iu;
const SALARY_NEGATIVE_RE = /татвар|суутг|урамшуул|шагнал|ндш|нэмэгдэл|бонус|тэтгэвэр/iu;
const AVERAGE_RE = /дундаж|сарын/iu;
const DOC_NUMBER_BEFORE_RE = /(?:№|дугаар|no\.?|тоот)\s*$/iu;
const YEAR_AFTER_RE = /^\s*(?:он|оны|оноос|жил)/iu;

const trimQuotes = (s: string): string => s.replace(/["«»“”„]/g, '').replace(/\s+/g, ' ').trim();

/** Мөрөөс байгууллагын нэрийг гаргана: богино мөр бол бүтнээр нь, өгүүлбэр бол хашилт/томоор эхэлсэн үгсээс + хэлбэр. */
function orgFromLine(text: string, formIdx: number, formLen: number): string {
  if (text.length <= 80) return trimQuotes(text);
  const before = text.slice(0, formIdx);
  const form = text.slice(formIdx, formIdx + formLen);
  const quoted = /["«“„]([^"»”“„]{2,60})["»”“]\s*$/u.exec(before);
  if (quoted) return trimQuotes(`${quoted[1]} ${form}`);
  const words = /((?:\p{Lu}[\p{L}-]*\s+){1,4})$/u.exec(before);
  return trimQuotes(`${words ? words[1] : ''}${form}`);
}

function findEmployer(doc: OcrDoc, hits: ReturnType<typeof findAllLabelHits>, settings: ExtractSettings): ExtractedField {
  const labelled = readLabelled(doc, hits, 'employerName', (seg) => {
    const t = trimQuotes(seg.text.replace(/^[\s:;/|.\-–]+/, ''));
    return t.length >= 2 ? t : null;
  });
  if (labelled) {
    const conf = combineConfidence(doc.spanConf(labelled.seg.start, labelled.seg.end), { labelDistance: labelled.cand.hit.distance });
    return makeField({ value: labelled.value.slice(0, 120), raw: trimSeparators(labelled.seg.text), confidence: conf }, settings);
  }
  // хэв маяг: хуулийн хэлбэр (ХХК, ХК...) агуулсан мөр — эхлээд толгой хэсэгт (letterhead)
  const ordered = [...doc.lines.slice(0, HEADER_LINES), ...doc.lines.slice(HEADER_LINES)];
  for (const line of ordered) {
    const m = LEGAL_FORM_RE.exec(foldLatinLookalikesToCyrillic(line.text));
    if (!m) continue;
    const value = orgFromLine(line.text, m.index, m[0].length);
    const conf = combineConfidence(doc.spanConf(line.start, line.end), { heuristic: true });
    return makeField({ value: value.slice(0, 120), raw: line.text, confidence: conf }, settings);
  }
  return emptyField('Олдсонгүй');
}

function findEmployee(doc: OcrDoc, hits: ReturnType<typeof findAllLabelHits>, settings: ExtractSettings): ExtractedField {
  const labelled = readLabelled(doc, hits, 'employeeName', (seg) => cleanName(seg.text.split(/[(,;\d]/)[0]));
  if (labelled) {
    const conf = combineConfidence(doc.spanConf(labelled.seg.start, labelled.seg.end), { labelDistance: labelled.cand.hit.distance });
    return makeField({ value: labelled.value.value, raw: trimSeparators(labelled.seg.text), confidence: labelled.value.noisy ? conf * 0.85 : conf }, settings);
  }
  // "Дорж овогтой Болд" → "Дорж Болд" (Овог Нэр)
  const folded = foldLatinLookalikesToCyrillic(doc.text);
  const m = /([\p{L}.-]+)\s+ов[оө]гт[оө]й\s+([\p{L}.-]+)/iu.exec(folded);
  if (m) {
    const start = m.index;
    const end = start + m[0].length;
    const a = cleanName(doc.text.slice(start, start + m[1].length));
    const b = cleanName(doc.text.slice(end - m[2].length, end));
    if (a && b) return makeField({ value: `${a.value} ${b.value}`, raw: doc.text.slice(start, end).replace(/\s+/g, ' '), confidence: combineConfidence(doc.spanConf(start, end), { heuristic: true }) }, settings);
  }
  return emptyField('Олдсонгүй');
}

const INSTRUMENTAL_RE = /([\p{L}-]+(?:аар|ээр|оор|өөр))\s+ажил(?:лаж|ладаг|лах|тай)/iu;
/** Албан тушаалын өмнөх үг биш (өгүүлбэрийн бусад хэсэг): -аас/-д тийн ялгал, 'хойш', 'нь' г.м. */
const POSITION_BOUNDARY_RE = /^(?:нь|хойш|бөгөөд|тус|манай|дараа|өмнө|мөн|одоо|анх)$|(?:аас|ээс|оос|өөс|д)$/iu;
const POSITION_MAX_WORDS = 5;

/** "...хойш Санхүүгийн албаны мэргэжилтнээр ажиллаж..." → "Санхүүгийн албаны мэргэжилтнээр": -ээр үгээс хойш хилийн үг хүртэл ухарна. */
function positionPhrase(folded: string): { start: number; end: number } | null {
  const m = INSTRUMENTAL_RE.exec(folded);
  if (!m) return null;
  const end = m.index + m[1].length;
  let start = m.index;
  for (let n = 1; n < POSITION_MAX_WORDS; n++) {
    const prev = /([\p{L}-]+)\s+$/u.exec(folded.slice(Math.max(0, start - 40), start));
    if (!prev || POSITION_BOUNDARY_RE.test(prev[1])) break;
    start -= prev[0].length;
  }
  return { start, end };
}

function findPosition(doc: OcrDoc, hits: ReturnType<typeof findAllLabelHits>, settings: ExtractSettings): ExtractedField {
  const labelled = readLabelled(doc, hits, 'position', (seg) => {
    const t = seg.text.replace(/^[\s:;/|.\-–]+/, '').split(/[(,;]/)[0].trim();
    return t.length >= 2 && /\p{L}/u.test(t) ? t.slice(0, 80) : null;
  });
  if (labelled) {
    const conf = combineConfidence(doc.spanConf(labelled.seg.start, labelled.seg.end), { labelDistance: labelled.cand.hit.distance });
    return makeField({ value: labelled.value, raw: trimSeparators(labelled.seg.text), confidence: conf }, settings);
  }
  const span = positionPhrase(foldLatinLookalikesToCyrillic(doc.text));
  if (!span) return emptyField('Олдсонгүй');
  const { start, end } = span;
  const raw = doc.text.slice(start, end).replace(/\s+/g, ' ');
  const text = raw.replace(/(^|\s)-+(?=\p{L})/gu, '$1'); // OCR-ийн илүү зураас ("-мэргэжилтнээр")
  return makeField(
    { value: text, raw, confidence: combineConfidence(doc.spanConf(start, end), { heuristic: true }), notes: ['Өгүүлбэрээс авсан - тийн ялгалтай (-ээр/-аар) хэлбэртэй байж болно'] },
    settings,
  );
}

function findIssueDate(doc: OcrDoc, hits: ReturnType<typeof findAllLabelHits>, settings: ExtractSettings): ExtractedField {
  const labelled = readLabelled(doc, hits, 'issueDate', (seg) => {
    const d = findIsoDates(seg.num);
    return d.length > 0 ? d[0] : null;
  });
  if (labelled) {
    const d = labelled.value;
    const conf = combineConfidence(doc.spanConf(labelled.seg.start + d.start, labelled.seg.start + d.end), { validated: true, labelDistance: labelled.cand.hit.distance });
    return makeField({ value: d.iso, raw: d.raw, confidence: conf }, settings);
  }
  // шошгогүй: толгой хэсгийн (эхний 8 мөр) эхний огноо, үгүй бол баримтын эхний огноо
  const all = findIsoDates(doc.numText);
  const headerEnd = doc.lines[Math.min(7, doc.lines.length - 1)]?.end ?? 0;
  const d = all.find((x) => x.start <= headerEnd) ?? all[0];
  if (!d) return emptyField('Олдсонгүй');
  return makeField({ value: d.iso, raw: d.raw, confidence: combineConfidence(doc.spanConf(d.start, d.end), { validated: true, heuristic: true }) }, settings);
}

// ---- Цалин ----
interface ScoredAmount extends AmountCandidate {
  score: number;
}

/** Regex-ийн сүүлчийн таарсан байрлал (олдохгүй бол -1) */
function lastMatchIndex(re: RegExp, text: string): number {
  let idx = -1;
  for (const m of text.matchAll(new RegExp(re.source, 'giu'))) idx = m.index ?? idx;
  return idx;
}

function scoreAmounts(doc: OcrDoc, settings: ExtractSettings): ScoredAmount[] {
  const regs = findRegisterCandidates(doc.text).filter((c) => c.info.valid);
  const masked = maskSpans(doc.numText, [...findIsoDates(doc.numText), ...regs, ...findIbans(doc.text), ...findTimes(doc.numText), ...findPhones(doc.numText)]);
  const folded = foldLatinLookalikesToCyrillic(masked);
  const out: ScoredAmount[] = [];
  for (const c of findAmounts(masked)) {
    if (c.value < settings.minSalary || c.value > settings.maxSalary) continue;
    const plainYear = /^\d{4}$/.test(c.raw) && c.value >= 1900 && c.value <= 2100;
    if (plainYear && (!c.currency || YEAR_AFTER_RE.test(folded.slice(c.end, c.end + 10)))) continue;
    if (DOC_NUMBER_BEFORE_RE.test(folded.slice(Math.max(0, c.start - 12), c.start))) continue;
    const before60 = folded.slice(Math.max(0, c.start - 60), c.start);
    const before120 = folded.slice(Math.max(0, c.start - 120), Math.max(0, c.start - 60));
    const after25 = folded.slice(c.end, c.end + 25);
    const salaryAt = lastMatchIndex(SALARY_KEYWORD_RE, before60);
    const negativeAt = lastMatchIndex(SALARY_NEGATIVE_RE, before60);
    let score = 0;
    if (salaryAt >= 0 || SALARY_KEYWORD_RE.test(after25)) score += 3;
    else if (SALARY_KEYWORD_RE.test(before120)) score += 1;
    if (c.currency) score += 2;
    if (AVERAGE_RE.test(before60)) score += 1;
    if (negativeAt > salaryAt) score -= 4; // шагнал/татвар/нэмэгдэл нь цалингийн түлхүүр үгээс ДҮНД ойр → тэр дүн цалин биш
    out.push({ ...c, score });
  }
  return out;
}

function findSalary(doc: OcrDoc, settings: ExtractSettings, warnings: string[]): ExtractedField {
  const scored = scoreAmounts(doc, settings).sort((a, b) => b.score - a.score || a.start - b.start);
  const strong = scored.filter((c) => c.score >= EXTRACT_DEFAULTS.salaryMinScore);
  if (strong.length === 0) {
    return emptyField(scored.length > 0 ? 'Цалингийн дүн итгэлтэй тодорхойлогдсонгүй (түлхүүр үг ойролцоо олдсонгүй)' : 'Олдсонгүй');
  }
  const best = strong[0];
  const distinct = [...new Set(strong.map((c) => c.value))];
  const others = distinct.filter((v) => v !== best.value);
  const keywordAndCurrency = best.score >= EXTRACT_DEFAULTS.salaryMinScore + 2;
  let confidence = combineConfidence(doc.spanConf(best.start, best.end), { validated: keywordAndCurrency, heuristic: !keywordAndCurrency });
  if (others.length > 0) {
    confidence = Math.round(confidence * 0.8 * 1000) / 1000;
    warnings.push(`monthlySalary: ${distinct.length} өөр цалингийн дүн олдлоо - зөв дүнг гараар сонгоно уу`);
  }
  return makeField(
    {
      value: best.value,
      raw: best.raw,
      confidence,
      alternatives: others,
      notes: [others.length > 0 ? 'Хэд хэдэн цалингийн дүн олдсон' : undefined],
    },
    settings,
  );
}

// ---- Хугацаа ----
const PERIOD_RE =
  /(\d{4})\s*оны\s*(\d{1,2})(?:\s*-?\s*(?:р|дугаар|дүгээр))?\s*сараас\s*(?:(\d{4})\s*оны\s*)?(\d{1,2})(?:\s*-?\s*(?:р|дугаар|дүгээр))?\s*сар(?:ын)?/iu;
const MONTHS_RE = /сүүлийн\s*(\d{1,2})\s*сар|(\d{1,2})\s*сарын\s*дундаж/iu;
const ym = (y: number, m: number): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;

function findPeriod(doc: OcrDoc, settings: ExtractSettings): Record<string, ExtractedField> {
  const folded = foldLatinLookalikesToCyrillic(doc.numText);
  const out: Record<string, ExtractedField> = { periodFrom: emptyField(), periodTo: emptyField(), periodMonths: emptyField() };
  let fromTo: { y1: number; m1: number; y2: number; m2: number } | null = null;
  const p = PERIOD_RE.exec(folded);
  if (p) {
    const y1 = Number(p[1]);
    const m1 = Number(p[2]);
    const m2 = Number(p[4]);
    const y2 = p[3] ? Number(p[3]) : m2 < m1 ? y1 + 1 : y1;
    if (m1 >= 1 && m1 <= 12 && m2 >= 1 && m2 <= 12 && y1 >= 1900 && y2 <= 2100 && y2 * 12 + m2 >= y1 * 12 + m1) {
      fromTo = { y1, m1, y2, m2 };
      const conf = combineConfidence(doc.spanConf(p.index, p.index + p[0].length), { validated: true });
      out.periodFrom = makeField({ value: ym(y1, m1), raw: p[0].replace(/\s+/g, ' '), confidence: conf }, settings);
      out.periodTo = makeField({ value: ym(y2, m2), raw: p[0].replace(/\s+/g, ' '), confidence: conf }, settings);
    }
  }
  const mm = MONTHS_RE.exec(folded);
  const months = mm ? Number(mm[1] ?? mm[2]) : NaN;
  if (mm && months >= 1 && months <= 60) {
    out.periodMonths = makeField({ value: months, raw: mm[0], confidence: combineConfidence(doc.spanConf(mm.index, mm.index + mm[0].length), { validated: true }) }, settings);
  } else if (fromTo) {
    const n = fromTo.y2 * 12 + fromTo.m2 - (fromTo.y1 * 12 + fromTo.m1) + 1;
    out.periodMonths = makeField({ value: n, raw: null, confidence: combineConfidence(out.periodFrom.confidence, { derived: true }), notes: ['Хугацааны эхлэл/төгсгөлөөс тооцоолсон'] }, settings);
  }
  return out;
}

export function extractSalaryCertificate(doc: OcrDoc, settings: ExtractSettings): FieldsResult {
  const hits = findAllLabelHits(doc, SALARY_CERTIFICATE_LABELS);
  const warnings: string[] = [];
  const reg = resolveRegisterNo(doc, hits, settings);
  // регистр олдоогүй нь тодорхойлолтод ноцтой биш (заавал биш) — зөвхөн буруу бол анхааруулна
  warnings.push(...reg.warnings.filter((w) => !w.endsWith('олдсонгүй')));
  const period = findPeriod(doc, settings);
  const fields: Record<string, ExtractedField> = {
    employerName: findEmployer(doc, hits, settings),
    employeeName: findEmployee(doc, hits, settings),
    registerNo: reg.field,
    position: findPosition(doc, hits, settings),
    monthlySalary: findSalary(doc, settings, warnings),
    issueDate: findIssueDate(doc, hits, settings),
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    periodMonths: period.periodMonths,
  };
  return { fields, warnings };
}
