import { Injectable } from '@nestjs/common';
import type { Customer } from '.prisma/client-origination';
import type { Tx } from '../../prisma.service';
import type { BlacklistHit } from './borrower.rules';

/**
 * BR-9: хар жагсаалт нь бүх шалтгаанд зөвхөн анхааруулга (хориг биш).
 * Тулгалт нь регистрийн blind index (`register_no_hash`, HMAC) дээр — `blindIndex` нь том/жижиг үсэг, хоосон зайг үл тооно
 * (`@los/database`), тул `Blacklist` болон `Customer`-ийн хэш шууд тэнцэнэ. Зөвхөн өөрийн байгууллагын идэвхтэй бичлэг.
 */
@Injectable()
export class BlacklistChecker {
  async findHits(db: Tx, orgId: string, customers: Array<Pick<Customer, 'id' | 'registerNoHash'>>): Promise<BlacklistHit[]> {
    if (!customers.length) return [];
    const byHash = new Map<string, string[]>();
    // Нэг харилцагч хэд хэдэн дүртэй байж болно — харилцагч тутамд нэг л удаа тулгана.
    for (const c of new Map(customers.map((x) => [x.id, x])).values()) byHash.set(c.registerNoHash, [...(byHash.get(c.registerNoHash) ?? []), c.id]);
    const rows = await db.blacklist.findMany({
      where: { orgId, isActive: true, registerNoHash: { in: [...byHash.keys()] } },
      orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }],
      select: { registerNoHash: true, reasonCode: true, listType: true },
    });
    const hits: BlacklistHit[] = [];
    for (const row of rows) {
      for (const customerId of byHash.get(row.registerNoHash) ?? []) hits.push({ customerId, reasonCode: row.reasonCode, listType: row.listType });
    }
    return hits;
  }
}
