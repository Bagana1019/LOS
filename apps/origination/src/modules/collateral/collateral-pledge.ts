import type { Tx } from '../../prisma.service';
import { COMMITTED_STATUSES, DRAFT_STATUSES } from './collateral.constants';

// FR-6.6 давхар барьцаа: нэг хөрөнгө (`asset_key`) эсвэл ЭБ-ийн бүртгэлийн дугаар (`registry_no`) өөр хүсэлтэд барьцаалагдсан эсэх.
// Хатуу зөрчил — өөр хүсэлт "хүлээн авсан" төлөвт (COMMITTED_STATUSES) ба барьцаа чөлөөлөгдөөгүй; зөөлөн — өөр ноорог/буцаасан (DRAFT_STATUSES).

export interface PledgeKeys {
  assetKeys: readonly string[];
  registryNos: readonly string[];
}

export interface OtherPledge {
  collateralId: string;
  applicationId: string;
  appNo: string;
  status: string;
  assetKey: string | null;
  registryNo: string | null;
}

/** `excludeApplicationId`-ээс бусад хүсэлтийн, чөлөөлөгдөөгүй, `statuses` төлөвтэй барьцаанаас түлхүүр таарсныг буцаана. */
export async function findOtherPledges(db: Tx, orgId: string, excludeApplicationId: string, keys: PledgeKeys, statuses: readonly string[]): Promise<OtherPledge[]> {
  const or = [
    ...(keys.assetKeys.length ? [{ assetKey: { in: [...keys.assetKeys] } }] : []),
    ...(keys.registryNos.length ? [{ registryNo: { in: [...keys.registryNos] } }] : []),
  ];
  if (!or.length) return [];
  const rows = await db.collateral.findMany({
    where: { orgId, applicationId: { not: excludeApplicationId }, releasedAt: null, OR: or, application: { status: { in: [...statuses] } } },
    select: { id: true, applicationId: true, assetKey: true, registryNo: true, application: { select: { appNo: true, status: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({ collateralId: r.id, applicationId: r.applicationId, appNo: r.application.appNo, status: r.application.status, assetKey: r.assetKey, registryNo: r.registryNo }));
}

export const findCommittedPledges = (db: Tx, orgId: string, excludeApplicationId: string, keys: PledgeKeys): Promise<OtherPledge[]> =>
  findOtherPledges(db, orgId, excludeApplicationId, keys, COMMITTED_STATUSES);

/** Нэг барьцаа (assetKey, registryNo) өөр тухайн pledge-тэй таарч байна уу. */
export const matches = (p: OtherPledge, c: { assetKey: string | null; registryNo: string | null }): boolean =>
  (c.assetKey != null && p.assetKey === c.assetKey) || (c.registryNo != null && p.registryNo === c.registryNo);

/** collateralId → таарсан өөр хүсэлтүүдийн дугаар (давхардалгүй). */
export function groupByCollateral(others: readonly OtherPledge[], own: ReadonlyArray<{ id: string; assetKey: string | null; registryNo: string | null }>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of own) {
    const nos = [...new Set(others.filter((p) => matches(p, c)).map((p) => p.appNo))];
    if (nos.length) out[c.id] = nos;
  }
  return out;
}

export const isCommitted = (status: string): boolean => (COMMITTED_STATUSES as readonly string[]).includes(status);
export const isDraftLike = (status: string): boolean => (DRAFT_STATUSES as readonly string[]).includes(status);

/**
 * Өөр хүсэлтүүдийн хооронд хөрөнгийн түлхүүрийг сериалчилна (pg_advisory_xact_lock; транзакц дуусахад суллагдана).
 * Хүсэлтийн мөрийн FOR UPDATE түгжээг АВСАНЫ ДАРАА л дуудна; түлхүүрийг эрэмбэлж түгжинэ (deadlock-оос сэргийлнэ).
 * Модуль 10 (илгээх, G1) мөн хөрөнгийн дугаар давхцахыг шалгахдаа ЭНЭ функцээр түгжинэ.
 */
export async function lockAssetKeys(tx: Tx, orgId: string, keys: ReadonlyArray<string | null | undefined>): Promise<void> {
  const unique = [...new Set(keys.filter((k): k is string => !!k))].sort();
  for (const key of unique) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${key}))`;
}

/** `lockAssetKeys`-д дамжуулах түлхүүрүүд: хөрөнгийн түлхүүр ба ЭБ-ийн дугаар (нэр зай тусдаа). */
export const assetLockKey = (assetKey: string | null | undefined): string | null => (assetKey ? `asset:${assetKey}` : null);
export const registryLockKey = (registryNo: string | null | undefined): string | null => (registryNo ? `registry:${registryNo}` : null);
