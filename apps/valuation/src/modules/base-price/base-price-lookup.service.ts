import { Inject, Injectable } from '@nestjs/common';
import { dbDate, toIsoDate } from '../../common/dates';
import type { CanonicalKey } from './base-price.keys';
import { BasePriceRepository } from './base-price.repository';

export interface BasePriceHit {
  id: string;
  unitPrice: number;
  /** YYYY-MM-DD */
  validFrom: string;
  version: number;
  /** Index into the candidate keys that matched (0 = most specific). */
  keyIndex: number;
  key: CanonicalKey;
}

/** What the collateral suggestion reads from the price list (FR-14.1): the newest version of a key whose `valid_from` has been reached. */
@Injectable()
export class BasePriceLookupService {
  constructor(@Inject(BasePriceRepository) private readonly repo: BasePriceRepository) {}

  /** Tries the candidate keys in order (most specific first) and returns the first that has a price valid on `asOf` (YYYY-MM-DD). */
  async find(orgId: string, assetType: string, keys: readonly CanonicalKey[], asOf: string): Promise<BasePriceHit | null> {
    for (const [keyIndex, key] of keys.entries()) {
      const row = await this.repo.findEffective(orgId, assetType, key, dbDate(asOf));
      if (row) return { id: row.id, unitPrice: Number(row.unitPrice), validFrom: toIsoDate(row.validFrom), version: row.version, keyIndex, key };
    }
    return null;
  }
}
