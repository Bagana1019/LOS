// Нэг мөрийг гүйлгээ болгон задлах. Огноогоор эхэлсэн мөр л гүйлгээний нэр дэвшигч (BSA-FR-2.2).
// 1) Нүдний тоо толгойтой таарвал баганаар (байрлалаар), 2) таараагүй бол (PDF хоосон нүдийг хасдаг) баруунаас token-оор.
import { findDates, normalizeWhitespace, parseDateIso, parseTime, toMatchKey, type DateOrder, type FoundDate } from '@los/ocr';
import type { TxnDirection } from '@los/contracts';
import type { ColumnRole } from './bank-profile';
import type { TableHeader } from './column-matcher';
import { TYPE_CELL_LEXICON, type EngineConfig } from './defaults';
import { accountCell, amountCell, findAccountInText, isBlankish, timeCell, type AmountCell } from './text-utils';

export interface RawRow {
  page: number;
  line: number;
  date: string;
  time: string | null;
  /** > 0 */
  amount: number;
  /** Тодорхой дохио (дебит/кредит багана, '-' тэмдэг, төрлийн багана); байхгүй бол null */
  hint: TxnDirection | null;
  /** Нэг "дүн" баганын эерэг утга: багана тэмдэгтэй (сөрөг утга байгаа) бол INCOME гэж үзнэ (глобал алхамд шийднэ) */
  weakPositive: boolean;
  /** "Дүн" баганад сөрөг тэмдэгтэй байсан (баганы тэмдэгтэй гэдгийн нотолгоо) */
  signedNegative: boolean;
  balance: number | null;
  /** Тайлбарын хэсгүүд (wrap мөр нэмэгдэнэ) */
  descParts: string[];
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  viaFallback: boolean;
}

export interface RowContext {
  cfg: EngineConfig;
  order: DateOrder;
  header: TableHeader | null;
  /** 'Дебит' багана ямар чиглэл (анхдагч EXPENSE) */
  debitDir: TxnDirection;
  creditDir: TxnDirection;
  spaceThousands: boolean;
  /** toMatchKey-ээр нормчилсон "эхний/эцсийн үлдэгдэл" шошго (хүснэгт доторх үлдэгдлийн мөр) */
  markerKeys: { opening: string[]; closing: string[] };
}

export type LineResult =
  | { kind: 'none' }
  | { kind: 'dateOnly' }
  | { kind: 'row'; row: RawRow }
  | { kind: 'marker'; which: 'opening' | 'closing'; balance: number }
  | { kind: 'unparsed'; reason: string };

const NONE: LineResult = { kind: 'none' };
const SEQ_CELL_RE = /^#?\d{1,6}[.)]?$/;
const SEQ_PREFIX_RE = /^\s*\d{1,6}[.)]?\s+/;
const TIME_AFTER_DATE_RE = /^\s*[T,]?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,6})?(?: ?[AaPp]\.?[Mm]\.?)?)(?![\d:])/;
const DATE_HEAD_CHARS = 48;
const PURE_DATE_CELL_MAX = 40;

export interface Lead {
  date: string;
  time: string | null;
  /** Огноо байсан нүдний индекс */
  dateIdx: number;
  /** Огноо/цагийн дараах үлдэх нүднүүд (огнооны нүдний үлдэгдэл эхэнд) */
  rest: string[];
}

