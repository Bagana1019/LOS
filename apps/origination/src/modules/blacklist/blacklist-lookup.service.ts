import { Injectable } from '@nestjs/common';
import { hashRegisterNo } from '@los/database';
import type { BlacklistWarning } from '@los/contracts';
import { PrismaService } from '../../prisma.service';

/**
 * FR-13.1 (хайлт), BR-9: хар жагсаалт нь бүх шалтгаанд зөвхөн АНХААРУУЛГА — хориг биш, батлагч шийднэ.
 * Тулгалт регистрийн blind index-ээр (`blacklist.register_no_hash`): бичлэг (CRUD/импорт, `BlacklistService`), kyc-ийн AML, хайлт бүгд `hashRegisterNo` (@los/database)-ийг ашиглана.
 * Иргэний бүртгэлд (`customer.registerNoHash`) хадгалсан `blindIndex(normalizeRegisterNo(r))` (@los/contracts) нь хүчинтэй регистрт үүнтэй ижил хэш өгнө (register-no.test.ts-д шалгагдана).
 */
@Injectable()
export class BlacklistLookupService {
  constructor(private readonly db: PrismaService) {}

  /** Идэвхтэй бичлэг бүр = нэг анхааруулга (шинэ нь түрүүлж). */
  async warningsForRegisterNo(orgId: string, registerNo: string): Promise<BlacklistWarning[]> {
    return this.warningsForHash(orgId, hashRegisterNo(registerNo));
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
