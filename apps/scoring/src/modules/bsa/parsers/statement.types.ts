// BSA хуулгын parser-ийн гэрээ. docs/02 BSA-FR-2, NFR-5 (банк бүрийн parser тусдаа модуль).
import type { BankCode, TxnDirection } from '@los/contracts';

/** Файлаас гарсан текст — PDF text layer, OCR, CSV, эсвэл энгийн текст. Parser нь зөвхөн үүнийг уншина. */
export type StatementTextSource = 'PDF_TEXT' | 'OCR' | 'CSV' | 'TEXT';

export interface StatementTextLine {
  /** Мөрийн бүтэн текст (нүднүүдийг нэг зайгаар залгасан) */
  text: string;
  /**
   * Баганаар таслагдсан нүднүүд (зайн цоорхой / TAB / CSV талбар). Баганын мэдээлэл олдоогүй бол [text].
   * Parser нь аль болох `cells`-ээр баганыг таньж, дараа нь `text` дээр regex-ээр нөхнө.
   */
  cells: string[];
  /** Хуудас доторх босоо байрлал (pt эсвэл px) — тооцоололд биш, debug/алдааны байршилд */
  y?: number;
}

export interface StatementTextPage {
  pageNo: number; // 1-based
  lines: StatementTextLine[];
}

export interface PdfMetadata {
  producer: string | null;
  creator: string | null;
  title: string | null;
  author: string | null;
  /** ISO 8601 */
  creationDate: string | null;
  modDate: string | null;
  pageCount: number;
  isEncrypted: boolean;
  hasSignature: boolean;
}

export interface StatementFileMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pdf?: PdfMetadata;
  ocr?: { engine: string; meanConfidence: number };
  /** QR зурагнаас уншсан payload-ууд (баталгаажуулалт банкны талд — TODO(bank API)) */
  qrPayloads?: string[];
}

export interface StatementText {
  source: StatementTextSource;
  pages: StatementTextPage[];
  meta: StatementFileMeta;
}

export interface ParseWarning {
  code: string;
  message: string;
  page?: number;
  line?: number;
}

export interface ParsedTransaction {
  /** Файл доторх 1-ээс эхэлсэн дараалал (мөрийн тоо шалгахад) */
  seq: number;
  /** YYYY-MM-DD */
  txnDate: string;
  /** HH:mm эсвэл HH:mm:ss; хуулгад цаг байхгүй бол null */
  txnTime: string | null;
  direction: TxnDirection;
  /** Эерэг дүн, хуулгын валютаар */
  amount: number;
  balanceAfter: number | null;
  description: string;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  sourcePage: number;
  sourceLine: number;
}

export interface ParsedStatement {
  bank: BankCode;
  parserId: string;
  /**
   * true: бодит банкны жишээ файлаар баталгаажсан parser. false: samples/<bank>/ байхгүй тул ерөнхий
   * (heuristic) parser-аар уншсан — үр дүнг verifier-ээр заавал шалгана, UI-д анхааруулна.
   */
  parserVerified: boolean;
  accountNo: string | null;
  iban: string | null;
  holderName: string | null;
  /** Хуулгад хэвлэсэн эзэмшигчийн регистр (каноник 'УБ90010203'); хэвлээгүй/буруу бол null/undefined. ADDITIVE (verifier: REGISTER_MISMATCH) */
  holderRegisterNo?: string | null;
  currency: string; // 'MNT'
  periodFrom: string | null; // YYYY-MM-DD
  periodTo: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  /** Хуулгын толгой/хөл дээр "Нийт N гүйлгээ" гэж бичсэн бол */
  declaredRowCount: number | null;
  transactions: ParsedTransaction[];
  warnings: ParseWarning[];
  /** Мөр шиг харагдсан ч уншигдаагүй мөрийн НИЙТ тоо (UNPARSED_ROW анхааруулга хязгаарлагдсан ч бүрэн). ADDITIVE (verifier: ROW_COUNT_MISMATCH) */
  unparsedRowCount?: number;
}

