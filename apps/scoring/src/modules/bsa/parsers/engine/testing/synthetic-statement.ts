// TEST HELPER — SYNTHETIC хуулга үүсгэгч. Бодит банкны хуулга/хувийн мэдээлэл ОГТ ашиглаагүй: бүх нэр, данс, дүн зохиомол.
// Банк бүрийн ТААМАГЛАСАН формат (TODO(samples): бодит файлаар баталгаажаагүй) болон багана/хуудас/wrap-ийн янз бүрийн хувилбарыг
// StatementText болгон бүтээж, ЯГ хүлээгдэх үр дүнг (expected) хамт буцаана — parser-ийн тест түүнтэй тулгана.
import type { TxnDirection } from '@los/contracts';
import type { StatementText, StatementTextLine, StatementTextPage, StatementTextSource } from '../../statement.types';
import { syntheticMeta } from '../text-dump';

export type SynColumn =
  | 'seq'
  | 'date'
  | 'time'
  | 'valueDate'
  | 'branch'
  | 'description'
  | 'debit'
  | 'credit'
  | 'income'
  | 'expense'
  | 'amount'
  | 'type'
  | 'balance'
  /** Гүйлгээний ӨМНӨХ үлдэгдэл (Хаанд мөр бүрт "Эхний үлдэгдэл" байдаг гэж таамагласан) — parser-д ignore */
  | 'prevBalance'
  | 'counterparty'
  | 'counterpartyAccount'
  | 'counterpartyName';

export interface SynTxn {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm:ss (layout цаг хэвлэдэг бол) */
  time?: string;
  direction: TxnDirection;
  amount: number;
  description: string;
  counterpartyAccount?: string;
  counterpartyName?: string;
}

export interface SynHeader {
  titleLines: string[];
  accountNo?: string;
  iban?: string;
  holder?: string;
  register?: string;
  currency?: string;
  showPeriod: boolean;
  showOpening: boolean;
  showClosing: boolean;
  showCount: boolean;
  /** inline: "Шошго: утга" нэг нүдэнд; nextCell: [шошго, утга]; nextLine: шошго, дараагийн мөрөнд утга */
  placement: 'inline' | 'nextCell' | 'nextLine';
  /** true: эцсийн үлдэгдэл, мөрийн тоо хуулгын төгсгөлд */
  footerSummary: boolean;
}

export interface SynLayout {
  labels: 'mn' | 'en';
  columns: SynColumn[];
  dateFormat: 'iso' | 'dmy-dot' | 'dmy-slash' | 'mn-long';
  /** Цагийг огнооны нүдэнд ("2026-03-10 14:25:07") бичих (columns-д 'time' байхгүй үед) */
  timeInDateCell: boolean;
  amountStyle: 'comma' | 'space' | 'plain';
  decimals: 0 | 2;
  /** debit/credit/income/expense-ийн хоосон талд юу бичих */
  emptyAmount: '0.00' | '-' | '';
  /** amount баганад эерэг утгад '+' тавих эсэх */
  plusSign: boolean;
  /** type багана: 'word' = Орлого/Зарлага, 'drcr' = Cr/Dr */
  typeStyle: 'word' | 'drcr';
  /** true: debit баганад ОРЛОГО, credit/зарлагад ЗАРЛАГА (системтэй урвуу файл) */
  debitIsIncome: boolean;
  /** Хоосон нүдийг устгах (PDF text layer шиг) */
  dropEmptyCells: boolean;
  newestFirst: boolean;
  rowsPerPage: number;
  repeatHeader: boolean;
  pageFooters: boolean;
  /** Дараагийн хуудас бүрийн дээр давтагдах гарчиг мөрүүд */
  pageTitleLines: string[];
  subtotalRows: boolean;
  /** Тайлбарыг энэ тэмдэгтээс хэтэрвэл дараагийн мөрөнд шилжүүлэх */
  wrapAt: number | null;
  /** cells: нүдтэй; spaced: нэг нүд, баганыг 2 зайгаар; single: нэг нүд, 1 зайгаар (token горим) */
  textMode: 'cells' | 'spaced' | 'single';
  /** Баганын толгойн шошгыг дарах (банкны таамагласан нэршил) */
  labelOverrides: Partial<Record<SynColumn, string>>;
  header: SynHeader;
  source: StatementTextSource;
}

