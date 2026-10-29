// Engine-ийн анхдагч утга, синонимууд — НЭГ газар. Бизнесийн босго биш, parse-ийн техникийн параметр; тест/банк бүр дарж болно.
import { toMatchKey } from '@los/ocr';
import type { ColumnRole, HeaderField } from './bank-profile';

export const ENGINE_DEFAULTS = {
  /** Хүснэгтийн толгойг эхний хуудасны эхний энэ тооны мөрөөс хайна */
  headerZoneMaxLines: 60,
  /** Хүснэгтийн толгой олдоогүй үед толгой хэсэг гэж үзэх мөрийн тоо (эхний мөрөөр зогсоно) */
  headerZoneFallbackLines: 25,
  /** Банкны нэрийг "гарчиг" гэж үзэх хуудасны эхний (хоосон биш) мөрүүд */
  titleZoneLines: 8,
  /** detect() оноо: нэрийн түлхүүр үг + бүтцийн тэмдэг. Нэр ганцаараа registry-ийн босгоос бага → бүтэц заавал хэрэгтэй */
  detect: {
    titleKeyword: 0.45,
    headerKeyword: 0.35,
    tableHeader: 0.25,
    headerLabel: 0.05,
    headerLabelMax: 3,
    cue: 0.08,
    cueMax: 2,
    /** Банкны нэр олдоогүй үед оноо энэ хязгаараас хэтрэхгүй (registry-ийн босгоос бага) */
    noKeywordMax: 0.4,
  },
  /** Хүснэгтийн толгойд хамгийн багадаа таних баганын үүргийн тоо (date + мөнгөн дүн орсон) */
  tableHeaderMinRoles: 3,
  /** Нэг мөрийн wrap-д нэгтгэх үргэлжлэл мөрийн дээд тоо */
  maxContinuationLines: 3,
  /** Нэг мөр/нүдний дээд урт: үүнээс урт хэсгийг таслана (адверсари оролтоос хамгаална) */
  maxLineLength: 4000,
  maxCellLength: 1000,
  /** Debit/credit эргүүлэх санал хураалтад хамгийн багадаа оролцох мөрийн тоо */
  directionVoteMinRows: 3,
  /** Үлдэгдлийн харьцуулалтын цент-ийн зөрүү */
  balanceEpsilon: 0.011,
  /** Задгай (мянгатын тусгаарлагчгүй) энэ ба түүнээс олон оронтой бүхэл тоо = ID/утас, нормал дүн биш (баруун тал нь форматласан дүн байвал) */
  plainLongAmountMinDigits: 7,
  /** Задгай ≥ энэ оронтой бүхэл тоо хэзээ ч дүн биш (дансны дугаар) */
  idLikeMinDigits: 9,
  /** Гүйлгээний утгаас харьцсан данс таних цифрийн урт (docs: 8-20) */
  counterpartyAccountDigits: { min: 8, max: 20 },
  /** Нэг кодтой анхааруулгын дээд тоо (хэтэрвэл WARNINGS_TRUNCATED-д тоологдоно) */
  maxWarningsPerCode: 1000,
  defaultCurrency: 'MNT',
  maxHeaderValueLength: 120,
  /** Хүснэгтийн мөрийн дараах дүнгийн/хөлийн мөр гэж үзэх дээд урт (урт мөр = wrap утга) */
  maxSkipLineLength: 120,
};
export type EngineConfig = typeof ENGINE_DEFAULTS;
export type EngineOptions = Partial<EngineConfig>;

/** Баганын нэрийн синонимууд (Монгол + Англи). Тулгалт нь toMatchKey-ээр: кирилл/латин/том-жижиг хамааралгүй. */
export const DEFAULT_COLUMN_SYNONYMS: Record<ColumnRole, string[]> = {
  seq: ['№', 'Д/д', 'Дд', 'No', 'Seq', '#'],
  date: ['Огноо', 'Гүйлгээний огноо', 'Гүйлгээ хийсэн огноо', 'Date', 'Transaction date', 'Txn date', 'Posting date'],
  time: ['Цаг', 'Гүйлгээний цаг', 'Time', 'Txn time'],
  description: [
    'Гүйлгээний утга',
    'Утга',
    'Тайлбар',
    'Гүйлгээний тайлбар',
    'Description',
    'Details',
    'Narrative',
    'Particulars',
    'Remarks',
    'Memo',
  ],
  debit: ['Дебит', 'Дебет', 'Зарлага', 'Зарлагын дүн', 'Debit', 'Withdrawal', 'Withdrawals', 'Dr'],
  credit: ['Кредит', 'Орлого', 'Орлогын дүн', 'Credit', 'Deposit', 'Deposits', 'Cr'],
  amount: ['Дүн', 'Гүйлгээний дүн', 'Amount', 'Transaction amount'],
  balance: ['Үлдэгдэл', 'Гүйлгээний дараах үлдэгдэл', 'Дансны үлдэгдэл', 'Balance', 'Running balance'],
  counterparty: ['Харьцсан данс', 'Хүлээн авагч', 'Харьцагч', 'Counterparty', 'Beneficiary', 'Payee'],
  counterpartyAccount: [
    'Харьцсан дансны дугаар',
    'Харьцсан дансны №',
    'Хүлээн авагчийн данс',
    'Counterparty account',
    'Beneficiary account',
  ],
  counterpartyName: ['Харьцсан дансны нэр', 'Хүлээн авагчийн нэр', 'Харьцагчийн нэр', 'Counterparty name', 'Beneficiary name'],
  type: ['Төрөл', 'Гүйлгээний төрөл', 'Дт/Кт', 'Dr/Cr', 'Type', 'Чиглэл', 'Direction'],
  ignoreAmount: ['Эхний үлдэгдэл', 'Өмнөх үлдэгдэл', 'Opening balance', 'Previous balance', 'Balance before'],
  ignore: ['Салбар', 'Branch', 'Валют', 'Currency', 'Ханш', 'Rate', 'Лавлах', 'Reference', 'Ref', 'Баримтын дугаар', 'Гүйлгээний дугаар', 'Channel', 'Суваг'],
};

