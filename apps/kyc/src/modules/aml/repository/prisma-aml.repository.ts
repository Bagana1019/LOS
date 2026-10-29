// AmlRepository-ийн Prisma хэрэгжүүлэлт (schema `kyc`). In-memory хувилбартай ижил төрхтэйг aml-repository.contract.ts шалгана.
// Event-ийг enqueueOutbox(@los/database)-ээр схемээр шалгаж, бизнес мөртэй нэг транзакцид outbox руу бичнэ (CLAUDE.md §3.2.4).
import { Inject, Injectable } from '@nestjs/common';
import type { AmlHit, AmlRiskFactor, DomainEvent } from '@los/contracts';
import { enqueueOutbox } from '@los/database';
import type { Prisma, PrismaClient } from '.prisma/client-kyc';
import { AML_PRISMA } from '../aml.prisma';
import {
  ScreeningRaceError, type AmlRepository, type ApplyHitReviewResult, type BlacklistProjection, type HitReviewCommand, type ProjectionResult,
  type SaveScreeningOptions, type StoredScreening,
} from '../aml.ports';

const PROJECTION_CONSUMER = 'blacklist-projection';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hit-үүдийг engine-ийн дарааллаар (position) нь унших. */
const WITH_HITS = { hits: { orderBy: { position: 'asc' } } } satisfies Prisma.AmlCheckInclude;
type ScreeningRow = Prisma.AmlCheckGetPayload<{ include: typeof WITH_HITS }>;
type HitRow = Prisma.AmlHitGetPayload<object>;
type HitFilter = Parameters<AmlRepository['listHits']>[1];
type HitRef = { screening: StoredScreening; hit: AmlHit };
type Tx = Prisma.TransactionClient;

const json = (value: unknown) => value as Prisma.InputJsonValue;

function hitOf(row: HitRow): AmlHit {
  return {
    id: row.id,
    list: row.list as AmlHit['list'],
    matchType: row.matchType as AmlHit['matchType'],
    score: row.score.toNumber(),
    severity: row.severity as AmlHit['severity'],
    status: row.status as AmlHit['status'],
    entryRef: row.entryRef,
    entryName: row.entryName,
    matchedValue: row.matchedValue,
    details: row.detailsJson as AmlHit['details'],
    listVersion: row.listVersion,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewComment: row.reviewComment,
  };
}

function screeningOf(row: ScreeningRow): StoredScreening {
  return {
    id: row.id,
    orgId: row.orgId,
    customerId: row.customerId,
    applicationId: row.applicationId,
    trigger: row.trigger as StoredScreening['trigger'],
    status: row.status as StoredScreening['status'],
    blocking: row.blocking,
    riskScore: row.riskScore.toNumber(),
    riskLevel: row.riskLevel as StoredScreening['riskLevel'],
    riskFactors: row.riskFactorsJson as unknown as AmlRiskFactor[],
    subjectName: row.subjectName,
    registerNoMasked: row.registerNoMasked,
    registerNoHash: row.registerNoHash,
    registerNoEncrypted: row.registerNoEncrypted,
    subject: row.subjectJson as unknown as StoredScreening['subject'],
    listVersions: row.listVersionsJson as Record<string, string>,
    screenedAt: row.screenedAt,
    screenedBy: row.screenedBy,
    correlationId: row.correlationId,
    hits: row.hits.map(hitOf),
  };
}

function hitCreate(hit: AmlHit, position: number): Prisma.AmlHitCreateWithoutScreeningInput {
  return {
    id: hit.id,
    position,
    list: hit.list,
    matchType: hit.matchType,
    score: hit.score,
    severity: hit.severity,
    status: hit.status,
    entryRef: hit.entryRef,
    entryName: hit.entryName,
    matchedValue: hit.matchedValue,
    detailsJson: json(hit.details),
    listVersion: hit.listVersion,
    reviewedBy: hit.reviewedBy,
    reviewedAt: hit.reviewedAt ? new Date(hit.reviewedAt) : null,
    reviewComment: hit.reviewComment,
  };
}