/** Мөр огноогоор (өмнө нь дугаар байж болно) эхэлсэн бол огноо/цаг/үлдэх нүднүүд */
export function leadingDate(cells: string[], ctx: Pick<RowContext, 'order'>): Lead | null {
  let i = 0;
  if (cells.length > 1 && SEQ_CELL_RE.test(cells[0].trim())) i = 1;
  const first = cells[i] ?? '';
  const head = first.slice(0, DATE_HEAD_CHARS);
  let offset = 0;
  let found: FoundDate | undefined = findDates(head, { order: ctx.order })[0];
  if (found?.index !== 0) {
    found = undefined;
    const prefix = SEQ_PREFIX_RE.exec(head); // "12 2026-03-10 ..." (дугаар ба огноо нэг нүдэнд)
    if (prefix) {
      const again = findDates(head.slice(prefix[0].length), { order: ctx.order })[0];
      if (again?.index === 0) {
        found = again;
        offset = prefix[0].length;
      }
    }
  }
  if (!found) return null;
  let after = first.slice(offset + found.raw.length);
  let time: string | null = null;
  const tm = TIME_AFTER_DATE_RE.exec(after);
  if (tm) {
    time = parseTime(tm[1]);
    after = after.slice(tm[0].length);
  }
  // Огнооны дараах нүднүүд: [цаг] [хоёр дахь огноо (бүртгэсэн/утгын)] [цаг] — зөвхөн цаг/огнооноос бүрдсэн нүдийг алгасна
  let j = i + 1;
  let secondDateSkipped = false;
  while (j < cells.length) {
    const cell = cells[j];
    const t = time === null ? timeCell(cell) : null;
    if (t !== null) time = t;
    else if (!secondDateSkipped && cell.trim().length <= PURE_DATE_CELL_MAX && parseDateIso(cell, { order: ctx.order }) !== null) secondDateSkipped = true;
    else break;
    j++;
  }
  const rest: string[] = [];
  const tail = after.trim();
  if (tail !== '') rest.push(tail);
  for (let k = j; k < cells.length; k++) rest.push(cells[k]);
  return { date: found.iso, time, dateIdx: i, rest };
}

/**
 * Мөрийг token болгоно. spaceThousands бол баруунаас нь "1 234 567" (эхний 1-2 оронтой бүлэг + 3 оронтой бүлгүүд)-ийг нэг token болгоно.
 */
function tokenize(text: string, spaceThousands: boolean): string[] {
  const raw = text.trim().split(/\s+/).filter((t) => t !== '');
  if (!spaceThousands) return raw;
  const out: string[] = [];
  let i = raw.length - 1;
  while (i >= 0) {
    let tok = raw[i--];
    if (/^\d{3}(?:[.,]\d{1,2})?$/.test(tok)) {
      while (i >= 0 && /^\d{3}$/.test(raw[i])) tok = `${raw[i--]} ${tok}`;
      if (i >= 0 && /^\d{1,2}$/.test(raw[i])) tok = `${raw[i--]} ${tok}`;
    }
    out.push(tok);
  }
  return out.reverse();
}

const asDir = (typeCell: string): TxnDirection | null => (typeCell.length > 20 ? null : (TYPE_CELL_LEXICON.get(toMatchKey(typeCell)) ?? null));

type MoneyRole = 'debit' | 'credit' | 'amount' | 'balance';
const isMoneyRole = (r: ColumnRole | null): r is MoneyRole => r === 'debit' || r === 'credit' || r === 'amount' || r === 'balance';

interface Money {
  /** undefined = энэ үүрэг толгойд/мөрд байхгүй; null = байгаа ч хоосон */
  debit: AmountCell | null | undefined;
  credit: AmountCell | null | undefined;
  amount: AmountCell | null | undefined;
  balance: AmountCell | null | undefined;
  /** Нэг л тодорхойгүй талын дүн (дебит/кредитийн аль нь вэ мэдэгдэхгүй) */
  single: AmountCell | null | undefined;
}

const emptyMoney = (): Money => ({ debit: undefined, credit: undefined, amount: undefined, balance: undefined, single: undefined });

type Resolved =
  | { amount: number; hint: TxnDirection | null; weakPositive: boolean; signedNegative: boolean }
  | { error: string }
  | { zero: true };

function resolveMoney(m: Money, typeHint: TxnDirection | null, ctx: RowContext): Resolved {
  if (m.debit !== undefined || m.credit !== undefined) {
    const d = m.debit ? Math.abs(m.debit.value) : 0;
    const c = m.credit ? Math.abs(m.credit.value) : 0;
    if (d > 0 && c > 0) return { error: 'both debit and credit are non-zero' };
    if (d === 0 && c === 0) return { zero: true };
    return { amount: d > 0 ? d : c, hint: d > 0 ? ctx.debitDir : ctx.creditDir, weakPositive: false, signedNegative: false };
  }
  const a = m.amount ?? m.single;
  if (!a || a.value === 0) return { zero: true };
  if (typeHint) return { amount: Math.abs(a.value), hint: typeHint, weakPositive: false, signedNegative: false };
  if (a.value < 0) return { amount: -a.value, hint: 'EXPENSE', weakPositive: false, signedNegative: true };
  if (a.plus) return { amount: a.value, hint: 'INCOME', weakPositive: false, signedNegative: false }; // тодорхой '+' = орлого
  return { amount: a.value, hint: null, weakPositive: true, signedNegative: false };
}

