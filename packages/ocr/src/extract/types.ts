// Баримтын талбар задлалтын гэрээ (ID карт, цалингийн тодорхойлолт, ерөнхий). PII агуулна — хэзээ ч логлохгүй.

export type OcrDocType = 'ID_CARD' | 'SALARY_CERTIFICATE' | 'GENERIC';

/** Талбарын утга. Массив нь GENERIC-ийн registerNos/ibans/dates/amounts/phones-д. */
export type ExtractedValue = string | number | string[] | number[] | null;

export interface ExtractedField {
  value: ExtractedValue;
  /** 0..1 — тааруулсан хэсгийн OCR үгсийн итгэл × баталгаажуулалт (checksum/хуанли) */
  confidence: number;
  /** Баримтаас уншсан түүхий хэсэг (массивын хувьд ' | '-ээр залгасан); уншаагүй (тооцоолсон) бол null */
  raw: string | null;
  /** Тайлбар: итгэл бага, тооцоолсон, нэг үсэг таамагласан г.м. (Монгол) */
  note?: string;
  /** Өөр боломжит утгууд (жишээ: хэд хэдэн цалингийн дүн; Б/В нэг үсгийн ойлгомжгүй байдал) */
  alternatives?: Array<string | number>;
}

export interface DocumentExtraction {
  /** Задлалтад ашигласан төрөл (AUTO бол танигдсан эсвэл GENERIC) */
  docType: OcrDocType;
  /** Агуулгаас танигдсан төрөл; таних үзүүлэлт хүрэлцээгүй бол null */
  detectedDocType: OcrDocType | null;
  fields: Record<string, ExtractedField>;
  warnings: string[];
  engine: string;
  meanConfidence: number;
}

export interface ExtractOptions {
  /** Энэ утгаас доош итгэлтэй талбарт note нэмнэ (анхдагч EXTRACT_DEFAULTS.lowConfidenceThreshold) */
  lowConfidenceThreshold?: number;
  /** 'YYYY-MM-DD' — өгвөл ID картын хугацаа дууссан эсэхийг шалгана (цагийг дотроос уншихгүй: deterministic) */
  today?: string;
  /** Цалингийн дүнгийн боломжит доод/дээд хязгаар (MNT) — утасны дугаар, оныг тусгаарлах эвристик */
  minSalary?: number;
  maxSalary?: number;
}

export interface DocTypeInfo {
  code: OcrDocType;
  /** Монгол нэр */
  name: string;
  /** fields-ийн түлхүүрүүд */
  fields: readonly string[];
}

export const ID_CARD_FIELDS = ['lastName', 'firstName', 'patronymic', 'registerNo', 'birthDate', 'gender', 'cardNumber', 'issueDate', 'expiryDate'] as const;
export const SALARY_CERTIFICATE_FIELDS = [
  'employerName',
  'employeeName',
  'registerNo',
  'position',
  'monthlySalary',
  'issueDate',
  'periodFrom',
  'periodTo',
  'periodMonths',
] as const;
export const GENERIC_FIELDS = ['registerNos', 'ibans', 'dates', 'amounts', 'phones'] as const;

export const OCR_DOC_TYPE_INFO: readonly DocTypeInfo[] = [
  { code: 'ID_CARD', name: 'Иргэний үнэмлэх', fields: ID_CARD_FIELDS },
  { code: 'SALARY_CERTIFICATE', name: 'Цалингийн тодорхойлолт', fields: SALARY_CERTIFICATE_FIELDS },
  { code: 'GENERIC', name: 'Ерөнхий баримт (регистр, IBAN, огноо, дүн, утас)', fields: GENERIC_FIELDS },
];
