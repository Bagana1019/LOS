// Импортын алдаа/анхааруулгыг errors_json / warnings_json-д хадгалах `ImportIssue` болгох. Хэрэглэгчид харагдах мессеж монгол.
// АНХААР (PII): parser/verifier-ийн англи мессежийг ХАДГАЛАХГҮЙ — код тутамд тогтмол монгол мессеж + мөр/хуудасны дугаар л хадгална.
// Ингэснээр parser-т алдаа гараад мессежид гүйлгээний утга/нэр орсон ч DB, лог, event-д хүрэхгүй.
import type { BankCandidate } from '../parsers';
import type { ParseWarning, VerificationIssue, VerificationIssueCode } from '../parsers';
import { STATEMENT_EXTRACTION_MESSAGES, type StatementExtractionError, type StatementExtractionErrorCode } from '../parsers/text-extraction';
import type { ImportIssue } from '../common/persistence';

/** Pipeline-ийн өөрийн алдааны кодууд (extraction/verifier кодоос гадна) */
export type PipelineIssueCode =
  | 'BANK_NOT_DETECTED'
  | 'BANK_AMBIGUOUS'
  | 'TOO_MANY_ROWS'
  | 'IMPORT_TIMEOUT'
  | 'ROW_INVALID'
  | 'CATALOG_INCOMPLETE'
  | 'QUEUE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'ACCOUNT_NOT_IDENTIFIED'
  | 'ANALYSIS_LOCKED'
  | 'FILE_MISSING'
  | 'AGGREGATION_FAILED'
  | 'HOLDER_UNVERIFIED'
  | 'ROWS_SKIPPED_DUPLICATE';

export const PIPELINE_MESSAGES: Readonly<Record<PipelineIssueCode, string>> = {
  BANK_NOT_DETECTED: 'Хуулгын банкийг таньж чадсангүй. Банкаа гараар сонгоод дахин оруулна уу.',
  BANK_AMBIGUOUS: 'Хуулга хэд хэдэн банктай төстэй байна. Банкаа гараар сонгоод дахин оруулна уу.',
  TOO_MANY_ROWS: 'Хуулгын гүйлгээний тоо зөвшөөрөгдсөн хязгаараас хэтэрсэн байна. Хуулгыг хэсэгчлэн хуваан оруулна уу.',
  IMPORT_TIMEOUT: 'Хуулгыг боловсруулах хугацаа хэтэрлээ. Файлыг жижиглэж эсвэл дахин оруулна уу.',
  ROW_INVALID: 'Хуулгын зарим мөр хадгалах шаардлага хангахгүй байна (огноо эсвэл дүн буруу).',
  CATALOG_INCOMPLETE: 'Ангиллын сан бүрэн биш байна (системийн ангилал дутуу). Админд хандана уу.',
  QUEUE_UNAVAILABLE: 'Боловсруулалтын дараалалд нэмэх боломжгүй байна. Түр хүлээгээд дахин оролдоно уу.',
  INTERNAL_ERROR: 'Хуулгыг боловсруулах үед системийн алдаа гарлаа. Дахин оролдоно уу.',
  ACCOUNT_NOT_IDENTIFIED: 'Хуулгаас дансны дугаар олдсонгүй: өөрийн дансны шилжүүлгийг дансаар илрүүлэхгүй, давхар мөрийг энэ файлын дотор л шалгана.',
  ANALYSIS_LOCKED: 'Шинжилгээ дууссан (ANALYZED) тул файл боловсруулагдсангүй. Шинэ хувилбар үүсгэнэ үү.',
  FILE_MISSING: 'Хуулгын эх файл хадгалалтаас олдсонгүй. Файлыг дахин оруулна уу.',
  AGGREGATION_FAILED: 'Гүйлгээний ангилал таарахгүй байгаа тул тооцоолж чадсангүй. Ангиллын санг шалгана уу.',
  HOLDER_UNVERIFIED: 'Хуулгад эзэмшигчийн нэр, регистр хэвлэгдээгүй тул харилцагчтай тулгаж чадсангүй.',
  ROWS_SKIPPED_DUPLICATE: 'Зарим мөр өмнөх хуулгад аль хэдийн байгаа тул давхар оруулсангүй.',
};