/** Банкны бодлого — verifier-т хэрэгтэй хэсэг (BankProfile-аас гарна). ADDITIVE */
export interface BankPolicy {
  /** false: зураг (JPG/PNG) хүлээн авахгүй (жишээ: Хаан — samples/README.md) → IMAGE_NOT_ACCEPTED */
  acceptsImages: boolean;
  /** true: банк стандарт бус IBAN хэвлэдэг → IBAN_INVALID зөвхөн WARNING */
  printsNonStandardIban: boolean;
}

/** NFR-5: банк нэмэхэд зөвхөн шинэ parser класс + registry-д бүртгэл. */
export interface StatementParser {
  readonly bank: BankCode;
  readonly id: string;
  /** ADDITIVE: банкны бодлого (зураг хүлээн авах, IBAN хэлбэр). Байхгүй бол DEFAULT_BANK_POLICY */
  readonly policy?: BankPolicy;
  /** Жишээ файлаар баталгаажсан эсэх (ParsedStatement.parserVerified-д дамжина) */
  readonly verified: boolean;
  /** 0..1 — энэ текст миний банкных мөн гэсэн итгэл. Registry хамгийн өндрийг (≥ босго) сонгоно. */
  detect(text: StatementText): number;
  parse(text: StatementText): ParsedStatement;
}

// ---- Verifier (BSA-FR-2.2, 2.3) ----

export type VerificationIssueCode =
  | 'NO_TRANSACTIONS'
  | 'ROW_COUNT_MISMATCH'
  | 'BALANCE_CHAIN_BREAK'
  | 'BALANCE_UNAVAILABLE'
  | 'OPENING_BALANCE_MISMATCH'
  | 'CLOSING_BALANCE_MISMATCH'
  | 'IBAN_INVALID'
  | 'NAME_MISMATCH'
  | 'REGISTER_MISMATCH'
  | 'DATE_ORDER'
  | 'PERIOD_MISMATCH'
  | 'DUPLICATE_ROWS'
  | 'PDF_METADATA_SUSPICIOUS'
  | 'PDF_MODIFIED'
  | 'OCR_LOW_CONFIDENCE'
  | 'QR_NOT_VERIFIED'
  | 'UNVERIFIED_PARSER'
  | 'IMAGE_NOT_ACCEPTED'; // ADDITIVE: банкны хуулга зургаар хүлээн авдаггүй

export interface VerificationIssue {
  code: VerificationIssueCode;
  /** ERROR → импорт FAILED (verifierOk=false); WARNING → зөвхөн анхааруулга */
  severity: 'ERROR' | 'WARNING';
  message: string;
  seq?: number;
  page?: number;
  line?: number;
}

/** PDF metadata-н дүгнэлт (BSA-FR-2.3). ADDITIVE — VerificationResult.authenticity */
export interface AuthenticityReport {
  /** PDF metadata байсан эсэх (зураг/CSV-д false) */
  checked: boolean;
  producer: string | null;
  creator: string | null;
  /** Producer/creator-т таарсан засварлагч/оффис/онлайн хэрэгслийн тэмдэг */
  suspiciousSignatures: string[];
  /** modDate − creationDate (секунд); огноо байхгүй бол null */
  modifiedAfterSeconds: number | null;
  isEncrypted: boolean;
  hasSignature: boolean;
}

export interface VerificationResult {
  /** Parser ямар нэг гүйлгээ уншсан, бүтцийн алдаагүй */
  parserOk: boolean;
  /** ERROR түвшний issue байхгүй */
  verifierOk: boolean;
  /** true: QR банкны талаас баталгаажсан; false: бүтэлгүйтсэн; null: шалгаагүй (QR байхгүй / TODO) */
  qrVerified: boolean | null;
  issues: VerificationIssue[];
  /** ADDITIVE: PDF metadata-н мэдээлэл (шифрлэлт, гарын үсэг гэх мэт) — UI/аудитад */
  authenticity?: AuthenticityReport;
}
