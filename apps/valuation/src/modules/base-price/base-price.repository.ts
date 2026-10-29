import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '.prisma/client-valuation';
import { PrismaService, type Tx } from '../../prisma.service';
import type { CanonicalKey } from './base-price.keys';

export type BasePriceRow = Prisma.BasePriceGetPayload<Record<string, never>>;
type Db = PrismaService | Tx;
const asJson = (key: CanonicalKey): Prisma.InputJsonValue => key;

@Injectable()
export class BasePriceRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T> {
    return this.db.$transaction(fn, options);
  }

  /** The newest version (highest `version`) of one key whose `valid_from` has been reached. */
  findEffective(orgId: string, assetType: string, key: CanonicalKey, validOn: Date): Promise<BasePriceRow | null> {
    return this.db.basePrice.findFirst({
      where: { orgId, assetType, keyJson: { equals: asJson(key) }, validFrom: { lte: validOn } },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
  }

  list(orgId: string, assetType: string | undefined, validOn: Date | undefined): Promise<BasePriceRow[]> {
    return this.db.basePrice.findMany({
      where: { orgId, ...(assetType ? { assetType } : {}), ...(validOn ? { validFrom: { lte: validOn } } : {}) },
      orderBy: [{ assetType: 'asc' }, { version: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async maxVersion(db: Db, orgId: string, assetType: string, key: CanonicalKey): Promise<number> {
    const r = await db.basePrice.aggregate({ _max: { version: true }, where: { orgId, assetType, keyJson: { equals: asJson(key) } } });
    return r._max.version ?? 0;
  }

  /** Highest version of every key of one asset type, as `key_json → version` rows. */
  maxVersionsByKey(db: Db, orgId: string, assetType: string): Promise<{ key_json: unknown; max_version: number }[]> {
    return db.$queryRaw<{ key_json: unknown; max_version: number }[]>(
      Prisma.sql`SELECT key_json, MAX(version)::int AS max_version FROM valuation.base_price WHERE org_id = ${orgId} AND asset_type = ${assetType} GROUP BY key_json`,
    );
  }

  create(db: Db, data: { orgId: string; assetType: string; key: CanonicalKey; unitPrice: number; validFrom: Date; version: number; createdBy: string | null }): Promise<BasePriceRow> {
    return db.basePrice.create({
      data: { orgId: data.orgId, assetType: data.assetType, keyJson: asJson(data.key), unitPrice: data.unitPrice, validFrom: data.validFrom, version: data.version, createdBy: data.createdBy, updatedBy: data.createdBy },
    });
  }

  async createMany(db: Db, rows: { orgId: string; assetType: string; key: CanonicalKey; unitPrice: number; validFrom: Date; version: number; createdBy: string | null }[]): Promise<number> {
    const CHUNK = 1000; // keeps every statement far below PostgreSQL's 32 767 bind-parameter limit
    let created = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await db.basePrice.createMany({
        data: rows.slice(i, i + CHUNK).map((d) => ({ orgId: d.orgId, assetType: d.assetType, keyJson: asJson(d.key), unitPrice: d.unitPrice, validFrom: d.validFrom, version: d.version, createdBy: d.createdBy, updatedBy: d.createdBy })),
      });
      created += r.count;
    }
    return created;
  }
}
