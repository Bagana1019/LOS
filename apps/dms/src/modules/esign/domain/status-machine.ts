// FR-11.4 Гарын үсгийн хүсэлтийн төлвийн машин — цэвэр функц. Зөвшөөрөгдсөн шилжилт нь ESIGN_DESIGN.md-тэй яг ижил.
// Бодит шилжилтийг SigningStore.transition (compare-and-set) хийнэ; энэ хүснэгт нь service-ийн програмчлалын алдааг барих хамгаалалт.
import type { SigningStatus } from '@los/contracts';

const EDGES: Readonly<Record<SigningStatus, readonly SigningStatus[]>> = {
  PENDING: ['IN_PROGRESS', 'EXPIRED', 'CANCELLED'],
  // PENDING рүү буцах: provider session дууссан/алдаатай ч линк хүчинтэй, оролдлого үлдсэн (зээлдэгч дахин оролдоно)
  IN_PROGRESS: ['FINALIZING', 'PENDING', 'DECLINED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  // IN_PROGRESS рүү буцах: штамп/хадгалалтын түр алдаа — дараагийн poll/webhook/sweeper дахин оролдоно
  FINALIZING: ['SIGNED', 'FAILED', 'IN_PROGRESS'],
  SIGNED: [],
  DECLINED: [],
  EXPIRED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Нэг гэрээнд ганцхан байх боломжтой (идэвхтэй) төлвүүд — DB-ийн partial unique index-тэй ижил */
export const ACTIVE_STATUSES: readonly SigningStatus[] = ['PENDING', 'IN_PROGRESS', 'FINALIZING'];

export function canTransition(from: SigningStatus, to: SigningStatus): boolean {
  return EDGES[from].includes(to);
}

/** Төгсгөлийн төлөв: цаашид юу ч руу шилжихгүй. Дахин илгээх = ШИНЭ хүсэлт (түүх хадгалагдана) */
export function isTerminal(status: SigningStatus): boolean {
  return EDGES[status].length === 0;
}

export function isActive(status: SigningStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}
