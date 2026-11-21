import type { BsaResolveSuspicionsRequest, BsaResolveSuspicionsResponse, TxnDirection } from '@los/contracts';

// Сэжигтэй дохио шийдвэрлэсний үр дүн (F6-10). Цэвэр функц — I/O байхгүй.
// Гүйлгээний ангилал хэд солигдсоныг сервер өөрөө хэлнэ (`changedTransactions`, `unchangedTransactions`); дэлгэц дээрх мөрөөс дахин тооцохгүй.

export type ResolveAction = BsaResolveSuspicionsRequest['action'];

export interface ResolveImpact { changed: number; unchanged: number; unchangedDirection: TxnDirection | null }

const OPPOSITE: Readonly<Record<TxnDirection, TxnDirection>> = { INCOME: 'EXPENSE', EXPENSE: 'INCOME' };

/**
 * Серверийн тоог мессежид бэлтгэнэ. Чиглэл таарахгүй тул хэвээр үлдсэн гүйлгээ нь сонгосон ангиллын эсрэг чиглэлийнх (чиглэл хоёрхон) —
 * тиймээс сонгосон ангиллын чиглэл (`targetDirection`) л хэрэгтэй. APPROVE гүйлгээ өөрчилдөггүй тул мэдээлэх зүйлгүй (null).
 */
export function resolveImpact(
  action: ResolveAction,
  res: Pick<BsaResolveSuspicionsResponse, 'changedTransactions' | 'unchangedTransactions'>,
  targetDirection: TxnDirection | null,
): ResolveImpact | null {
  if (action === 'APPROVE') return null;
  const { changedTransactions: changed, unchangedTransactions: unchanged } = res;
  return { changed, unchanged, unchangedDirection: unchanged > 0 && targetDirection !== null ? OPPOSITE[targetDirection] : null };
}