/** Тайлбар, харьцсан данс/нэр, төрөл, цаг — текст шинжтэй үүргүүдийн хураагуур */
interface TextAcc {
  desc: string[];
  cpAcc: string | null;
  cpName: string | null;
  typeHint: TxnDirection | null;
  time: string | null;
}

function splitCounterparty(cell: string, cfg: EngineConfig): { account: string | null; name: string | null } {
  const text = normalizeWhitespace(cell);
  if (text === '' || isBlankish(text)) return { account: null, name: null };
  const account = accountCell(text, cfg) ?? findAccountInText(text, cfg);
  const rest = account ? normalizeWhitespace(text.replace(/\d[\d -]{6,}\d|MN\d{2}(?: ?\d{4}){4}/g, ' ')) : text;
  return { account, name: /\p{L}{2}/u.test(rest) ? rest : null };
}

/** Нэг нүдийг тодорхой үүргээр хураагуурт нэмнэ. false: нүд үүрэгт тохирохгүй (positional хүчингүй) */
function applyText(role: ColumnRole | null, cell: string, acc: TextAcc, ctx: RowContext): boolean {
  switch (role) {
    case 'description':
      acc.desc.push(cell);
      return true;
    case 'counterparty': {
      const s = splitCounterparty(cell, ctx.cfg);
      acc.cpAcc = acc.cpAcc ?? s.account;
      acc.cpName = acc.cpName ?? s.name;
      return true;
    }
    case 'counterpartyAccount': {
      const t = normalizeWhitespace(cell);
      acc.cpAcc = acc.cpAcc ?? (accountCell(t, ctx.cfg) ?? findAccountInText(t, ctx.cfg));
      return true;
    }
    case 'counterpartyName': {
      const t = normalizeWhitespace(cell);
      if (t !== '' && !isBlankish(t)) acc.cpName = acc.cpName ?? t;
      return true;
    }
    case 'type':
      acc.typeHint = asDir(cell) ?? acc.typeHint;
      return true;
    case 'time': {
      if (isBlankish(cell)) return true;
      const t = timeCell(cell);
      if (t === null) return false;
      acc.time = acc.time ?? t;
      return true;
    }
    case 'seq':
    case 'ignore':
    case 'ignoreAmount':
      return true;
    case null:
      // Таниагдаагүй багана: тайлбарын багана олдоогүй бол мэдээллийг алдахгүйн тулд тайлбарт нэмнэ
      if (!ctx.header?.hasDescription && !isBlankish(cell)) acc.desc.push(cell);
      return true;
    default:
      return true;
  }
}

/** Баганын байрлалаар (нүдний тоо = толгойн багана). Хүчингүй (огноо/дүн/цаг буруу) бол null → баруунаас тулгах горим. */
function positional(cells: string[], lead: Lead, ctx: RowContext): { money: Money; acc: TextAcc } | null {
  const h = ctx.header;
  if (!h || !h.cellMapped || cells.length !== h.cellCount || h.roles[lead.dateIdx] !== 'date') return null;
  const money = emptyMoney();
  const acc: TextAcc = { desc: [], cpAcc: null, cpName: null, typeHint: null, time: lead.time };
  for (let k = 0; k < cells.length; k++) {
    const role = h.roles[k];
    const cell = cells[k];
    if (isMoneyRole(role)) {
      if (isBlankish(cell) && role !== 'amount') {
        money[role] = null; // хоосон нүд = энэ талд дүн алга
        continue;
      }
      const a = amountCell(cell, ctx.cfg);
      if (!a) return null;
      money[role] = a;
    } else if (role !== 'date' && !applyText(role, cell, acc, ctx)) {
      return null;
    }
  }
  return { money, acc };
}

interface TailResult {
  money: Money;
  acc: TextAcc;
  /** Дүнгийн баганаас өмнөх (тайлбар...) нүднүүд */
  mid: string[];
  numCount: number;
}

