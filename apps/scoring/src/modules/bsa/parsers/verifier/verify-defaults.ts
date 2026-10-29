// Verifier-ийн анхдагч утга, түвшин — НЭГ газар (NFR-6: бүгд options-оор дарагдана). Бизнесийн босго биш, шалгалтын техникийн параметр.
import type { BankPolicy, VerificationIssueCode } from '../statement.types';

export type IssueSeverity = 'ERROR' | 'WARNING';
/** 'OFF': тухайн шалгалтын issue-г огт гаргахгүй */
export type SeverityOverride = IssueSeverity | 'OFF';

export const VERIFY_DEFAULTS = {
  /** Үлдэгдлийн гинжний зөвшөөрөгдөх зөрүү (валютын нэгж; төгрөгийн 2 орон) */
  balanceTolerance: 0.01,
  /** BALANCE_CHAIN_BREAK-ийг хамгийн ихдээ хэд жагсаах (нийт тоо мессежид) */
  maxListedBreaks: 10,
  /** Үлдэгдэлтэй мөрийн хувь үүнээс БАГА бол BALANCE_UNAVAILABLE (мөрүүдийн дийлэнхэд үлдэгдэл байхгүй) */
  minBalanceCoverage: 0.5,
  /** OCR-ийн дундаж итгэл (0..1) үүнээс бага бол OCR_LOW_CONFIDENCE. TODO(samples): бодит скан дээр тохируулна */
  ocrMinConfidence: 0.8,
  /** modDate − creationDate (секунд) үүнээс их бол PDF_MODIFIED */
  pdfModifiedToleranceSeconds: 60,
  /**
   * PDF producer/creator-т таарвал PDF_METADATA_SUSPICIOUS болох засварлагч / оффис / онлайн хэрэгслийн тэмдэг.
   * Шалгалт: жижиг үсэг, үсэг-цифрээс бусдыг хасаж, дэд мөрөөр. Эдгээр нь ЭВРИСТИК — банкны бодит PDF-ийн producer байхгүй (samples/ хоосон).
   */
  suspiciousProducerSignatures: [
    'Photoshop',
    'Illustrator',
    'InDesign',
    'GIMP',
    'Inkscape',
    'Pixlr',
    'Canva',
    'Microsoft Word',
    'Microsoft Excel',
    'Microsoft PowerPoint',
    'LibreOffice',
    'OpenOffice',
    'WPS Office',
    'iLovePDF',
    'Smallpdf',
    'Sejda',
    'PDFescape',
    'PDF24',
    'PDFelement',
    'Soda PDF',
    'DocHub',
    'Foxit PhantomPDF',
    'PDF-XChange Editor',
    'Master PDF Editor',
    'Nitro',
  ] as readonly string[],
  /** Issue бүрийн анхдагч түвшин (options.severity-ээр дарна). BSA-FR-2.2/2.3 */
  severity: {
    NO_TRANSACTIONS: 'ERROR',
    ROW_COUNT_MISMATCH: 'ERROR',
    BALANCE_CHAIN_BREAK: 'ERROR',
    BALANCE_UNAVAILABLE: 'WARNING',
    OPENING_BALANCE_MISMATCH: 'ERROR',
    CLOSING_BALANCE_MISMATCH: 'ERROR',
    IBAN_INVALID: 'ERROR',
    NAME_MISMATCH: 'ERROR',
    REGISTER_MISMATCH: 'ERROR',
    DATE_ORDER: 'WARNING',
    PERIOD_MISMATCH: 'WARNING',
    DUPLICATE_ROWS: 'WARNING',
    PDF_METADATA_SUSPICIOUS: 'WARNING',
    PDF_MODIFIED: 'WARNING',
    OCR_LOW_CONFIDENCE: 'WARNING',
    QR_NOT_VERIFIED: 'WARNING', // QR банкны талаас ТАТГАЛЗСАН (false) бол ERROR болно — verify-statement.ts
    UNVERIFIED_PARSER: 'WARNING',
    IMAGE_NOT_ACCEPTED: 'ERROR',
  } as Record<VerificationIssueCode, IssueSeverity>,
};

export interface VerifyCustomer {
  /** LOS-ийн харилцагчийн нэр(үүд): хуулгын эзэмшигчийн нэр аль нэгтэй нь таарвал болно */
  names: string[];
  /** LOS-ийн харилцагчийн регистр (хэлбэр чөлөөтэй: 'уб90010203', 'УБ-90010203') */
  registerNo?: string | null;
}

export interface VerifyOptions {
  balanceTolerance: number;
  maxListedBreaks: number;
  minBalanceCoverage: number;
  ocrMinConfidence: number;
  pdfModifiedToleranceSeconds: number;
  suspiciousProducerSignatures: readonly string[];
  /** Түвшин: issue код → ERROR | WARNING | OFF */
  severity: Record<VerificationIssueCode, SeverityOverride>;
  /** namesMatch-ийн доод оноо (өгөөгүй бол @los/ocr-ийн анхдагч) */
  nameMinScore?: number;
  customer?: VerifyCustomer;
  /** Банкны бодлого (registry.policyFor); өгөөгүй бол DEFAULT_BANK_POLICY */
  policy?: BankPolicy;
}

export type VerifyOptionsInput = Partial<Omit<VerifyOptions, 'severity'>> & {
  severity?: Partial<Record<VerificationIssueCode, SeverityOverride>>;
};

/** Оролтыг анхдагчтай нэгтгэнэ. Банк стандарт бус IBAN хэвлэдэг бол (policy) IBAN_INVALID анхдагчаар WARNING (шууд заагаагүй бол). */
export function resolveVerifyOptions(input: VerifyOptionsInput = {}): VerifyOptions {
  const { severity: sevInput, ...rest } = input;
  const severity: Record<VerificationIssueCode, SeverityOverride> = { ...VERIFY_DEFAULTS.severity, ...(sevInput ?? {}) };
  if (input.policy?.printsNonStandardIban && sevInput?.IBAN_INVALID === undefined) severity.IBAN_INVALID = 'WARNING';
  return {
    balanceTolerance: VERIFY_DEFAULTS.balanceTolerance,
    maxListedBreaks: VERIFY_DEFAULTS.maxListedBreaks,
    minBalanceCoverage: VERIFY_DEFAULTS.minBalanceCoverage,
    ocrMinConfidence: VERIFY_DEFAULTS.ocrMinConfidence,
    pdfModifiedToleranceSeconds: VERIFY_DEFAULTS.pdfModifiedToleranceSeconds,
    suspiciousProducerSignatures: VERIFY_DEFAULTS.suspiciousProducerSignatures,
    ...stripUndefined(rest),
    severity,
  };
}

const stripUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
