import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent, MerchantStatus } from '@los/contracts';
import { Prisma } from './client';
import { DomainError } from '../../domain/errors';
import type { MerchantRecord, StoreRecord } from '../../domain/records';
import { MerchantRepository, type Page, type PageArgs } from '../repositories';
import { merchantMutable, merchantToCreate, merchantToRecord, storeMutable, storeToCreate, storeToRecord } from './mappers';
import { writeOutbox } from './outbox';
import { clampPage, escapeLike, isUuid, uniqueViolation, violates } from './prisma-errors';
import { PrismaService } from './prisma.service';

// POS-FR-1/2: мерчант, дэлгүүр. Мерчантын event нь бизнес бичлэгтэй НЭГ транзакцид outbox-д орно (CLAUDE.md §3.2.4).
const byCode = <T extends { code: string }>(a: T, b: T) => a.code.localeCompare(b.code);

@Injectable()
export class PrismaMerchantRepository extends MerchantRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { super(); }

  async createMerchant(m: MerchantRecord, events: DomainEvent[]): Promise<MerchantRecord> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.merchant.create({ data: merchantToCreate(m) });
        await writeOutbox(tx, events);
        return created;
      });
      return merchantToRecord(row);
    } catch (e) {
      throw this.duplicateCode(e, 'Merchant', 'merchant', m.code);
    }
  }

  /**
   * Optimistic lock (version): зөвхөн хадгалагдсан version тэнцүү үед шинэчилж +1 болгоно. count 0 → мөр байвал CONCURRENT_UPDATE, үгүй бол NOT_FOUND;
   * outbox бичихээс ӨМНӨ шидэх тул tx бүхлээрээ буцаж, зөрчилдсөн хүсэлтийн event гарахгүй (POS-BR-10: статус ба event нийцнэ).
   */
  async saveMerchant(m: MerchantRecord, events: DomainEvent[]): Promise<MerchantRecord> {
    if (!isUuid(m.id)) throw new DomainError('NOT_FOUND', 'merchant not found');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const res = await tx.merchant.updateMany({ where: { id: m.id, orgId: m.orgId, version: m.version }, data: { ...merchantMutable(m), version: { increment: 1 } } });
        if (res.count === 0) {
          const exists = (await tx.merchant.count({ where: { id: m.id, orgId: m.orgId } })) > 0;
          throw exists ? new DomainError('CONCURRENT_UPDATE', 'merchant was modified concurrently') : new DomainError('NOT_FOUND', 'merchant not found');
        }
        await writeOutbox(tx, events);
        return tx.merchant.findUniqueOrThrow({ where: { id: m.id } });
      });
      return merchantToRecord(row);
    } catch (e) {
      throw this.duplicateCode(e, 'Merchant', 'merchant', m.code);
    }
  }

  async findMerchant(orgId: string, id: string): Promise<MerchantRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.merchant.findFirst({ where: { id, orgId } });
    return row ? merchantToRecord(row) : null;
  }

  async listMerchants(orgId: string, filter: { status?: MerchantStatus; q?: string; branchId?: string }, page: PageArgs): Promise<Page<MerchantRecord>> {
    const q = filter.q?.trim();
    const where: Prisma.MerchantWhereInput = {
      orgId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      // код, нэр, хуулийн нэр — том жижиг үсэг үл ялгана; `%`/`_` нь шууд тэмдэгт
      ...(q ? { OR: (['code', 'name', 'legalName'] as const).map((f) => ({ [f]: { contains: escapeLike(q), mode: 'insensitive' as const } })) } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.merchant.count({ where }),
      this.prisma.merchant.findMany({ where, orderBy: [{ createdAt: 'desc' }, { code: 'asc' }], ...clampPage(page) }),
    ]);
    return { items: rows.map(merchantToRecord), total };
  }

  async createStore(s: StoreRecord): Promise<StoreRecord> {
    try {
      return storeToRecord(await this.prisma.merchantStore.create({ data: storeToCreate(s) }));
    } catch (e) {
      throw this.duplicateCode(e, 'MerchantStore', 'store', s.code);
    }
  }

  /** Optimistic lock (version) — saveMerchant-тай ижил: тэнцүү үед л шинэчилж +1; зөрвөл CONCURRENT_UPDATE, байхгүй бол NOT_FOUND. */
  async saveStore(s: StoreRecord): Promise<StoreRecord> {
    if (!isUuid(s.id)) throw new DomainError('NOT_FOUND', 'store not found');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const res = await tx.merchantStore.updateMany({ where: { id: s.id, orgId: s.orgId, merchantId: s.merchantId, version: s.version }, data: { ...storeMutable(s), version: { increment: 1 } } });
        if (res.count === 0) {
          const exists = (await tx.merchantStore.count({ where: { id: s.id, orgId: s.orgId, merchantId: s.merchantId } })) > 0;
          throw exists ? new DomainError('CONCURRENT_UPDATE', 'store was modified concurrently') : new DomainError('NOT_FOUND', 'store not found');
        }
        return tx.merchantStore.findUniqueOrThrow({ where: { id: s.id } });
      });
      return storeToRecord(row);
    } catch (e) {
      throw this.duplicateCode(e, 'MerchantStore', 'store', s.code);
    }
  }

  async findStore(merchantId: string, storeId: string): Promise<StoreRecord | null> {
    if (!isUuid(merchantId) || !isUuid(storeId)) return null;
    const row = await this.prisma.merchantStore.findFirst({ where: { id: storeId, merchantId } });
    return row ? storeToRecord(row) : null;
  }

  async listStores(merchantId: string): Promise<StoreRecord[]> {
    if (!isUuid(merchantId)) return [];
    const rows = await this.prisma.merchantStore.findMany({ where: { merchantId } });
    return rows.map(storeToRecord).sort(byCode);
  }

  /** unique (org_id, code) / (merchant_id, code) зөрчил → DUPLICATE_CODE; бусад алдаа (outbox-ын давхар eventId гэх мэт) өөрчлөгдөхгүй. */
  private duplicateCode(e: unknown, model: string, label: string, code: string): unknown {
    return violates(uniqueViolation(e), model, 'code') ? new DomainError('DUPLICATE_CODE', `${label} code ${code} already exists`) : e;
  }
}