export const DEFAULT_SYN_HEADER: SynHeader = {
  titleLines: ['SYNTHETIC TEST DATA - NOT A REAL STATEMENT', 'Тест банк - Дансны хуулга'],
  accountNo: '5011223344',
  holder: 'Бат-Эрдэнэ Болд',
  currency: 'MNT',
  showPeriod: true,
  showOpening: true,
  showClosing: false,
  showCount: false,
  placement: 'inline',
  footerSummary: false,
};

export const DEFAULT_SYN_LAYOUT: SynLayout = {
  labels: 'mn',
  columns: ['date', 'time', 'description', 'debit', 'credit', 'balance'],
  dateFormat: 'iso',
  timeInDateCell: false,
  amountStyle: 'comma',
  decimals: 2,
  emptyAmount: '0.00',
  plusSign: false,
  typeStyle: 'word',
  debitIsIncome: false,
  dropEmptyCells: false,
  newestFirst: false,
  rowsPerPage: 1000,
  repeatHeader: true,
  pageFooters: false,
  pageTitleLines: [],
  subtotalRows: false,
  wrapAt: null,
  textMode: 'cells',
  labelOverrides: {},
  header: DEFAULT_SYN_HEADER,
  source: 'PDF_TEXT',
};

const LABELS: Record<'mn' | 'en', Record<SynColumn | 'total' | 'page', string>> = {
  mn: {
    seq: '№',
    date: 'Огноо',
    time: 'Цаг',
    valueDate: 'Бүртгэсэн огноо',
    branch: 'Салбар',
    description: 'Гүйлгээний утга',
    debit: 'Дебит',
    credit: 'Кредит',
    income: 'Орлого',
    expense: 'Зарлага',
    amount: 'Дүн',
    type: 'Төрөл',
    balance: 'Үлдэгдэл',
    prevBalance: 'Эхний үлдэгдэл',
    counterparty: 'Харьцсан данс',
    counterpartyAccount: 'Харьцсан дансны дугаар',
    counterpartyName: 'Харьцсан дансны нэр',
    total: 'Нийт',
    page: 'Хуудас',
  },
  en: {
    seq: 'No',
    date: 'Date',
    time: 'Time',
    valueDate: 'Value date',
    branch: 'Branch',
    description: 'Description',
    debit: 'Debit',
    credit: 'Credit',
    income: 'Deposit',
    expense: 'Withdrawal',
    amount: 'Amount',
    type: 'Type',
    balance: 'Balance',
    prevBalance: 'Previous balance',
    counterparty: 'Counterparty',
    counterpartyAccount: 'Counterparty account',
    counterpartyName: 'Counterparty name',
    total: 'Total',
    page: 'Page',
  },
};

const HEADER_LABELS: Record<'mn' | 'en', Record<string, string>> = {
  mn: {
    account: 'Дансны дугаар',
    iban: 'IBAN',
    holder: 'Данс эзэмшигч',
    register: 'Регистрийн дугаар',
    period: 'Хугацаа',
    currency: 'Валют',
    opening: 'Эхний үлдэгдэл',
    closing: 'Эцсийн үлдэгдэл',
    count: 'Нийт гүйлгээний тоо',
  },
  en: {
    account: 'Account number',
    iban: 'IBAN',
    holder: 'Account holder',
    register: 'Register number',
    period: 'Period',
    currency: 'Currency',
    opening: 'Opening balance',
    closing: 'Closing balance',
    count: 'Total transactions',
  },
};

// ---- Форматлагчид ----
export function fmtAmount(n: number, layout: Pick<SynLayout, 'amountStyle' | 'decimals'>): string {
  const fixed = Math.abs(n).toFixed(layout.decimals);
  if (layout.amountStyle === 'plain') return fixed;
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, layout.amountStyle === 'comma' ? ',' : ' ');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

