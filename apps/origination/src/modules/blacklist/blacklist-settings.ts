import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_GREY_VALID_MONTHS, SETTING_REGISTRY } from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import type { BlacklistSettings } from './blacklist.tokens';

/** `origination.setting` дахь `blacklist.grey_valid_months` (эзэмшигч нь origination — CLAUDE.md §3.2.8). Алдаатай/хоосон бол анхдагч 12. */
@Injectable()
export class PrismaBlacklistSettings implements BlacklistSettings {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async greyValidMonths(orgId: string): Promise<number> {
    const row = await this.db.setting.findUnique({ where: { orgId_key: { orgId, key: 'blacklist.grey_valid_months' } } });
    const parsed = SETTING_REGISTRY['blacklist.grey_valid_months'].schema.safeParse(row?.valueJson);
    return parsed.success ? parsed.data : DEFAULT_GREY_VALID_MONTHS;
  }
}
