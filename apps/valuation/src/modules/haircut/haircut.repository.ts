import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/client-valuation';
import { PrismaService, type Tx } from '../../prisma.service';

export type HaircutRow = Prisma.HaircutRuleGetPayload<Record<string, never>>;

@Injectable()
export class HaircutRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn);
  }

  /** `productId`: undefined → any, null → org-wide rules only, string → that product. */
  list(orgId: string, filter: { productId?: string | null; assetType?: string; includeInactive: boolean }): Promise<HaircutRow[]> {
    return this.db.haircutRule.findMany({
      where: {
        orgId,
        ...(filter.productId !== undefined ? { productId: filter.productId } : {}),
        ...(filter.assetType ? { assetType: filter.assetType } : {}),
        ...(filter.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ assetType: 'asc' }, { productId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    });
  }

  /** Active rules the resolution can use for one product and asset type: the product's own rule and the org-wide one. */
  findActive(orgId: string, productId: string | null, assetType: string): Promise<HaircutRow[]> {
    return this.db.haircutRule.findMany({
      where: { orgId, assetType, isActive: true, OR: productId === null ? [{ productId: null }] : [{ productId }, { productId: null }] },
    });
  }

  /** `productId = null` cannot use the compound unique key (NULLs are distinct in PostgreSQL), hence findFirst. */
  findOne(db: Tx, orgId: string, productId: string | null, assetType: string): Promise<HaircutRow | null> {
    return db.haircutRule.findFirst({ where: { orgId, productId, assetType }, orderBy: { createdAt: 'asc' } });
  }

  findById(db: Tx | PrismaService, orgId: string, id: string): Promise<HaircutRow | null> {
    return db.haircutRule.findFirst({ where: { id, orgId } });
  }

  create(db: Tx, data: { orgId: string; productId: string | null; assetType: string; haircutRate: number; actorId: string | null }): Promise<HaircutRow> {
    return db.haircutRule.create({
      data: { orgId: data.orgId, productId: data.productId, assetType: data.assetType, haircutRate: data.haircutRate, createdBy: data.actorId, updatedBy: data.actorId },
    });
  }

  update(db: Tx, id: string, data: { haircutRate?: number; isActive: boolean; actorId: string | null }): Promise<HaircutRow> {
    return db.haircutRule.update({ where: { id }, data: { ...(data.haircutRate !== undefined ? { haircutRate: data.haircutRate } : {}), isActive: data.isActive, updatedBy: data.actorId } });
  }
}
