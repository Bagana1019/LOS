// Хуулгын дараалал (шинэ→хуучин), дебит/кредитийн чиглэл, үлдэгдлийн өөрчлөлтөөр чиглэл тодорхойлох (BSA-FR-2.2).
// Бүх шалгалт үлдэгдлийн ӨӨРЧЛӨЛТ дээр суурилна: ерөнхий хувилбар нь хуулга бүхэлдээ нэг тогтвортой дүрэмтэй гэж үзнэ.
import type { TxnDirection } from '@los/contracts';
import type { RawRow } from './row-parser';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** prev ± amount = bal тэнцэлд аль чиглэл нь илүү ойр вэ. Үлдэгдэл мэдэгдэхгүй/тэнцүү зайтай бол null. */
export function impliedDirection(prev: number | null, bal: number | null, amount: number, eps: number): TxnDirection | null {
  if (prev === null || bal === null) return null;
  const asIncome = Math.abs(round2(prev + amount - bal));
  const asExpense = Math.abs(round2(prev - amount - bal));
  if (Math.abs(asIncome - asExpense) < eps) return null;
  return asIncome < asExpense ? 'INCOME' : 'EXPENSE';
}

const sortKeyCompare = (a: RawRow, b: RawRow): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
  return 0;
};

/**
 * Файл шинэ→хуучин дараалалтай эсэх. Эхлээд зэргэлдээ мөрийн огнооны (цаг) өсөх/буурах тооны олонхи;
 * тэнцвэл (бүх мөр нэг өдөр) үлдэгдлийн өөрчлөлт нь дүнтэй таарах чиглэл (|b[i]-b[i-1]| = a[i]) аль дарааллыг дэмжих вэ.
 */
export function detectReversed(rows: RawRow[], eps: number): { reversed: boolean; basis: 'dates' | 'balance' | 'none' } {
  let asc = 0;
  let desc = 0;
  for (let i = 1; i < rows.length; i++) {
    const c = sortKeyCompare(rows[i - 1], rows[i]);
    if (c < 0) asc++;
    else if (c > 0) desc++;
  }
  if (asc !== desc) return { reversed: desc > asc, basis: 'dates' };
  let forward = 0;
  let backward = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.balance === null || b.balance === null) continue;
    const step = Math.abs(round2(b.balance - a.balance));
    if (Math.abs(step - b.amount) < eps) forward++;
    if (Math.abs(step - a.amount) < eps) backward++;
  }
  if (forward !== backward) return { reversed: backward > forward, basis: 'balance' };
  return { reversed: false, basis: 'none' };
}

/**
 * Тодорхой дохиотой мөрүүдийг (хронологи дарааллаар) үлдэгдлийн өөрчлөлттэй тулгана. Зөрүүтэй нь илүү олон бол
 * дебит/кредит системтэйгээр урвуу → swap=true. Дээж (directionVoteMinRows)-өөс цөөн бол шийдэхгүй.
 */
export function voteSwap(rows: RawRow[], opening: number | null, eps: number, minRows: number): { swap: boolean; agree: number; disagree: number } {
  let agree = 0;
  let disagree = 0;
  rows.forEach((row, i) => {
    if (!row.hint) return;
    const prev = i === 0 ? opening : rows[i - 1].balance;
    const implied = impliedDirection(prev, row.balance, row.amount, eps);
    if (!implied) return;
    if (implied === row.hint) agree++;
    else disagree++;
  });
  return { swap: agree + disagree >= minRows && disagree > agree, agree, disagree };
}

const flip = (d: TxnDirection): TxnDirection => (d === 'INCOME' ? 'EXPENSE' : 'INCOME');
export const flipHint = (row: RawRow): void => {
  if (row.hint) row.hint = flip(row.hint);
};
