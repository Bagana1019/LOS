/** LIKE-ийн орлуулагч (`%`, `_`) болон escape тэмдэгт (`\`)-ийг шууд тэмдэгт болгоно: Prisma `contains` нь escape хийдэггүй. */
const escapeLike = (v: string): string => v.replace(/[\\%_]/g, '\\$&');

/** Prisma `StringFilter`-тэй нийцтэй (`@prisma/client` хамааралгүй): хэсэгчилсэн (contains), том/жижиг үсэг үл ялгах (ILIKE). */
export interface ContainsInsensitive {
  contains: string;
  mode: 'insensitive';
}

/**
 * F9-24 · Хэрэглэгчийн бичсэн текстээр хэсэгчилсэн, том/жижиг үсэг үл ялгах шүүлт (`where: { entity: containsInsensitive(q) }`).
 * Дуудагч хоосон текстийг өөрөө алгасна (`q ? { ... } : {}`).
 */
export function containsInsensitive(value: string): ContainsInsensitive {
  return { contains: escapeLike(value), mode: 'insensitive' };
}
