import type { PrismaClient } from '.prisma/client-origination';
import { DEFAULT_PRICING_TIERS } from '../../src/modules/loan-terms/pricing/pricing.defaults';
import { replaceActiveSet } from '../../src/modules/loan-terms/pricing/pricing-tier.store';

/** FR-5.5: байгууллагын нийтлэг шатлал байхгүй бол DEMO анхдагчийг үүсгэнэ. Create-only — давтан, зэрэг ажиллуулахад админы шатлалыг дарахгүй, шинэ version үүсгэхгүй. */
export async function seedPricingTiers(db: PrismaClient, orgId: string): Promise<boolean> {
  return (await db.$transaction((tx) => replaceActiveSet(tx, { orgId, productId: null, tiers: DEFAULT_PRICING_TIERS, actorId: null, onlyIfAbsent: true }))) !== null;
}