/**
 * (org, customer) тутамд транзакцуудыг цувуулна: транзакц дуустал (commit / rollback) барих advisory түгжээ. Түгжээний дараалал хаа сайгүй
 * ИЖИЛ — "харилцагчийн түгжээ → screening мөрийн FOR UPDATE" (saveScreening, applyHitReview). Түгжээ авсны дараах statement бүр (READ COMMITTED)
 * өмнөх түгжээ эзэмшигчийн commit-лэсэн өөрчлөлтийг харна.
 */
async function lockCustomer(tx: Tx, orgId: string, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}::text || ':' || ${customerId}::text, 0))`;
}

/** Харилцагчийн ОДООГИЙН сүүлийн screening-ийн id (findLatestForCustomer-тэй ижил эрэмбэ: screened_at, id буурахаар). */
async function latestScreeningId(tx: Tx, orgId: string, customerId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM kyc.aml_check WHERE org_id = ${orgId} AND customer_id = ${customerId}
    ORDER BY screened_at DESC, id DESC LIMIT 1`;
  return rows[0]?.id ?? null;
}

@Injectable()
export class PrismaAmlRepository implements AmlRepository {
  constructor(@Inject(AML_PRISMA) private readonly db: PrismaClient) {}

  async saveScreening(s: StoredScreening, event: DomainEvent, options: SaveScreeningOptions = {}): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await lockCustomer(tx, s.orgId, s.customerId);
      // Түгжээ авсны дараа уншина: өмнөх хадгалагч commit хийсэн бол түүнийг харна → "унших → бодох → бичих" хооронд орсон шалгалт дарагдахгүй.
      if (options.expectedPreviousId !== undefined && (await latestScreeningId(tx, s.orgId, s.customerId)) !== options.expectedPreviousId) {
        throw new ScreeningRaceError();
      }
      await tx.amlCheck.create({
        data: {
          id: s.id,
          orgId: s.orgId,
          customerId: s.customerId,
          applicationId: s.applicationId,
          trigger: s.trigger,
          status: s.status,
          blocking: s.blocking,
          riskScore: s.riskScore,
          riskLevel: s.riskLevel,
          riskFactorsJson: json(s.riskFactors),
          subjectName: s.subjectName,
          registerNoMasked: s.registerNoMasked,
          registerNoHash: s.registerNoHash,
          registerNoEncrypted: s.registerNoEncrypted,
          subjectJson: json(s.subject),
          listVersionsJson: json(s.listVersions),
          screenedAt: s.screenedAt,
          screenedBy: s.screenedBy,
          correlationId: s.correlationId,
          hits: { create: s.hits.map(hitCreate) },
        },
      });
      await enqueueOutbox(tx, event);
    });
  }

  async findScreening(orgId: string, id: string): Promise<StoredScreening | null> {
    if (!UUID.test(id)) return null;
    const row = await this.db.amlCheck.findFirst({ where: { id, orgId }, include: WITH_HITS });
    return row && screeningOf(row);
  }

  async findLatestForCustomer(orgId: string, customerId: string): Promise<StoredScreening | null> {
    const row = await this.db.amlCheck.findFirst({
      where: { orgId, customerId },
      orderBy: [{ screenedAt: 'desc' }, { id: 'desc' }],
      include: WITH_HITS,
    });
    return row && screeningOf(row);
  }

  async findHit(orgId: string, hitId: string): Promise<HitRef | null> {
    if (!UUID.test(hitId)) return null;
    const row = await this.db.amlHit.findFirst({ where: { id: hitId, screening: { orgId } }, include: { screening: { include: WITH_HITS } } });
    return row && { screening: screeningOf(row.screening), hit: hitOf(row) };
  }

  async listHits(orgId: string, filter: HitFilter): Promise<{ total: number; items: HitRef[] }> {
    // Зөвхөн харилцагч тутмын ОДООГИЙН сүүлийн screening-ийн hit (correlated sub-select; индекс: org_id, customer_id, screened_at DESC).
    const status = filter.status ?? null;
    const list = filter.list ?? null;
    const [counted, ids] = await Promise.all([
      this.db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM kyc.aml_hit h JOIN kyc.aml_check s ON s.id = h.screening_id
        WHERE s.org_id = ${orgId}
          AND (${status}::text IS NULL OR h.status = ${status}::text)
          AND (${list}::text IS NULL OR h.list = ${list}::text)
          AND s.id = (SELECT l.id FROM kyc.aml_check l WHERE l.org_id = s.org_id AND l.customer_id = s.customer_id ORDER BY l.screened_at DESC, l.id DESC LIMIT 1)`,
      this.db.$queryRaw<{ id: string }[]>`
        SELECT h.id::text AS id
        FROM kyc.aml_hit h JOIN kyc.aml_check s ON s.id = h.screening_id
        WHERE s.org_id = ${orgId}
          AND (${status}::text IS NULL OR h.status = ${status}::text)
          AND (${list}::text IS NULL OR h.list = ${list}::text)
          AND s.id = (SELECT l.id FROM kyc.aml_check l WHERE l.org_id = s.org_id AND l.customer_id = s.customer_id ORDER BY l.screened_at DESC, l.id DESC LIMIT 1)
        ORDER BY s.screened_at DESC, h.id ASC
        LIMIT ${filter.limit} OFFSET ${filter.offset}`,
    ]);
    const rows = await this.db.amlHit.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: { screening: { include: WITH_HITS } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      total: counted[0]?.n ?? 0,
      items: ids.flatMap(({ id }) => {
        const row = byId.get(id);
        return row ? [{ screening: screeningOf(row.screening), hit: hitOf(row) }] : [];
      }),
    };
  }

  async applyHitReview(cmd: HitReviewCommand): Promise<ApplyHitReviewResult> {
    if (!UUID.test(cmd.hitId)) return { outcome: 'not_found' };
    return this.db.$transaction(async (tx): Promise<ApplyHitReviewResult> => {
      const hit = await tx.amlHit.findFirst({
        where: { id: cmd.hitId, screening: { orgId: cmd.orgId } },
        select: { screeningId: true, screening: { select: { customerId: true } } },
      });
      if (!hit) return { outcome: 'not_found' };
      // Түгжээний дараалал: харилцагчийн түгжээ (saveScreening-тэй ижил) → screening мөрийн FOR UPDATE. Нэг screening-ийн өөр өөр hit-ийг зэрэг
      // шийдвэрлэхэд транзакцууд цувна; түгжээ авсны дараах statement бүр (READ COMMITTED) өмнөх транзакцийн commit-лэгдсэн өөрчлөлтийг харна.
      await lockCustomer(tx, cmd.orgId, hit.screening.customerId);
      await tx.$queryRaw`SELECT id FROM kyc.aml_check WHERE id = ${hit.screeningId}::uuid FOR UPDATE`;
      // Шинэ screening орчихсон бол хуучин screening-ийн hit-ийг шийдвэрлэхгүй (AmlHitReviewed blocking:false нь блоклосон харилцагчийг чөлөөлчихнө).
      if ((await latestScreeningId(tx, cmd.orgId, hit.screening.customerId)) !== hit.screeningId) return { outcome: 'superseded' };
      // Compare-and-set: зэрэгцээ шийдвэрээс зөвхөн нэг нь status = OPEN нөхцөлийг давна.
      const cas = await tx.amlHit.updateMany({
        where: { id: cmd.hitId, status: cmd.expectedStatus },
        data: { status: cmd.status, reviewedBy: cmd.reviewedBy, reviewedAt: cmd.reviewedAt, reviewComment: cmd.comment },
      });
      if (cas.count === 0) return { outcome: 'already_reviewed' };
      // Бүх hit-ийг дахин уншина (шийдвэрийг оруулаад) → нэгтгэлийг энд, DB-ийн одоогийн төлвөөс гаргана.
      const current = await tx.amlHit.findMany({ where: { screeningId: hit.screeningId }, orderBy: { position: 'asc' } });
      const derived = cmd.derive(current.map(hitOf));
      const updated = await tx.amlCheck.update({
        where: { id: hit.screeningId },
        data: { status: derived.status, blocking: derived.blocking, riskScore: derived.riskScore, riskLevel: derived.riskLevel, riskFactorsJson: json(derived.riskFactors) },
        include: WITH_HITS,
      });
      await enqueueOutbox(tx, derived.event);
      return { outcome: 'applied', screening: screeningOf(updated) };
    });
  }

  async findOutdatedLatestScreenings(orgId: string, currentVersions: Record<string, string>, limit: number): Promise<StoredScreening[]> {
    if (Object.keys(currentVersions).length === 0) return [];
    // Харилцагч тутмын хамгийн сүүлийн мөр (findLatestForCustomer-тэй ижил эрэмбэ), дараа нь хувилбар зөрсөн эсэх.
    const ids = await this.db.$queryRaw<{ id: string }[]>`
      SELECT latest.id FROM (
        SELECT DISTINCT ON (customer_id) id, screened_at, list_versions_json
        FROM kyc.aml_check
        WHERE org_id = ${orgId}
        ORDER BY customer_id, screened_at DESC, id DESC
      ) latest
      WHERE EXISTS (
        SELECT 1 FROM jsonb_each_text(${JSON.stringify(currentVersions)}::jsonb) AS cur
        WHERE (latest.list_versions_json ->> cur.key) IS DISTINCT FROM cur.value
      )
      ORDER BY latest.screened_at ASC, latest.id ASC
      LIMIT ${limit}`;
    const rows = await this.db.amlCheck.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: WITH_HITS });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap(({ id }) => {
      const row = byId.get(id);
      return row ? [screeningOf(row)] : [];
    });
  }

  async applyBlacklistProjection(p: BlacklistProjection, eventId: string): Promise<ProjectionResult> {
    return this.db.$transaction(async (tx) => {
      const recorded = await tx.processedEvent.createMany({ data: [{ eventId, consumer: PROJECTION_CONSUMER }], skipDuplicates: true });
      if (recorded.count === 0) return 'DUPLICATE';
      const data = {
        orgId: p.orgId,
        registerNoHash: p.registerNoHash,
        customerType: p.customerType,
        name: p.name,
        listType: p.listType,
        reasonCode: p.reasonCode,
        isActive: p.isActive,
        changedAt: p.changedAt,
      };
      // Insert-or-nothing, дараа нь changedAt-аар хамгаалсан update: зэрэгцээ, дарааллаа алдсан event хуучин төлөвөөр дарж чадахгүй.
      const inserted = await tx.blacklistProjection.createMany({ data: [{ id: p.id, ...data }], skipDuplicates: true });
      if (inserted.count === 1) return 'APPLIED';
      const updated = await tx.blacklistProjection.updateMany({ where: { id: p.id, changedAt: { lt: p.changedAt } }, data });
      return updated.count === 1 ? 'APPLIED' : 'STALE';
    });
  }

  async findBlacklistByRegisterHash(orgId: string, registerNoHash: string): Promise<BlacklistProjection[]> {
    const rows = await this.db.blacklistProjection.findMany({ where: { orgId, registerNoHash, isActive: true }, orderBy: { id: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      registerNoHash: row.registerNoHash,
      customerType: row.customerType as BlacklistProjection['customerType'],
      name: row.name,
      listType: row.listType,
      reasonCode: row.reasonCode,
      isActive: row.isActive,
      changedAt: row.changedAt,
    }));
  }
}
