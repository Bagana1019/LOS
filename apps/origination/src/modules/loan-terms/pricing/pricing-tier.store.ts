import type { PricingTier as PricingTierRow } from '.prisma/client-origination';
import type { PricingTierInput, PricingTierSet, RiskBand } from '@los/contracts';
import type { Tx } from '../../../prisma.service';

// FR-5.5: pricing_tier хүснэгтийн хувилбартай унших/бичих. Сервис болон seed хоёр хуваалцана (зөвхөн Prisma — Nest-ээс хамааралгүй).

export type TierReader = Pick<Tx, 'pricingTier'>;

export const activeRows = (db: TierReader, orgId: string, productId: string | null) =>
  db.pricingTier.findMany({ where: { orgId, productId, isActive: true }, orderBy: { minScore: 'asc' } });

export function toTierSet(rows: PricingTierRow[], productId: string | null): PricingTierSet {
  const latest = rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  return {
    scope: productId ? 'PRODUCT' : 'DEFAULT', productId, version: rows[0]!.version,
    tiers: rows.map((r) => ({
      code: r.code, name: r.name, band: r.band as RiskBand, minScore: r.minScore,
      interestRate: r.interestRate.toNumber(), feeRate: r.feeRate.toNumber(), isDefault: r.isDefault,
    })),
    updatedAt: latest.updatedAt.toISOString(), updatedBy: latest.updatedBy ?? latest.createdBy,
  };
}

export interface ReplaceResult { previous: PricingTierSet | null; saved: PricingTierSet }

/**
 * Хүрээ (org × product)-ийн идэвхтэй багцыг шинэ version-оор солино: өмнөхийг is_active=false болгож, мөр устгахгүй (түүх).
 * Хүрээ тус бүрээр advisory lock авдаг тул зэрэг хадгалахад хоёр идэвхтэй багц үүсэхгүй. Шалгалт түгжээний ДОТОР тул
 * `onlyIfAbsent` (seed) ч зэрэг ажиллахад идемпотент — идэвхтэй багц байвал юу ч бичихгүй, null буцаана.
 */
export async function replaceActiveSet(
  tx: Tx,
  input: { orgId: string; productId: string | null; tiers: readonly PricingTierInput[]; actorId: string | null; onlyIfAbsent?: boolean },
): Promise<ReplaceResult | null> {
  const { orgId, productId, tiers, actorId, onlyIfAbsent } = input;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pricing_tier:${orgId}:${productId ?? ''}`}))`;
  const before = await activeRows(tx, orgId, productId);
  if (onlyIfAbsent && before.length) return null;
  const { _max } = await tx.pricingTier.aggregate({ where: { orgId, productId }, _max: { version: true } });
  const version = (_max.version ?? 0) + 1;
  if (before.length) await tx.pricingTier.updateMany({ where: { orgId, productId, isActive: true }, data: { isActive: false, updatedBy: actorId } });
  await tx.pricingTier.createMany({ data: tiers.map((t) => ({ orgId, productId, version, ...t, isActive: true, createdBy: actorId, updatedBy: actorId })) });
  const rows = await tx.pricingTier.findMany({ where: { orgId, productId, version }, orderBy: { minScore: 'asc' } });
  return { previous: before.length ? toTierSet(before, productId) : null, saved: toTierSet(rows, productId) };
}