/** verifier-ийн код тутмын тогтмол монгол мессеж (VerificationIssue.message англи, хадгалахгүй) */
export const VERIFICATION_MESSAGES: Readonly<Record<VerificationIssueCode, string>> = {
  NO_TRANSACTIONS: 'Хуулгаас нэг ч гүйлгээ уншигдсангүй.',
  ROW_COUNT_MISMATCH: 'Хуулгын гүйлгээний тоо уншсан мөрийн тоотой таарахгүй байна.',
  BALANCE_CHAIN_BREAK: 'Үлдэгдлийн гинж тасарсан: гүйлгээний дараах үлдэгдэл өмнөх мөртэй таарахгүй байна.',
  BALANCE_UNAVAILABLE: 'Ихэнх мөрөнд үлдэгдэл байхгүй тул үлдэгдлээр баталгаажуулж чадсангүй.',
  OPENING_BALANCE_MISMATCH: 'Эхний үлдэгдэл эхний гүйлгээтэй таарахгүй байна.',
  CLOSING_BALANCE_MISMATCH: 'Эцсийн үлдэгдэл сүүлийн гүйлгээтэй таарахгүй байна.',
  IBAN_INVALID: 'Хуулга дээрх IBAN буруу байна.',
  NAME_MISMATCH: 'Хуулгын эзэмшигчийн нэр харилцагчийн нэртэй таарахгүй байна.',
  REGISTER_MISMATCH: 'Хуулгын эзэмшигчийн регистр харилцагчийн регистртэй таарахгүй байна.',
  DATE_ORDER: 'Зарим гүйлгээний огноо өмнөх мөрөөс эрт байна.',
  PERIOD_MISMATCH: 'Хуулгын хугацаа гүйлгээний огноотой таарахгүй байна.',
  DUPLICATE_ROWS: 'Бүх талбараараа ижил давхар мөр байна (давтагдсан төлбөр байж болно).',
  PDF_METADATA_SUSPICIOUS: 'PDF-ийн үүсгэгч програм засварлагч эсвэл оффисын хэрэгсэл бололтой.',
  PDF_MODIFIED: 'PDF файл үүссэнээс хойш өөрчлөгдсөн байна.',
  OCR_LOW_CONFIDENCE: 'Зургаас таних итгэл бага байна, гараар шалгана уу.',
  QR_NOT_VERIFIED: 'QR код банкаар баталгаажсангүй.',
  UNVERIFIED_PARSER: 'Энэ банкны уншигч бодит хуулгаар баталгаажаагүй тул үр дүнг шалгана уу.',
  IMAGE_NOT_ACCEPTED: 'Энэ банк зураг хуулга хүлээн авдаггүй. PDF хуулга оруулна уу.',
};

/** parser-ийн анхааруулгын код тутмын монгол мессеж (үл мэдэгдэх код → ерөнхий) */
export const PARSE_WARNING_MESSAGES: Readonly<Record<string, string>> = {
  UNPARSED_ROW: 'Мөр шиг харагдсан боловч уншигдаагүй мөр байна.',
  REVERSED_ORDER: 'Хуулга шинэ-хуучин дарааллаар байсан тул эргүүлж уншлаа.',
  DIRECTION_SWAPPED: 'Дебит/кредит баганыг урвуу гэж үзэж сольж уншлаа.',
  DIRECTION_FROM_BALANCE: 'Орлого/зарлагын чиглэлийг үлдэгдлийн өөрчлөлтөөс тодорхойлов.',
  ROW_FALLBACK_LAYOUT: 'Зарим мөрийг хүснэгтийн баганаар биш текстээр уншлаа.',
  TABLE_HEADER_NOT_FOUND: 'Хүснэгтийн толгой олдсонгүй.',
  TABLE_HEADER_CHANGED: 'Хүснэгтийн толгой хуудас хооронд өөрчлөгдсөн байна.',
  HEADER_FIELD_CONFLICT: 'Хуулгын толгойн мэдээлэл хоорондоо зөрж байна.',
  HEADER_FIELD_INVALID: 'Хуулгын толгойн зарим талбар буруу байна.',
  PERIOD_DERIVED: 'Хуулгын хугацааг гүйлгээний огнооноос тодорхойлов.',
  CURRENCY_ASSUMED: 'Валют хэвлэгдээгүй тул төгрөг гэж үзэв.',
  TIME_MISSING: 'Зарим гүйлгээнд цаг байхгүй.',
  TIME_UNEXPECTED: 'Зарим гүйлгээний цаг хүлээгдэж байснаас өөр хэлбэртэй.',
  CONTINUATION_DROPPED: 'Үргэлжилсэн мөрийн зарим хэсгийг орхисон.',
  DATE_ONLY_LINE_MERGED: 'Зөвхөн огноотой мөрийг өмнөх мөртэй нэгтгэв.',
  BALANCE_ROW_SKIPPED: 'Үлдэгдлийн мөрийг гүйлгээнд тооцсонгүй.',
  WARNINGS_TRUNCATED: 'Анхааруулга олон тул зарим нь хураагдсан.',
  BANK_OVERRIDE_UNCONFIRMED: 'Гараар сонгосон банк хуулгын агуулгатай нийцэх нь баталгаагүй байна.',
};
const GENERIC_PARSE_WARNING = 'Хуулга уншихад анхааруулга гарлаа.';

/** Нэг ImportIssue-н мессежийн дээд урт (JSON хэт том болохоос) */
const MAX_ISSUES = 100;

export function issue(code: string, message: string, extra: Partial<Pick<ImportIssue, 'severity' | 'seq' | 'page' | 'line'>> = {}): ImportIssue {
  return { code, message, ...extra };
}