// ---- Баруунаас нь баганатай тулгах (хоосон нүд хасагдсан PDF мөр) ----
const INF = 1e9;
/** Үүрэг нүдгүй (хасагдсан) байх торгууль. Дебит/кредит нь '-' тэмдэглэгээтэй байдаг тул харьцсан данснаас бага зардалтай биш */
const SKIP_ROLE_COST: Record<ColumnRole, number> = {
  seq: 0.2,
  date: 50, // биеийн үүрэгт огноо байх нь утгагүй (хачин толгой) — гэхдээ зэрэгцүүлэлт үргэлж үр дүнтэй байхын тулд хязгаартай
  time: 0.5,
  description: 3,
  debit: 1,
  credit: 1,
  amount: 4,
  balance: 3,
  counterparty: 0.8,
  counterpartyAccount: 0.8,
  counterpartyName: 0.8,
  type: 0.8,
  ignore: 0.2,
  ignoreAmount: 1,
};
const SKIP_NULL_ROLE_COST = 0.5;
/** Ямар ч үүрэгт тохирохгүй нүд (илүү нүд) */
const SKIP_CELL_COST = 2.5;
const DASH_COST = 0.5;

interface CellInfo {
  text: string;
  amount: AmountCell | null;
  dash: boolean;
  account: boolean;
  letters: boolean;
  dir: boolean;
  time: boolean;
}

/** Зөвхөн толгойд шаардлагатай шинжүүдийг тооцно (toMatchKey зэрэг үнэтэй дуудлагыг тойрно) */
interface Needs {
  account: boolean;
  dir: boolean;
  time: boolean;
}

function classify(text: string, ctx: RowContext, needs: Needs): CellInfo {
  const a = amountCell(text, ctx.cfg);
  return {
    text,
    amount: a && !a.idLike ? a : null,
    dash: isBlankish(text),
    account: needs.account && accountCell(text, ctx.cfg) !== null,
    letters: /\p{L}/u.test(text),
    dir: needs.dir && asDir(text) !== null,
    time: needs.time && timeCell(text) !== null,
  };
}

function compat(role: ColumnRole | null, c: CellInfo): number {
  if (isMoneyRole(role)) return c.amount ? 0 : c.dash ? DASH_COST : INF;
  switch (role) {
    case 'description':
      return c.dash ? 1 : c.amount ? 2 : 0;
    case 'counterpartyAccount':
      return c.account ? 0 : c.dash ? DASH_COST : INF;
    case 'counterpartyName':
      return !c.account && !c.amount && c.letters ? 0 : c.dash ? DASH_COST : INF;
    case 'counterparty':
      return c.account || (!c.amount && c.letters) ? 0 : c.dash ? DASH_COST : INF;
    case 'type':
      return c.dir ? 0 : c.dash ? DASH_COST : INF;
    case 'time':
      return c.time ? 0 : INF;
    case 'ignoreAmount':
      return c.amount ? 0 : c.dash ? DASH_COST : INF;
    default:
      return c.dash ? 0.2 : c.amount ? 1.5 : 0.3; // seq, ignore, таниагдаагүй
  }
}

/**
 * Нүдний тоо толгойтой таараагүй мөрийг толгойн үүргүүдтэй (огноо/цагийн дараах: тайлбар, дүн, төрөл, харьцсан данс...) динамик
 * програмчлалаар зэрэгцүүлнэ: үүрэг нүдгүй (PDF хоосон нүдийг хасдаг) эсвэл илүү нүд байж болно, нийт торгууль хамгийн бага байх хувилбар.
 * Дебит/кредитийн аль нэг нь л байвал (нөгөөд нь '-' байхгүй) аль тал нь тодорхойгүй (single) — үлдэгдлээр шийднэ.
 */
