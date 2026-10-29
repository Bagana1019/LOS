// Баримтын төрөл таних: онцлог шошго/гарчгийн олдсон тоо (жинтэй) → 0..1 оноо. Бүх шошгыг fuzzy (OCR-ийн шуугианд тэсвэртэй) тааруулна.
import { foldLatinLookalikesToCyrillic } from '../text';
import { EXTRACT_DEFAULTS } from './defaults';
import { buildDoc, type OcrDoc } from './doc';
import { ID_CARD_LABELS } from './id-card';
import { findAllLabelHits, type LabelDef } from './labels';
import { findRegisterCandidates } from './scan';
import type { OcrResult } from '../types';
import type { OcrDocType } from './types';

interface Signal {
  /** шошгын талбарын нэр → жин */
  weights: Readonly<Record<string, number>>;
  defs: readonly LabelDef[];
  /** хамгийн их боломжит оноо (нормчлол) */
  max: number;
}

const ID_SIGNAL: Signal = {
  defs: [
    { field: 'title', labels: ['Иргэний үнэмлэх', 'Identity card'] },
    { field: 'country', labels: ['Монгол улс', 'Mongolia'] },
    ...ID_CARD_LABELS,
  ],
  weights: { title: 3, country: 1, lastName: 1, firstName: 1, registerNo: 1, birthDate: 1, gender: 1, cardNumber: 1, expiryDate: 1, patronymic: 0.5, issueDate: 0.5 },
  max: 8,
};

const SALARY_SIGNAL: Signal = {
  defs: [
    { field: 'title', labels: ['Цалингийн тодорхойлолт', 'Salary certificate', 'Цалин тодорхойлолт'] },
    { field: 'certificate', labels: ['Тодорхойлолт', 'Certificate'] },
    { field: 'salary', labels: ['Цалин', 'Цалингийн', 'Salary'] },
    { field: 'position', labels: ['Албан тушаал', 'Position'] },
    { field: 'employee', labels: ['Ажилтны нэр', 'Employee name'] },
  ],
  weights: { title: 3, certificate: 1, salary: 1.5, position: 0.5, employee: 0.5 },
  max: 7,
};

const WORK_VERB_RE = /ажил(?:лаж|ладаг|лах)/iu;
const LEGAL_FORM_RE = /(?<![\p{L}])(?:ХХК|ХК|ББСБ|ТӨҮГ|ОНӨҮГ|НӨҮГ)(?![\p{L}])/iu;

function signalScore(doc: OcrDoc, signal: Signal): number {
  const hits = findAllLabelHits(doc, signal.defs);
  const seen = new Set(hits.map((h) => h.field));
  let total = 0;
  for (const f of seen) total += signal.weights[f] ?? 0;
  return total;
}

export interface DetectedDocType {
  /** Таних оноо хүрэлцээгүй бол 'GENERIC' */
  docType: OcrDocType;
  /** 0..1 — хамгийн сайн төрлийн оноо */
  score: number;
}

export function detectFromDoc(doc: OcrDoc, minScore: number = EXTRACT_DEFAULTS.detectMinScore): DetectedDocType {
  let id = signalScore(doc, ID_SIGNAL);
  if (findRegisterCandidates(doc.text).some((c) => c.info.valid)) id += 1;
  let salary = signalScore(doc, SALARY_SIGNAL);
  const folded = foldLatinLookalikesToCyrillic(doc.text);
  if (WORK_VERB_RE.test(folded)) salary += 1;
  if (LEGAL_FORM_RE.test(folded)) salary += 1;
  if (/төгрөг|₮|mnt/iu.test(folded)) salary += 0.5;
  const idScore = Math.min(1, id / ID_SIGNAL.max);
  const salaryScore = Math.min(1, salary / SALARY_SIGNAL.max);
  const best: DetectedDocType = idScore >= salaryScore ? { docType: 'ID_CARD', score: idScore } : { docType: 'SALARY_CERTIFICATE', score: salaryScore };
  return best.score >= minScore ? { ...best, score: Math.round(best.score * 1000) / 1000 } : { docType: 'GENERIC', score: Math.round(best.score * 1000) / 1000 };
}

/** Баримтын төрлийг OCR үр дүнгээс таних. Хүрэлцээгүй бол { docType: 'GENERIC' }. */
export function detectDocType(ocr: OcrResult): DetectedDocType {
  return detectFromDoc(buildDoc(ocr));
}
