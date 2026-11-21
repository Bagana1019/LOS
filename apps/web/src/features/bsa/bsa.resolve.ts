import type { BsaSuspicionView, TxnDirection } from '@los/contracts';

// Сэжигтэй дохио шийдвэрлэсний үр дүн (F6-10). Цэвэр функц — I/O байхгүй.

export type ResolveAction = 'APPROVE' | 'EXCLUDE' | 'RECLASSIFY';

export interface ResolveOutcome { resolved: number; skipped: number }
export interface ResolveImpact { changed: number; unchanged: number; unchangedDirection: TxnDirection | null }
export interface ResolveTarget { code: string; direction: TxnDirection }
type ImpactRow = Pick<BsaSuspicionView, 'flag' | 'status'> & { transactions: readonly { id: string; direction: TxnDirection; categoryCode: string | null }[] };

const asCount = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * `POST …/suspicions/resolve` нь `{ resolved, skipped, pending, … }` буцаана (scoring `ResolveResult`; контрактад zod схем байхгүй).
 * Хэлбэр таарахгүй бол сонгосон тоог «шийдвэрлэсэн» гэж үзнэ.
 */
export function readResolveOutcome(raw: unknown, selected: number): ResolveOutcome {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const resolved = asCount(body.resolved);
  if (resolved === null) return { resolved: selected, skipped: 0 };
  return { resolved, skipped: asCount(body.skipped) ?? 0 };
}

/**
 * Шийдвэрлэснээр хэдэн гүйлгээний ангилал солигдохыг, дэлгэц дээр байгаа мөрүүдээс тооцно (сервер тоог буцаадаггүй).
 * Серверийн дүрэм (`suspicion-review.service.ts#resolve`): зөвхөн хүлээгдэж буй дохио; өөрийн дансны (OWN_ACCOUNT) шилжүүлэг өөрчлөгдөхгүй;
 * EXCLUDE нь хоёр чиглэлийг; RECLASSIFY нь зөвхөн сонгосон ангиллын чиглэлтэй гүйлгээг солино.
 */
export function resolveImpact(action: ResolveAction, rows: readonly ImpactRow[], target: ResolveTarget | null): ResolveImpact | null {
  if (action === 'APPROVE') return null;
  if (action === 'RECLASSIFY' && target === null) return null;

  const byId = new Map(
    rows.filter((r) => r.status === 'PENDING' && r.flag !== 'OWN_ACCOUNT').flatMap((r) => r.transactions).map((t) => [t.id, t] as const),
  );
  const touched = [...byId.values()];
  if (action === 'EXCLUDE' || target === null) return { changed: touched.length, unchanged: 0, unchangedDirection: null };

  const sameDirection = touched.filter((t) => t.direction === target.direction);
  const unchanged = touched.length - sameDirection.length;
  return {
    changed: sameDirection.filter((t) => t.categoryCode !== target.code).length,
    unchanged,
    unchangedDirection: unchanged > 0 ? (target.direction === 'INCOME' ? 'EXPENSE' : 'INCOME') : null,
  };
}
