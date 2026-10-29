import { Injectable } from '@nestjs/common';
import { blindIndex } from '@los/database';
import { normalizeRegisterNo, type BlacklistWarning } from '@los/contracts';
import { PrismaService } from '../../prisma.service';

/**
 * FR-13.1 (хайлт), BR-9: хар жагсаалт нь бүх шалтгаанд зөвхөн АНХААРУУЛГА — хориг биш, батлагч шийднэ.
 * Тулгалт регистрийн blind index-ээр (`blacklist.register_no_hash`): бичлэгийг үүсгэгч (M13 CRUD/импорт, AML) `blindIndex(normalizeRegisterNo(r))`-ээр хэшлэх ёстой.
 * CRUD/импорт Модуль 13-д энэ модульд нэмэгдэнэ.
 */
@Injectable()
export class BlacklistLookupService {
  constructor(private readonly db: PrismaService) {}

  /** Идэвхтэй бичлэг бүр = нэг анхааруулга (шинэ нь түрүүлж). */
  async warningsForRegisterNo(orgId: string, registerNo: string): Promise<BlacklistWarning[]> {
    return this.warningsForHash(orgId, blindIndex(normalizeRegisterNo(registerNo)));
  }

  async warningsForHash(orgId: string, registerNoHash: string): Promise<BlacklistWarning[]> {
    const rows = await this.db.blacklist.findMany({ where: { orgId, registerNoHash, isActive: true }, orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }] });
    return rows.map((r) => ({
      code: 'BLACKLISTED' as const, severity: 'WARNING' as const,
      listType: r.listType, reasonCode: r.reasonCode, reasonText: r.reasonText, registeredAt: r.registeredAt.toISOString(),
    }));
  }

  /** Жагсаалтын хуудас: аль хэш хар жагсаалтад байгааг нэг query-ээр. */
  async blacklistedHashes(orgId: string, hashes: string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    const rows = await this.db.blacklist.findMany({ where: { orgId, isActive: true, registerNoHash: { in: hashes } }, select: { registerNoHash: true } });
    return new Set(rows.map((r) => r.registerNoHash));
  }
}
