// Жагсаалтын хайлт/эрэмбийн ЦОРЫН ГАНЦ тодорхойлолт (in-memory хэрэгжүүлэлт ба Prisma-ийн програмын шүүлт хоёр хуваалцана).
// Prisma талд SQL-ийн orderBy нь доорх comparator-той ижил эрэмбэ өгөх ёстой (repository.contract.ts шалгана).
import type { BsaTransactionRecord, BsaTransactionSort } from './bsa.repository';
import { compareStrings } from './bsa.validation';

/** Шифрлэгдсэн талбарт хайх тул програмд: утга, харьцсан нэр, харьцсан данс. Том-жижиг үсэг үл ялгана (кирилл ч), зай нормчилно */
export function textNeedle(text: string | undefined): string | null {
  const n = text?.normalize('NFKC').trim().toLowerCase();
  return n ? n : null;
}
export function matchesText(t: Pick<BsaTransactionRecord, 'description' | 'counterpartyName' | 'counterpartyAccount'>, needle: string): boolean {
  return [t.description, t.counterpartyName, t.counterpartyAccount].some((f) => f !== null && f.normalize('NFKC').toLowerCase().includes(needle));
}

/** DATE: txnDate, txnTime (хоосон нь түрүүлж), seq, id. DESC нь яг урвуу. AMOUNT: дүн, дараа нь DATE_ASC */
export function txnComparator(sort: BsaTransactionSort = 'DATE_ASC'): (a: BsaTransactionRecord, b: BsaTransactionRecord) => number {
  const byDate = (a: BsaTransactionRecord, b: BsaTransactionRecord): number =>
    compareStrings(a.txnDate, b.txnDate) ||
    (a.txnTime === b.txnTime ? 0 : a.txnTime === null ? -1 : b.txnTime === null ? 1 : compareStrings(a.txnTime, b.txnTime)) ||
    a.seq - b.seq ||
    compareStrings(a.id, b.id);
  switch (sort) {
    case 'DATE_DESC':
      return (a, b) => byDate(b, a);
    case 'AMOUNT_ASC':
      return (a, b) => a.amount - b.amount || byDate(a, b);
    case 'AMOUNT_DESC':
      return (a, b) => b.amount - a.amount || byDate(a, b);
    default:
      return byDate;
  }
}
