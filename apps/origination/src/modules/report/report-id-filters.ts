import { BadRequestException } from '@nestjs/common';
import type { ReportFilterDef } from '@los/contracts';
import type { PrismaService } from '../../prisma.service';

// F11-7: салбар / ЗЭЗ / бүтээгдэхүүний шүүлтийн утгыг шалгана. Буруу утга = `status`-тай ижил 400 INVALID_FILTER (өөр чимээгүй 0 мөр биш).
export type IdFilterKey = 'branchId' | 'officerId' | 'productId';
export type RequestedIds = Record<IdFilterKey, string | null>;
type Db = Pick<PrismaService, 'product' | 'loanApplication'>;

const ID_KEYS: readonly IdFilterKey[] = ['branchId', 'officerId', 'productId'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const invalidFilter = (label: string, value: string): BadRequestException => new BadRequestException({ code: 'INVALID_FILTER', message: `"${label}" шүүлтийн утга буруу: ${value}` });

/** Тайланд зарласан id шүүлтүүд (trim; хоосон = шүүлтгүй). Зарлаагүй шүүлтийг үл тооно. */
export function requestedIds(declared: ReadonlyMap<string, ReportFilterDef>, q: Partial<Record<IdFilterKey, string>>): RequestedIds {
  const pick = (key: IdFilterKey): string | null => (declared.has(key) ? q[key]?.trim() || null : null);
  return { branchId: pick('branchId'), officerId: pick('officerId'), productId: pick('productId') };
}

const found = async (hit: Promise<unknown>): Promise<boolean> => (await hit) !== null;

/**
 * Салбар/ЗЭЗ нь gateway `iam`-д (өөр schema) тул origination-д жагсаалт байхгүй; iam-ийн id бүр UUID. Иймд UUID хэлбэртэй id-г зөвшөөрнө
 * (шинэ, хараахан зээлгүй салбар зөв хоосон хариу өгнө); UUID биш бол origination-д аль хэдийн хэрэглэгдсэн (dev/хуучин өгөгдөл) id л зөвшөөрөгдөнө.
 * Бүтээгдэхүүн нь origination-ий каталог тул яг байгаа эсэхийг (өөрийн байгууллагад) шалгана.
 */
const IS_KNOWN: Record<IdFilterKey, (db: Db, orgId: string, id: string) => Promise<boolean>> = {
  branchId: async (db, orgId, id) => UUID.test(id) || found(db.loanApplication.findFirst({ where: { orgId, branchId: id }, select: { id: true } })),
  officerId: async (db, orgId, id) => UUID.test(id) || found(db.loanApplication.findFirst({ where: { orgId, officerId: id }, select: { id: true } })),
  productId: (db, orgId, id) => found(db.product.findFirst({ where: { id, orgId }, select: { id: true } })),
};

/** Танигдаагүй id байвал (тогтмол дарааллаар эхнийх нь) 400 INVALID_FILTER. Зөвхөн утга өгсөн шүүлтэд DB-ээс асууна. */
export async function assertKnownIds(db: Db, orgId: string, filters: readonly ReportFilterDef[], ids: RequestedIds): Promise<void> {
  const given = ID_KEYS.filter((k) => ids[k] !== null);
  const known = await Promise.all(given.map((k) => IS_KNOWN[k](db, orgId, ids[k] as string)));
  const bad = given.find((_, i) => !known[i]);
  if (bad) throw invalidFilter(filters.find((f) => f.key === bad)?.label ?? bad, ids[bad] as string);
}