function alignBody(cells: string[], h: TableHeader, ctx: RowContext): TailResult {
  const units = cells.filter((c) => c.trim() !== ''); // байрлалд итгэхгүй; '-' тэмдэглэгээтэй нүд хэвээр
  const roles = h.bodyRoles;
  const t = roles.length;
  const m = Math.min(units.length, t + 6); // баруун талын цонх; түүнээс зүүн нь тайлбарын хэсэг
  const base = units.length - m;
  const needs: Needs = {
    account: roles.some((r) => r === 'counterparty' || r === 'counterpartyAccount' || r === 'counterpartyName'),
    dir: roles.includes('type'),
    time: roles.includes('time'),
  };
  const info = units.slice(base).map((u) => classify(u, ctx, needs));
  // D[i][j]: R[i..] ба C[j..]-ийн хамгийн бага торгууль
  const D: number[][] = Array.from({ length: t + 1 }, () => new Array<number>(m + 1).fill(INF));
  const choice: number[][] = Array.from({ length: t + 1 }, () => new Array<number>(m + 1).fill(0)); // 1 match, 2 skip role, 3 skip cell
  D[t][m] = 0;
  for (let j = m - 1; j >= 0; j--) {
    D[t][j] = D[t][j + 1] + SKIP_CELL_COST;
    choice[t][j] = 3;
  }
  for (let i = t - 1; i >= 0; i--) {
    const skipRole = roles[i] === null ? SKIP_NULL_ROLE_COST : SKIP_ROLE_COST[roles[i] as ColumnRole];
    for (let j = m; j >= 0; j--) {
      let best = INF;
      let pick = 0;
      if (j < m) {
        const cost = compat(roles[i], info[j]);
        if (cost < INF && D[i + 1][j + 1] + cost < best) {
          best = D[i + 1][j + 1] + cost;
          pick = 1;
        }
      }
      if (D[i + 1][j] + skipRole < best) {
        best = D[i + 1][j] + skipRole;
        pick = 2;
      }
      if (j < m && D[i][j + 1] + SKIP_CELL_COST < best) {
        best = D[i][j + 1] + SKIP_CELL_COST;
        pick = 3;
      }
      D[i][j] = best;
      choice[i][j] = pick;
    }
  }
  const money = emptyMoney();
  const acc: TextAcc = { desc: [], cpAcc: null, cpName: null, typeHint: null, time: null };
  const pieces: Array<{ at: number; text: string }> = units.slice(0, base).map((text, at) => ({ at, text })); // зүүн талын илүү нүднүүд
  let numCount = 0;
  for (let i = 0, j = 0; i < t || j < m; ) {
    // choice=0 (зам олдоогүй) нь INF торгуультай үүрэг үед л — хэзээ ч гацахгүйн тулд үүргийг алгасна
    const pick = i < t ? choice[i][j] || (j >= m ? 2 : 3) : 3;
    if (pick === 1) {
      const role = roles[i];
      const c = info[j];
      if (isMoneyRole(role)) {
        money[role] = c.amount ?? null; // amount null → '-' тэмдэглэгээ
        if (c.amount) numCount++;
      } else if (role === 'description' || (role === null && !h.hasDescription)) {
        if (!c.dash) pieces.push({ at: base + j, text: c.text });
      } else if (!c.dash) {
        applyText(role, c.text, acc, ctx);
      }
      i++;
      j++;
    } else if (pick === 2) {
      i++;
    } else {
      if (j < m) pieces.push({ at: base + j, text: info[j].text }); // ямар ч үүрэгт тохирохгүй нүд — мэдээллийг алдахгүй
      j++;
    }
  }
  acc.desc = pieces.sort((a, b) => a.at - b.at).map((p) => p.text);
  const dc = [money.debit, money.credit];
  if (h.numericRoles.includes('debit') && h.numericRoles.includes('credit') && dc.filter((x) => x !== undefined).length === 1 && dc.some((x) => x)) {
    money.single = money.debit ?? money.credit; // нэг тал л байгаа, аль нь гэдэг нь тодорхойгүй
    money.debit = undefined;
    money.credit = undefined;
  }
  return { money, acc, mid: [], numCount };
}

/** Толгойгүй (эсвэл token) горим: баруунаас нь дүнгүүд — [дебит, кредит, үлдэгдэл] гэж таамагласан дараалалтай */
function headerlessTail(units: string[], ctx: RowContext): TailResult {
  const money = emptyMoney();
  const acc: TextAcc = { desc: [], cpAcc: null, cpName: null, typeHint: null, time: null };
  let end = units.length;
  let sawFormatted = false;
  const nums: AmountCell[] = [];
  while (end > 0 && nums.length < 3) {
    const a = amountCell(units[end - 1], ctx.cfg);
    if (!a || a.idLike || (a.plainLong && sawFormatted)) break;
    nums.unshift(a);
    sawFormatted = sawFormatted || a.formatted;
    end--;
  }
  const n = nums.length;
  if (n === 3) {
    [money.debit, money.credit, money.balance] = nums;
  } else if (n === 2) {
    money.single = nums[0];
    money.balance = nums[1];
  } else if (n === 1) {
    money.balance = nums[0]; // зөвхөн үлдэгдэл (эхний/эцсийн үлдэгдлийн мөр байж болно)
  }
  return { money, acc, mid: units.slice(0, end), numCount: n };
}