/** Толгой хэсгийн шошго. Нэг үгтэй богино шошго (strict) нь ':' эсвэл нүдний хил/хоёр зайны дараа л таарна. */
export const DEFAULT_HEADER_LABELS: Record<HeaderField, string[]> = {
  accountNo: ['Дансны дугаар', 'Дансны №', 'Данс', 'Account number', 'Account no.', 'Account no', 'Account No', 'A/C No', 'A/C', 'Account', 'Acct'],
  iban: ['IBAN', 'IBAN дугаар', 'Олон улсын дансны дугаар'],
  holderName: [
    'Данс эзэмшигч',
    'Дансны эзэмшигч',
    'Дансны нэр',
    'Харилцагчийн нэр',
    'Эзэмшигчийн нэр',
    'Овог нэр',
    'Харилцагч',
    'Эзэмшигч',
    'Нэр',
    'Account holder name',
    'Account holder',
    'Account name',
    'Customer name',
    'Customer',
    'Holder',
    'Name',
  ],
  registerNo: ['Регистрийн дугаар', 'Регистрийн №', 'Регистр', 'РД', 'Register number', 'Register no', 'Registration number', 'Register'],
  periodRange: ['Хуулгын хугацаа', 'Тайлант хугацаа', 'Огнооны муж', 'Хугацаа', 'Statement period', 'Date range', 'Period'],
  periodFrom: ['Эхлэх огноо', 'Эхлэх', 'Эхлэл', 'Start date', 'From date', 'Period from', 'From'],
  periodTo: ['Дуусах огноо', 'Төгсөх огноо', 'Дуусах', 'End date', 'To date', 'Period to', 'To'],
  currency: ['Валютын төрөл', 'Валют', 'Currency', 'Ccy'],
  openingBalance: [
    'Эхний үлдэгдэл',
    'Эхлэх үлдэгдэл',
    'Өмнөх үлдэгдэл',
    'Opening balance',
    'Beginning balance',
    'Balance brought forward',
    'Initial balance',
    'Start balance',
  ],
  closingBalance: [
    'Эцсийн үлдэгдэл',
    'Эцэс үлдэгдэл',
    'Төгсгөлийн үлдэгдэл',
    'Closing balance',
    'Ending balance',
    'End balance',
    'Balance carried forward',
    'Final balance',
  ],
  declaredRowCount: [
    'Нийт гүйлгээний тоо',
    'Гүйлгээний нийт тоо',
    'Нийт гүйлгээ',
    'Гүйлгээний тоо',
    'Мөрийн тоо',
    'Нийт мөр',
    'Total transaction count',
    'Total transactions',
    'Transaction count',
    'Number of transactions',
    'No. of transactions',
    'Total records',
  ],
};

/** Хүснэгтийн дундах/сүүлийн дүнгийн, хуудасны хөлийн мөрийг алгасах угтварууд (toMatchKey-ээр нормчилсон дараа нь тулгана) */
export const DEFAULT_SKIP_LINE_WORDS = [
  'Нийт',
  'Дэд дүн',
  'Нийлбэр',
  'Дундаж',
  'Total',
  'Subtotal',
  'Sub total',
  'Grand total',
  'Sum',
  'Хуудас',
  'Хуудасны',
  'Page',
  'Printed',
  'Хэвлэсэн',
] as const;

/** 'Төрөл' баганын утгууд (бүтнээр нь тулгана). Түлхүүрийг toMatchKey-ээр нормчилно (c→k гэх мэт) — row-parser.asDir */
export const TYPE_CELL_WORDS: Record<'INCOME' | 'EXPENSE', string[]> = {
  INCOME: ['Орлого', 'Кредит', 'Credit', 'Cr', 'Кт', 'Kt', 'К', 'In', 'Income', 'Deposit'],
  EXPENSE: ['Зарлага', 'Дебит', 'Дебет', 'Debit', 'Dr', 'Дт', 'Dt', 'Д', 'Out', 'Expense', 'Withdrawal'],
};

export const TYPE_CELL_LEXICON: ReadonlyMap<string, 'INCOME' | 'EXPENSE'> = new Map(
  (Object.entries(TYPE_CELL_WORDS) as Array<['INCOME' | 'EXPENSE', string[]]>).flatMap(([dir, words]) =>
    words.map((w): [string, 'INCOME' | 'EXPENSE'] => [toMatchKey(w), dir]),
  ),
);
