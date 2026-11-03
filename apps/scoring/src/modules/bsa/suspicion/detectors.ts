// BSA-FR-5.1 · docs/02 §5: сэжигтэй гүйлгээний 8 дохионы detector. Цэвэр функц (I/O байхгүй) — хадгалалт, эрх нь suspicion.service.ts-д.
// Босго бүгд параметрээр ирнэ (BSA-FR-5.4, hardcode байхгүй). Дохио нь «гарт нь шийдүүлэх» санал тул итгэл % (0–100) нь эвристик (DEMO).
//  - Тойрог / данс хоорондын залилан / хурдан авалт / хуваан авалт / хамтарсан / бүтэцлэгдсэн: өөрийн данс хоорондын (isOwnTransfer) гүйлгээг оруулахгүй.
//  - OWN_ACCOUNT: зөвхөн isOwnTransfer гүйлгээг ижил өдөр + ижил дүнтэй хосоор нь (нэг талт бол ганцаараа) бүлэглэнэ.
//  - Нэг гүйлгээ олон дохионд орж болно. Бүлэг бүр тогтвортой `key`-тэй (дохио + эрэмблэсэн гүйлгээний id) — дахин илрүүлэхэд шийдвэрлэсэн нь хадгалагдана.
import { createHash } from 'node:crypto';
import type { BsaChannel, BsaSuspicionThresholds, SuspicionFlag, TxnDirection } from '@los/contracts';

export interface SuspicionTxn {
  id: string;
  /** YYYY-MM-DD */
  txnDate: string;
  /** HH:mm | HH:mm:ss | null */
  txnTime: string | null;
  direction: TxnDirection;
  amount: number;
  description: string;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  channel: BsaChannel;
  isOwnTransfer: boolean;
}

