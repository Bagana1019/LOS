// Банкны хуулгын формат тайлбарлагч өгөгдөл (NFR-5: шинэ банк = шинэ profile + бүртгэл, engine-д код өөрчлөлтгүй).
import type { BankCode, TxnDirection } from '@los/contracts';
import type { DateOrder } from '@los/ocr';

/**
 * Хүснэгтийн баганын үүрэг. 'ignore' = таниагдсан ч ашиглахгүй (салбар, валют, лавлах дугаар...).
 * 'ignoreAmount' = тоон дүнтэй боловч ашиглахгүй багана (мөр бүрийн "Эхний үлдэгдэл" гэх мэт) — хоосон нүд хасагдсан мөрийг зэрэгцүүлэхэд
 * тоон нүд хүлээнэ.
 */
export const COLUMN_ROLES = [
  'seq',
  'date',
  'time',
  'description',
  'debit',
  'credit',
  'amount',
  'balance',
  'counterparty',
  'counterpartyAccount',
  'counterpartyName',
  'type',
  'ignore',
  'ignoreAmount',
] as const;
export type ColumnRole = typeof COLUMN_ROLES[number];

/** Толгой хэсгийн талбарууд (шошгоор таньдаг) */
export const HEADER_FIELDS = [
  'accountNo',
  'iban',
  'holderName',
  'registerNo',
  'periodRange',
  'periodFrom',
  'periodTo',
  'currency',
  'openingBalance',
  'closingBalance',
  'declaredRowCount',
] as const;
export type HeaderField = typeof HEADER_FIELDS[number];

export interface BankProfile {
  bank: BankCode;
  /** ParsedStatement.parserId, жишээ 'khan-table-v1' */
  parserId: string;
  /** true зөвхөн бодит samples/<bank>/ файлаар баталгаажсан үед. Одоогоор бүгд false (TODO(samples)). */
  verified: boolean;
  /** Банкны нэрийн түлхүүр үгс (кирилл + латин). Толгой хэсэгт БҮТЭН ҮГЭЭР тулгана (toMatchKey түлхүүрээр) */
  nameKeywords: string[];
  /** Эдгээр таарвал энэ банк биш (жишээ 'State Bank of India') → detect 0 */
  rejectKeywords?: string[];
  /** Толгой хэсгийн текст дээр шалгах нэмэлт бүтцийн тэмдэг (богино, backtracking-гүй regex) */
  structuralCues?: RegExp[];
  /** Жил сүүлд байгаа тоон огнооны (10/03/2026) өдөр-сарын дараалал */
  dateOrder: DateOrder;
  /** Хуулгад цаг (HH:mm) хэвлэгддэг эсэх. false: Голомт/Хас/Капитрон (BSA-BR-5) */
  hasTime: boolean;
  /** false: зураг (JPG/PNG) хүлээн авахгүй (Хаан — samples/README.md) */
  acceptsImages: boolean;
  /** true: банк стандарт бус IBAN хэвлэдэг → verifier зөвхөн WARNING */
  printsNonStandardIban?: boolean;
  /** 'Дебит' багана ямар чиглэл гэсэн үг. Анхдагч EXPENSE (зарлага). Системтэйгээр урвуу бол engine өөрөө эргүүлнэ (DIRECTION_SWAPPED) */
  debitMeans?: TxnDirection;
  /** Баганын нэрийн нэмэлт синоним (анхдагчийг дарахгүй, нэмнэ) */
  columnSynonyms?: Partial<Record<ColumnRole, string[]>>;
  /** Толгой хэсгийн шошгын нэмэлт синоним */
  headerLabels?: Partial<Record<HeaderField, string[]>>;
  /** Хуудасны хөл/дүнгийн мөрийг алгасах нэмэлт угтварууд (toMatchKey-ээр нормчилно) */
  skipLineKeys?: string[];
  /** Дүн 'мянгатын зай'-тай ('1 234 567') бөгөөд мөр нь нэг нүдтэй текст бол token-оор нэгтгэнэ */
  spaceThousands?: boolean;
}
