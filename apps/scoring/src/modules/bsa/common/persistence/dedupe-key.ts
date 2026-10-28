// BSA-FR-2.4: давхцсан хугацаатай хуулгын (жишээ нь 1–6 сар, 4–9 сар) ижил гүйлгээг нэг л удаа хадгалах түлхүүр.
// bsa_transaction (analysis_id, dedupe_key) unique + bulkInsert-ийн «байгаа бол алгасах» нь үүн дээр суурилна.
//  - Түлхүүр = hash(данс | огноо | цаг | чиглэл | дүн | үлдэгдэл | нормчилсон утга | давтамжийн дугаар). Утга шууд хадгалагдахгүй
//    (PiiCipher.hash — түлхүүртэй hash) тул PII задрахгүй.
//  - Нэг файл дотор бүх талбараараа ижил мөр (жишээ нь үлдэгдэлгүй хуулгад 2 ижил худалдан авалт) жинхэнэ ялгаатай гүйлгээ байж
//    болзошгүй тул тухайн файл дахь n дэх давтамж бүр өөр түлхүүр авна; давхцсан файлд мөн ижил дарааллаар олгогдож таарна.
//    Хязгаарлалт: давхцлын захад ижил мөрүүдийн нэг нь хоёр файлын аль нэгэнд л орсон бол тоо нь файлуудын ХАМГИЙН ИХ давтамжтай таарна.
import type { TxnDirection } from '@los/contracts';
import { normalizeAccount, roundMoney } from './bsa.validation';

export interface DedupeRow {
  txnDate: string;
  txnTime: string | null;
  direction: TxnDirection;
  amount: number;
  balanceAfter: number | null;
  description: string;
}

/** Нэг банкны данс файл болгонд ижил түлхүүртэй байх ёстой: hash(нормчилсон дансны дугаар) */
export function accountKeyOf(accountNo: string, hash: (plain: string) => string): string {
  return hash(normalizeAccount(accountNo));
}

const normDescription = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const fixed2 = (n: number | null): string => (n === null ? '' : roundMoney(n).toFixed(2));
/** 'HH:mm' ба 'HH:mm:ss' хоёр хэлбэрийг нэг болгоно (банк бүр өөр нарийвчлалтай) */
const fixedTime = (t: string | null): string => (t === null ? '' : t.length === 5 ? `${t}:00` : t);

/** Файлын мөрүүдтэй зэрэгцсэн dedupe түлхүүрүүд (файлын дарааллаар). `hash` = PiiCipher.hash */
export function buildDedupeKeys(accountKey: string, rows: readonly DedupeRow[], hash: (plain: string) => string): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = [accountKey, r.txnDate, fixedTime(r.txnTime), r.direction, fixed2(r.amount), fixed2(r.balanceAfter), normDescription(r.description)].join('|');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return hash(`${base}|${n}`);
  });
}