export function fmtDate(iso: string, format: SynLayout['dateFormat']): string {
  const [y, m, d] = iso.split('-');
  if (format === 'dmy-dot') return `${d}.${m}.${y}`;
  if (format === 'dmy-slash') return `${d}/${m}/${y}`;
  if (format === 'mn-long') return `${y} оны ${Number(m)} дугаар сарын ${Number(d)}`;
  return iso;
}

// ---- Хүлээгдэх үр дүн ----
export interface SynExpectedTxn {
  seq: number;
  txnDate: string;
  txnTime: string | null;
  direction: TxnDirection;
  amount: number;
  balanceAfter: number | null;
  description: string;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
}

export interface SynExpected {
  transactions: SynExpectedTxn[];
  openingBalance: number | null;
  closingBalance: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  declaredRowCount: number | null;
  accountNo: string | null;
  iban: string | null;
  holderName: string | null;
  holderRegisterNo: string | null;
  currency: string;
}

export interface SynResult {
  text: StatementText;
  expected: SynExpected;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function wrapWords(text: string, width: number | null): string[] {
  if (!width || text.length <= width) return [text];
  const parts: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && (line + ' ' + word).length > width) {
      parts.push(line);
      line = word;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') parts.push(line);
  return parts;
}

/** txns — ХРОНОЛОГИ дарааллаар (хуучин→шинэ). Layout.newestFirst бол файлд эсрэгээр бичнэ. */
export function renderStatement(txns: SynTxn[], opening: number, partial: Partial<SynLayout> = {}): SynResult {
  const layout: SynLayout = { ...DEFAULT_SYN_LAYOUT, ...partial, header: { ...DEFAULT_SYN_HEADER, ...(partial.header ?? {}) } };
  const L = LABELS[layout.labels];
  const cols = layout.columns;
  const hasTime = cols.includes('time') || layout.timeInDateCell;
  const hasCpAccount = cols.includes('counterparty') || cols.includes('counterpartyAccount');
  const hasCpName = cols.includes('counterparty') || cols.includes('counterpartyName');

  // Үлдэгдэл
  let running = opening;
  const withBalance = txns.map((t) => {
    const before = running;
    running = round2(running + (t.direction === 'INCOME' ? t.amount : -t.amount));
    return { t, balance: running, before };
  });
  const expected: SynExpected = {
    transactions: withBalance.map(({ t, balance }, i) => ({
      seq: i + 1,
      txnDate: t.date,
      txnTime: hasTime ? (t.time ?? null) : null,
      direction: t.direction,
      amount: t.amount,
      balanceAfter: cols.includes('balance') ? balance : null,
      description: t.description.replace(/\s+/g, ' ').trim(),
      counterpartyAccount: hasCpAccount ? (t.counterpartyAccount ?? null) : null,
      counterpartyName: hasCpName ? (t.counterpartyName ?? null) : null,
    })),
    openingBalance: layout.header.showOpening ? opening : null,
    closingBalance: layout.header.showClosing ? running : null,
    periodFrom: layout.header.showPeriod && txns.length ? txns[0].date : null,
    periodTo: layout.header.showPeriod && txns.length ? txns[txns.length - 1].date : null,
    declaredRowCount: layout.header.showCount ? txns.length : null,
    accountNo: layout.header.accountNo ?? null,
    iban: layout.header.iban ?? null,
    holderName: layout.header.holder ?? null,
    holderRegisterNo: layout.header.register ?? null,
    currency: layout.header.currency ?? 'MNT',
  };

  const amountText = (n: number): string => fmtAmount(n, layout);
  const emptyAmt = layout.emptyAmount === '0.00' ? amountText(0) : layout.emptyAmount;

  /** Нэг гүйлгээний нүднүүд (баганаар) + wrap мөрүүд */
  const rowLines = (t: SynTxn, balance: number, before: number, seq: number): string[][] => {
    const wrapped = wrapWords(t.description.replace(/\s+/g, ' ').trim(), layout.wrapAt);
    const isIncome = t.direction === 'INCOME';
    const outIsDebit = !layout.debitIsIncome; // debit багана зарлага мөн эсэх
    const cells = cols.map((col): string => {
      switch (col) {
        case 'seq':
          return String(seq);
        case 'date':
          return layout.timeInDateCell && t.time ? `${fmtDate(t.date, layout.dateFormat)} ${t.time}` : fmtDate(t.date, layout.dateFormat);
        case 'time':
          return t.time ?? '';
        case 'valueDate':
          return fmtDate(t.date, layout.dateFormat);
        case 'branch':
          return 'Төв салбар';
        case 'description':
          return wrapped[0];
        case 'debit':
          return (outIsDebit ? !isIncome : isIncome) ? amountText(t.amount) : emptyAmt;
        case 'credit':
          return (outIsDebit ? isIncome : !isIncome) ? amountText(t.amount) : emptyAmt;
        case 'income':
          return isIncome ? amountText(t.amount) : emptyAmt;
        case 'expense':
          return !isIncome ? amountText(t.amount) : emptyAmt;
        case 'amount':
          return `${isIncome ? (layout.plusSign ? '+' : '') : '-'}${amountText(t.amount)}`;
        case 'type':
          return layout.typeStyle === 'word' ? (isIncome ? L.income : L.expense) : isIncome ? 'Cr' : 'Dr';
        case 'balance':
          return `${balance < 0 ? '-' : ''}${amountText(balance)}`;
        case 'prevBalance':
          return `${before < 0 ? '-' : ''}${amountText(before)}`;
        case 'counterparty':
          return [t.counterpartyAccount, t.counterpartyName].filter(Boolean).join(' ');
        case 'counterpartyAccount':
          return t.counterpartyAccount ?? '';
        case 'counterpartyName':
          return t.counterpartyName ?? '';
      }
    });
    return [cells, ...wrapped.slice(1).map((w) => [w])];
  };

  const toLine = (cells: string[]): StatementTextLine => {
    const kept = layout.dropEmptyCells ? cells.filter((c) => c !== '') : cells;
    const nonEmpty = kept.filter((c) => c !== '');
    if (layout.textMode === 'cells') return { text: nonEmpty.join(' '), cells: kept };
    const joined = nonEmpty.join(layout.textMode === 'spaced' ? '  ' : ' ');
    return { text: nonEmpty.join(' '), cells: [joined] };
  };

  const columnHeader = (): string[] => cols.map((c) => layout.labelOverrides[c] ?? L[c]);

  // ---- Толгой хэсэг ----
  const H = HEADER_LABELS[layout.labels];
  const h = layout.header;
  const periodText =
    expected.periodFrom && expected.periodTo
      ? `${fmtDate(expected.periodFrom, layout.dateFormat)} - ${fmtDate(expected.periodTo, layout.dateFormat)}`
      : null;
  const kv = (label: string, value: string): string[][] => {
    if (layout.header.placement === 'inline') return [[`${label}: ${value}`]];
    if (layout.header.placement === 'nextCell') return [[`${label}:`, value]];
    return [[label], [value]];
  };
  const headerLines: string[][] = h.titleLines.map((t) => [t]);
  if (h.accountNo) headerLines.push(...kv(H.account, h.accountNo));
  if (h.iban) headerLines.push(...kv(H.iban, h.iban));
  if (h.holder) headerLines.push(...kv(H.holder, h.holder));
  if (h.register) headerLines.push(...kv(H.register, h.register));
  if (h.currency) headerLines.push(...kv(H.currency, h.currency));
  if (h.showPeriod && periodText) headerLines.push(...kv(H.period, periodText));
  if (h.showOpening) headerLines.push(...kv(H.opening, amountText(opening)));
  if (h.showClosing && !h.footerSummary) headerLines.push(...kv(H.closing, amountText(running)));
  if (h.showCount && !h.footerSummary) headerLines.push(...kv(H.count, String(txns.length)));

  // ---- Мөрүүд (файлын дарааллаар) ----
  const ordered = layout.newestFirst ? [...withBalance].reverse() : withBalance;
  const seqOf = new Map(withBalance.map((x, i) => [x, i + 1]));
  const groups: string[][][] = ordered.map((x) => rowLines(x.t, x.balance, x.before, seqOf.get(x) as number));

  // ---- Хуудаслалт ----
  const pages: StatementTextPage[] = [];
  const pageCount = Math.max(1, Math.ceil(groups.length / layout.rowsPerPage));
  for (let p = 0; p < pageCount; p++) {
    const slice = groups.slice(p * layout.rowsPerPage, (p + 1) * layout.rowsPerPage);
    const lines: string[][] = [];
    if (p === 0) lines.push(...headerLines);
    else lines.push(...layout.pageTitleLines.map((t) => [t]));
    if (p === 0 || layout.repeatHeader) lines.push(columnHeader());
    for (const g of slice) lines.push(...g);
    if (layout.subtotalRows) {
      const rows = slice.map((g) => g[0]);
      lines.push([L.total, ...(rows.length ? [String(rows.length)] : [])]);
    }
    if (p === pageCount - 1 && h.footerSummary) {
      if (h.showClosing) lines.push(...kv(H.closing, amountText(running)));
      if (h.showCount) lines.push(...kv(H.count, String(txns.length)));
    }
    if (layout.pageFooters) lines.push([`${L.page} ${p + 1}/${pageCount}`]);
    pages.push({ pageNo: p + 1, lines: lines.map(toLine) });
  }

  return {
    text: { source: layout.source, pages, meta: syntheticMeta({ fileName: 'synthetic.pdf', mimeType: 'application/pdf' }) },
    expected,
  };
}

// ---- Тогтоосон (seed-тэй) санамсаргүй гүйлгээ үүсгэгч ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DESCRIPTIONS_IN = ['Цалин', 'Salary', 'Шилжүүлэг орлого', 'Тэтгэвэр', 'Худалдааны орлого POS', 'Цалин Salary March', 'Хүү олгосон'];
const DESCRIPTIONS_OUT = [
  'QPay төлбөр',
  'ATM бэлэн авалт Khan Bank',
  'POS худалдан авалт',
  'Шилжүүлэг TDB',
  'Зээлийн төлбөр',
  'Mobicom төлбөр',
  'Гэр бүлд шилжүүлэг',
  'Supermarket purchase',
];

export interface GenerateOptions {
  seed: number;
  count: number;
  /** YYYY-MM-DD эхний өдөр */
  startDate: string;
  withTime: boolean;
  /** Өдөрт дунджаар хэдэн гүйлгээ (>=1) */
  perDay?: number;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Хронологи дарааллаар, дүн нь 100 төгрөгийн үржвэр. Үлдэгдэл сөрөг болохоос сэргийлж зарлагыг тохируулна (opening-ээс хамаарна). */
export function generateTransactions(opts: GenerateOptions, opening: number): SynTxn[] {
  const rand = mulberry32(opts.seed);
  const perDay = Math.max(1, opts.perDay ?? 3);
  const out: SynTxn[] = [];
  let balance = opening;
  let day = 0;
  let secondOfDay = 8 * 3600;
  for (let i = 0; i < opts.count; i++) {
    if (i > 0 && rand() < 1 / perDay) {
      day++;
      secondOfDay = 8 * 3600;
    }
    secondOfDay += 60 + Math.floor(rand() * 600);
    const isIncome = rand() < 0.4 || balance < 200000;
    const amount = (isIncome ? 50 + Math.floor(rand() * 5000) : 10 + Math.floor(rand() * 400)) * 100;
    const pool = isIncome ? DESCRIPTIONS_IN : DESCRIPTIONS_OUT;
    const h = Math.min(23, Math.floor(secondOfDay / 3600));
    const m = Math.floor((secondOfDay % 3600) / 60);
    const s = secondOfDay % 60;
    const pad = (n: number): string => String(n).padStart(2, '0');
    out.push({
      date: addDays(opts.startDate, day),
      time: opts.withTime ? `${pad(h)}:${pad(m)}:${pad(s)}` : undefined,
      direction: isIncome ? 'INCOME' : 'EXPENSE',
      amount,
      description: pool[Math.floor(rand() * pool.length)],
      counterpartyAccount: rand() < 0.5 ? String(5000000000 + Math.floor(rand() * 999999999)) : undefined,
      counterpartyName: rand() < 0.3 ? 'Тест Харилцагч' : undefined,
    });
    balance += isIncome ? amount : -amount;
  }
  return out;
}