/** Толгойгүй горим: дүнгийн өмнөх нүднүүдээс дансны дугаартайг харьцсан данс, бусдыг тайлбар болгоно */
function assignMid(cells: string[], ctx: RowContext, acc: TextAcc): void {
  for (const cell of cells) {
    const account = accountCell(cell, ctx.cfg, false);
    if (account && acc.cpAcc === null) acc.cpAcc = account;
    else acc.desc.push(cell);
  }
}

function markerOf(desc: string, ctx: RowContext): 'opening' | 'closing' | null {
  const key = ` ${toMatchKey(desc)} `;
  if (ctx.markerKeys.opening.some((k) => key.includes(` ${k} `))) return 'opening';
  if (ctx.markerKeys.closing.some((k) => key.includes(` ${k} `))) return 'closing';
  return null;
}

/**
 * Нэг мөр. 'none' = огноогоор эхлээгүй; 'dateOnly' = огноотой ч дүн алга (wrap-д нэгтгэнэ);
 * 'unparsed' = мөр шиг ч уншигдаагүй; 'marker' = хүснэгт доторх эхний/эцсийн үлдэгдлийн мөр.
 */
export function parseRowLine(cells: string[], page: number, lineNo: number, ctx: RowContext): LineResult {
  const lead = leadingDate(cells, ctx);
  if (!lead) return NONE;

  let money: Money;
  let acc: TextAcc;
  let viaFallback = false;
  const pos = positional(cells, lead, ctx);
  if (pos) {
    ({ money, acc } = pos);
  } else {
    viaFallback = true;
    // Нэг нүд (зайгаар тасарсангүй) бол үгээр тасалж, мянгатын зайтай дүнг нэгтгэнэ
    const single = lead.rest.length === 1;
    const units = single ? tokenize(lead.rest[0], ctx.spaceThousands) : lead.rest;
    const tail = ctx.header && !single ? alignBody(units, ctx.header, ctx) : headerlessTail(units, ctx);
    if (tail.numCount === 0) return { kind: 'dateOnly' };
    money = tail.money;
    acc = tail.acc;
    if (single) acc.desc.push(tail.mid.join(' ')); // нүдний хил байхгүй: тайлбар = үлдсэн бүх token
    else if (!ctx.header) assignMid(tail.mid, ctx, acc);
  }
  if (acc.time === null) acc.time = lead.time;

  const resolved = resolveMoney(money, acc.typeHint, ctx);
  if ('error' in resolved) return { kind: 'unparsed', reason: resolved.error };
  const description = normalizeWhitespace(acc.desc.join(' '));
  const balance = money.balance ? money.balance.value : null;
  if ('zero' in resolved) {
    // Үлдэгдлийн мөр (дүнгүй, зөвхөн үлдэгдэлтэй) эсэх
    const bal = money.balance?.value ?? money.single?.value ?? money.amount?.value ?? null;
    const which = bal !== null ? markerOf(description, ctx) : null;
    if (which && bal !== null) return { kind: 'marker', which, balance: bal };
    return { kind: 'unparsed', reason: 'amount is zero or missing' };
  }
  if (!Number.isFinite(resolved.amount) || resolved.amount <= 0) return { kind: 'unparsed', reason: 'amount is not positive' };
  return {
    kind: 'row',
    row: {
      page,
      line: lineNo,
      date: lead.date,
      time: acc.time,
      amount: resolved.amount,
      hint: resolved.hint,
      weakPositive: resolved.weakPositive,
      signedNegative: resolved.signedNegative,
      balance,
      descParts: description === '' ? [] : [description],
      counterpartyAccount: acc.cpAcc,
      counterpartyName: acc.cpName,
      viaFallback,
    },
  };
}
