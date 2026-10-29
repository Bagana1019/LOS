import { Inject, Injectable } from '@nestjs/common';
import { HaircutRepository } from './haircut.repository';

/** What the collateral suggestion reads (FR-14.2): the active product rule and the active org-wide rule. */
@Injectable()
export class HaircutLookupService {
  constructor(@Inject(HaircutRepository) private readonly repo: HaircutRepository) {}

  async findRates(orgId: string, productId: string | null, assetType: string): Promise<{ productRule: number | null; orgRule: number | null }> {
    const rows = await this.repo.findActive(orgId, productId, assetType);
    const rateOf = (pid: string | null): number | null => {
      const row = rows.find((r) => r.productId === pid);
      return row ? Number(row.haircutRate) : null;
    };
    return { productRule: productId === null ? null : rateOf(productId), orgRule: rateOf(null) };
  }
}
