// scoring.sosco_result-ийн унших хэсэг. underwriting (ScoringCompleted.soscoScore) болон sosco controller хоёр хуваалцана.
import type { SoscoModel, SoscoResult } from '.prisma/client-scoring';
import type { Tx } from '../../prisma.service';

type ResultReader = Pick<Tx, 'soscoResult'>;

/** Сүүлийн = computed_at хамгийн шинэ; ижил бол id (тогтвортой). Хүрээ: байгууллага × хүсэлт × зээлдэгч */
export const LATEST_ORDER = [{ computedAt: 'desc' }, { id: 'desc' }] as const;

export function latestResult(db: ResultReader, orgId: string, applicationId: string, customerId: string): Promise<(SoscoResult & { model: Pick<SoscoModel, 'version'> }) | null> {
  return db.soscoResult.findFirst({ where: { orgId, applicationId, customerId }, orderBy: [...LATEST_ORDER], include: { model: { select: { version: true } } } });
}

/** `ScoringCompleted.soscoScore`: үндсэн зээлдэгчийн сүүлийн оноо, байхгүй (эсвэл зээлдэгч тодорхойгүй) бол null */
export async function latestSoscoScore(db: ResultReader, orgId: string, applicationId: string, customerId: string | null): Promise<number | null> {
  if (!customerId) return null;
  const row = await db.soscoResult.findFirst({ where: { orgId, applicationId, customerId }, orderBy: [...LATEST_ORDER], select: { score: true } });
  return row?.score ?? null;
}