export function pipelineIssue(code: PipelineIssueCode, severity: 'ERROR' | 'WARNING' = 'ERROR', message?: string): ImportIssue {
  return issue(code, message ?? PIPELINE_MESSAGES[code], { severity });
}

/** Файлаас текст гаргах алдаа: код + аюулгүй монгол мессеж (StatementExtractionError.userMessage файлын агуулгагүй) */
export function extractionIssue(err: StatementExtractionError): ImportIssue {
  const code: StatementExtractionErrorCode = err.code;
  return issue(code, err.userMessage || STATEMENT_EXTRACTION_MESSAGES[code], { severity: 'ERROR' });
}

/** BANK_AMBIGUOUS: нэр дэвшигч банкны кодууд (PII биш) мессежид орно */
export function ambiguousBankIssue(candidates: readonly BankCandidate[]): ImportIssue {
  const banks = [...new Set(candidates.map((c) => c.bank))].join(', ');
  return issue('BANK_AMBIGUOUS', `${PIPELINE_MESSAGES.BANK_AMBIGUOUS} (боломжит банкууд: ${banks})`, { severity: 'ERROR' });
}

export function tooManyRowsIssue(max: number): ImportIssue {
  return issue('TOO_MANY_ROWS', `${PIPELINE_MESSAGES.TOO_MANY_ROWS} (дээд хязгаар ${max} мөр)`, { severity: 'ERROR' });
}

export interface RowCountInfo {
  declared: number | null;
  read: number;
}

/** verifier-ийн issue → ImportIssue (тогтмол монгол мессеж; ROW_COUNT_MISMATCH-д зарласан/уншсан тоо) */
export function verificationIssues(issues: readonly VerificationIssue[], rows: RowCountInfo): ImportIssue[] {
  return issues.slice(0, MAX_ISSUES).map((v) => {
    let message = VERIFICATION_MESSAGES[v.code] ?? 'Хуулгын баталгаажуулалтад анхааруулга гарлаа.';
    if (v.code === 'ROW_COUNT_MISMATCH' && rows.declared !== null && rows.declared !== rows.read) {
      message = `${message} (хуулгад ${rows.declared}, уншсан ${rows.read})`;
    }
    return issue(v.code, message, { severity: v.severity, ...(v.seq !== undefined ? { seq: v.seq } : {}), ...(v.page !== undefined ? { page: v.page } : {}), ...(v.line !== undefined ? { line: v.line } : {}) });
  });
}

/** parser-ийн анхааруулга: КОД тутамд нэг мөр (эхний байршил + нийт тоо). Англи мессежийг хадгалахгүй */
export function parseWarningIssues(warnings: readonly ParseWarning[]): ImportIssue[] {
  const byCode = new Map<string, { first: ParseWarning; count: number }>();
  for (const w of warnings) {
    const e = byCode.get(w.code);
    if (e) e.count++;
    else byCode.set(w.code, { first: w, count: 1 });
  }
  return [...byCode.entries()].slice(0, MAX_ISSUES).map(([code, { first, count }]) => {
    const base = PARSE_WARNING_MESSAGES[code] ?? GENERIC_PARSE_WARNING;
    return issue(code, count > 1 ? `${base} (${count} удаа)` : base, {
      severity: 'WARNING',
      ...(first.page !== undefined ? { page: first.page } : {}),
      ...(first.line !== undefined ? { line: first.line } : {}),
    });
  });
}

/** Upload-ын файл бүрийн татгалзах шалтгаан (хэрэглэгчид үзүүлнэ) */
export type UploadRejectCode =
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'FILE_UNSUPPORTED'
  | 'XLSX_UNSUPPORTED'
  | 'STORAGE_FAILED'
  | 'QUEUE_UNAVAILABLE'
  | 'INVALID_BANK'
  | 'INTERNAL_ERROR';
export const UPLOAD_REJECT_MESSAGES: Readonly<Record<UploadRejectCode, string>> = {
  FILE_EMPTY: 'Файл хоосон байна.',
  FILE_TOO_LARGE: 'Файл зөвшөөрөгдсөн хэмжээнээс том байна.',
  FILE_UNSUPPORTED: 'Дэмжигдээгүй файл байна. PDF, зураг (PNG, JPG), CSV эсвэл текст файл оруулна уу.',
  XLSX_UNSUPPORTED: 'Excel (XLSX) файл дэмжигдэхгүй. Хуулгаа CSV эсвэл PDF хэлбэрээр татаж оруулна уу.',
  STORAGE_FAILED: 'Файлыг хадгалж чадсангүй. Дахин оролдоно уу.',
  QUEUE_UNAVAILABLE: PIPELINE_MESSAGES.QUEUE_UNAVAILABLE,
  INVALID_BANK: 'Сонгосон банк дэмжигдэхгүй байна.',
  INTERNAL_ERROR: 'Файлыг хүлээн авах үед системийн алдаа гарлаа. Дахин оролдоно уу.',
};
