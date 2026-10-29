// extractDocument — OcrResult + баримтын төрлөөс (эсвэл AUTO) талбаруудыг задлах нэгдсэн орох цэг. Цэвэр функц (цаг, I/O байхгүй).
import type { OcrResult } from '../types';
import { EXTRACT_DEFAULTS, type ExtractSettings } from './defaults';
import { buildDoc } from './doc';
import { detectFromDoc } from './detect';
import { extractGeneric } from './generic';
import { extractIdCard, type FieldsResult } from './id-card';
import { extractSalaryCertificate } from './salary-certificate';
import type { DocumentExtraction, ExtractOptions, OcrDocType } from './types';

const TODAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveSettings(options: ExtractOptions = {}): ExtractSettings {
  const today = options.today && TODAY_RE.test(options.today) ? options.today : null;
  return {
    lowConfidenceThreshold: options.lowConfidenceThreshold ?? EXTRACT_DEFAULTS.lowConfidenceThreshold,
    today,
    minSalary: options.minSalary ?? EXTRACT_DEFAULTS.minSalary,
    maxSalary: options.maxSalary ?? EXTRACT_DEFAULTS.maxSalary,
  };
}

const EXTRACTORS: Record<OcrDocType, (doc: ReturnType<typeof buildDoc>, s: ExtractSettings) => FieldsResult> = {
  ID_CARD: extractIdCard,
  SALARY_CERTIFICATE: extractSalaryCertificate,
  GENERIC: extractGeneric,
};

/**
 * @param docType 'AUTO' бол агуулгаас таньсан төрлөөр (таних оноо хүрэхгүй бол GENERIC); тодорхой төрөл өгвөл түүгээр задлаад,
 *   агуулга өөр төрөл бололтой байвал анхааруулга нэмнэ.
 */
export function extractDocument(ocr: OcrResult, docType: OcrDocType | 'AUTO', options: ExtractOptions = {}): DocumentExtraction {
  const settings = resolveSettings(options);
  const doc = buildDoc(ocr);
  const detected = detectFromDoc(doc);
  const detectedDocType: OcrDocType | null = detected.docType === 'GENERIC' ? null : detected.docType;
  const effective: OcrDocType = docType === 'AUTO' ? (detectedDocType ?? 'GENERIC') : docType;

  const { fields, warnings } = EXTRACTORS[effective](doc, settings);
  const allWarnings = [...warnings];
  if (docType !== 'AUTO' && docType !== 'GENERIC' && detectedDocType !== null && detectedDocType !== docType) {
    allWarnings.push(`docType: баримт ${detectedDocType} төрөлтэй төстэй байна (хүсэлтэд ${docType} гэсэн)`);
  }
  if (ocr.warnings) allWarnings.push(...ocr.warnings);
  return { docType: effective, detectedDocType, fields, warnings: allWarnings, engine: ocr.engine, meanConfidence: ocr.meanConfidence };
}