export interface DetectedSuspicion {
  /** Тогтвортой түлхүүр: sha256(flag + эрэмблэсэн id).slice(0, 32) */
  key: string;
  flag: SuspicionFlag;
  transactionIds: string[];
  /** 0..100 */
  confidence: number;
  /** OWN_ACCOUNT: BSA-BR-5-аар аль хэдийн хасагдсан тул автоматаар шийдвэрлэгдсэн гэж үзнэ */
  autoResolved: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Огноо+цаг → мс. Цаг байхгүй бол өдрийн эхлэл (цагийн нарийвчлал алдагдсан ⇒ ижил өдөр = 0 цаг) */
export function toMillis(t: Pick<SuspicionTxn, 'txnDate' | 'txnTime'>): number {
  const [y, m, d] = t.txnDate.split('-').map(Number) as [number, number, number];
  const [hh = 0, mm = 0, ss = 0] = (t.txnTime ?? '00:00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

const hasTime = (t: SuspicionTxn): boolean => t.txnTime !== null;

/** Хоёр гүйлгээний зөрүү (мс). Аль нэгэнд цаг байхгүй бол зөвхөн өдрөөр (өдрийн зөрүү × 24ц; ижил өдөр = 0) */
function gapMs(a: SuspicionTxn, b: SuspicionTxn): number {
  if (hasTime(a) && hasTime(b)) return Math.abs(toMillis(a) - toMillis(b));
  return Math.abs(toMillis({ txnDate: a.txnDate, txnTime: null }) - toMillis({ txnDate: b.txnDate, txnTime: null }));
}

const normAcc = (s: string | null): string | null => {
  const v = s?.replace(/\s+/g, '').toUpperCase() ?? '';
  return v === '' ? null : v;
};

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export function suspicionKey(flag: SuspicionFlag, ids: readonly string[]): string {
  return createHash('sha256').update(`${flag}|${[...ids].sort().join(',')}`).digest('hex').slice(0, 32);
}

function make(flag: SuspicionFlag, ids: string[], confidence: number, autoResolved = false): DetectedSuspicion {
  const transactionIds = [...new Set(ids)].sort();
  return { key: suspicionKey(flag, transactionIds), flag, transactionIds, confidence: clamp(confidence), autoResolved };
}

const byTime = (a: SuspicionTxn, b: SuspicionTxn): number => toMillis(a) - toMillis(b) || a.id.localeCompare(b.id);
const relDiff = (a: number, b: number): number => Math.abs(a - b) / Math.max(a, b, 1e-9);

// ───────────────────────── 1. Өөрийн данс руу шилжүүлэг ─────────────────────────

export function detectOwnAccount(all: readonly SuspicionTxn[]): DetectedSuspicion[] {
  const own = all.filter((t) => t.isOwnTransfer).sort(byTime);
  const used = new Set<string>();
  const out: DetectedSuspicion[] = [];
  for (const t of own) {
    if (used.has(t.id)) continue;
    used.add(t.id);
    const mate = own.find((u) => !used.has(u.id) && u.direction !== t.direction && u.txnDate === t.txnDate && u.amount === t.amount);
    if (mate) used.add(mate.id);
    out.push(make('OWN_ACCOUNT', mate ? [t.id, mate.id] : [t.id], mate ? 100 : 80, true));
  }
  return out;
}

// ───────────────────────── 2. Тойрог шилжүүлэг ─────────────────────────

interface CircularPair {
  income: SuspicionTxn;
  expense: SuspicionTxn;
  sameParty: boolean;
}

/** Орлого орж ирээд ойролцоо дүнтэй гарсан хосууд (нэг орлого ≤ 1 зарлагатай) */
function circularPairs(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): CircularPair[] {
  const incomes = txns.filter((t) => t.direction === 'INCOME').sort(byTime);
  const expenses = txns.filter((t) => t.direction === 'EXPENSE').sort(byTime);
  const usedExp = new Set<string>();
  const pairs: CircularPair[] = [];
  for (const inc of incomes) {
    let best: { e: SuspicionTxn; score: number; same: boolean } | null = null;
    for (const exp of expenses) {
      if (usedExp.has(exp.id)) continue;
      if (toMillis(exp) < toMillis(inc) - (hasTime(exp) && hasTime(inc) ? 0 : DAY - 1)) continue;
      if (gapMs(inc, exp) > th.circularWindowHours * HOUR) continue;
      if (relDiff(inc.amount, exp.amount) > th.circularAmountTolerance) continue;
      const a = normAcc(inc.counterpartyAccount);
      const same = a !== null && a === normAcc(exp.counterpartyAccount);
      const score = (same ? 0 : 1) * 1e9 + gapMs(inc, exp);
      if (!best || score < best.score) best = { e: exp, score, same };
    }
    if (best) {
      usedExp.add(best.e.id);
      pairs.push({ income: inc, expense: best.e, sameParty: best.same });
    }
  }
  return pairs;
}

export function detectCircular(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  return circularPairs(txns, th).map((p) => {
    const closeness = 1 - relDiff(p.income.amount, p.expense.amount) / Math.max(th.circularAmountTolerance, 1e-9);
    return make('CIRCULAR', [p.income.id, p.expense.id], (p.sameParty ? 75 : 50) + 20 * Math.max(0, closeness));
  });
}

// ───────────────────────── 3. Данс хоорондын залилан ─────────────────────────

/** Нэг харьцсан данстай ≥ N тойрог хос (давтамж) */
export function detectInterAccountFraud(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const groups = new Map<string, CircularPair[]>();
  for (const p of circularPairs(txns, th)) {
    if (!p.sameParty) continue;
    const acc = normAcc(p.income.counterpartyAccount) as string;
    groups.set(acc, [...(groups.get(acc) ?? []), p]);
  }
  const out: DetectedSuspicion[] = [];
  for (const pairs of groups.values()) {
    if (pairs.length < th.interAccountMinPairs) continue;
    out.push(make('INTER_ACCOUNT_FRAUD', pairs.flatMap((p) => [p.income.id, p.expense.id]), 60 + 8 * (pairs.length - th.interAccountMinPairs)));
  }
  return out;
}

// ───────────────────────── 4. Хурдан бэлэн авалт ─────────────────────────

export function detectQuickCash(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const cash = txns.filter((t) => t.direction === 'EXPENSE' && t.channel === 'ATM').sort(byTime);
  const out: DetectedSuspicion[] = [];
  for (const inc of txns.filter((t) => t.direction === 'INCOME' && t.amount >= th.quickCashMinIncome).sort(byTime)) {
    const after = cash.filter((c) => toMillis(c) >= toMillis(inc) - (hasTime(c) && hasTime(inc) ? 0 : DAY - 1) && gapMs(inc, c) <= th.quickCashWindowHours * HOUR);
    const total = after.reduce((s, c) => s + c.amount, 0);
    if (after.length === 0 || total < inc.amount * th.quickCashMinShare) continue;
    out.push(make('QUICK_CASH', [inc.id, ...after.map((c) => c.id)], 50 + 40 * Math.min(1, total / inc.amount)));
  }
  return out;
}

// ───────────────────────── 5. Хуваан авалт ─────────────────────────

/** Нэг дансанд (эсвэл бэлэн авалт) богино хугацаанд олон удаа гарсан зарлага, нийлбэр нь босгоос дээш */
export function detectSplitWithdrawal(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const groups = new Map<string, SuspicionTxn[]>();
  for (const t of txns.filter((x) => x.direction === 'EXPENSE')) {
    const acc = normAcc(t.counterpartyAccount);
    const key = t.channel === 'ATM' ? 'ATM' : acc ? `ACC:${acc}` : null;
    if (key) groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: DetectedSuspicion[] = [];
  for (const list of groups.values()) {
    list.sort(byTime);
    const taken = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const start = list[i] as SuspicionTxn;
      if (taken.has(start.id)) continue;
      const win = list.filter((t) => !taken.has(t.id) && toMillis(t) >= toMillis(start) && gapMs(start, t) <= th.splitWindowHours * HOUR);
      const total = win.reduce((s, t) => s + t.amount, 0);
      if (win.length < th.splitMinCount || total < th.splitMinTotal) continue;
      win.forEach((t) => taken.add(t.id));
      out.push(make('SPLIT_WITHDRAWAL', win.map((t) => t.id), 50 + 10 * (win.length - th.splitMinCount + 1)));
    }
  }
  return out;
}

// ───────────────────────── 6. Хамтарсан залилан ─────────────────────────

/** Богино хугацаанд олон ялгаатай данснаас ойролцоо дүнтэй орлого (кластер) */
export function detectCollusion(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const incomes = txns.filter((t) => t.direction === 'INCOME' && normAcc(t.counterpartyAccount) !== null).sort(byTime);
  const taken = new Set<string>();
  const out: DetectedSuspicion[] = [];
  for (const start of incomes) {
    if (taken.has(start.id)) continue;
    const win = incomes.filter(
      (t) => !taken.has(t.id) && toMillis(t) >= toMillis(start) && toMillis(t) - toMillis(start) <= th.collusionWindowDays * DAY && relDiff(t.amount, start.amount) <= th.collusionAmountTolerance,
    );
    // нэг данснаас хамгийн эхний нэг гүйлгээг л авч, ялгаатай дансны тоог шалгана
    const perAcc = new Map<string, SuspicionTxn>();
    for (const t of win) if (!perAcc.has(normAcc(t.counterpartyAccount) as string)) perAcc.set(normAcc(t.counterpartyAccount) as string, t);
    const members = [...perAcc.values()];
    const total = members.reduce((s, t) => s + t.amount, 0);
    if (members.length < th.collusionMinAccounts || total < th.collusionMinTotal) continue;
    members.forEach((t) => taken.add(t.id));
    out.push(make('COLLUSION', members.map((t) => t.id), 45 + 5 * (members.length - th.collusionMinAccounts)));
  }
  return out;
}

// ───────────────────────── 7. Бүтэцлэгдсэн төлбөр ─────────────────────────

/** Тайлагналын босгын тэнд (босго × ratio ≤ дүн < босго) давтагдсан гүйлгээ */
export function detectStructuring(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const low = th.structuringThreshold * th.structuringBandRatio;
  const near = txns.filter((t) => t.amount >= low && t.amount < th.structuringThreshold).sort(byTime);
  const taken = new Set<string>();
  const out: DetectedSuspicion[] = [];
  for (const start of near) {
    if (taken.has(start.id)) continue;
    const win = near.filter((t) => !taken.has(t.id) && toMillis(t) >= toMillis(start) && toMillis(t) - toMillis(start) <= th.structuringWindowDays * DAY);
    if (win.length < th.structuringMinCount) continue;
    win.forEach((t) => taken.add(t.id));
    out.push(make('STRUCTURING', win.map((t) => t.id), 55 + 8 * (win.length - th.structuringMinCount)));
  }
  return out;
}

// ───────────────────────── 8. Мөрийтэй тоглоом ─────────────────────────

function keywordMatcher(keywords: readonly string[]): (text: string) => boolean {
  const parts = keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k !== '')
    .map((k) => {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // богино латин үг («bet») өөр үгийн дотор таарахаас сэргийлнэ
      return /^[a-z0-9 ]{1,4}$/.test(k) ? `(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)` : esc;
    });
  if (parts.length === 0) return () => false;
  const re = new RegExp(parts.join('|'), 'u');
  return (text) => re.test(text.toLowerCase());
}

export function detectGambling(txns: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const match = keywordMatcher(th.gamblingKeywords);
  return txns.filter((t) => match(`${t.description} ${t.counterpartyName ?? ''}`)).map((t) => make('GAMBLING', [t.id], 85));
}

// ───────────────────────── Нэгдсэн ─────────────────────────

/** Бүх 8 дохио. Гаралт: ижил түлхүүртэйг нэгтгэнэ (дарааллаас үл хамаарах, тогтвортой) */
export function detectSuspicions(all: readonly SuspicionTxn[], th: BsaSuspicionThresholds): DetectedSuspicion[] {
  const open = all.filter((t) => !t.isOwnTransfer && t.amount > 0);
  const found = [
    ...detectOwnAccount(all),
    ...detectCircular(open, th),
    ...detectInterAccountFraud(open, th),
    ...detectQuickCash(open, th),
    ...detectSplitWithdrawal(open, th),
    ...detectCollusion(open, th),
    ...detectStructuring(open, th),
    ...detectGambling(open, th),
  ];
  const byKey = new Map<string, DetectedSuspicion>();
  for (const d of found) if (!byKey.has(d.key)) byKey.set(d.key, d);
  return [...byKey.values()].sort((a, b) => a.flag.localeCompare(b.flag) || (a.transactionIds[0] as string).localeCompare(b.transactionIds[0] as string));
}
