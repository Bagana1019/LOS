// AmlRepository-ийн in-memory хэрэгжүүлэлт: бусад suite-ийн test double. Prisma хэрэгжүүлэлттэй ижил төрхтэй
// байх нь aml-repository.contract.ts-ээр баталгаажна. Хадгалах/унших бүрт clone хийнэ (дуудагч дотоод төлөвийг өөрчилж чадахгүй).
import type { AmlHit, DomainEvent } from '@los/contracts';
import {
  ScreeningRaceError, type AmlRepository, type ApplyHitReviewResult, type BlacklistProjection, type HitReviewCommand, type ProjectionResult,
  type SaveScreeningOptions, type StoredScreening,
} from '../aml.ports';

type HitFilter = Parameters<AmlRepository['listHits']>[1];
type HitRef = { screening: StoredScreening; hit: AmlHit };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** screenedAt буурахаар, тэнцвэл id буурахаар (findLatestForCustomer). */
const newestFirst = (a: StoredScreening, b: StoredScreening) => b.screenedAt.getTime() - a.screenedAt.getTime() || compare(b.id, a.id);

export class InMemoryAmlRepository implements AmlRepository {
  private readonly screenings = new Map<string, StoredScreening>();
  private readonly outbox = new Map<string, DomainEvent>();
  private readonly blacklist = new Map<string, BlacklistProjection>();
  private readonly processedEvents = new Set<string>();

  /** Outbox-д бичигдсэн event-үүд, бичигдсэн дарааллаар (тестэд шалгахад). */
  getOutbox(): DomainEvent[] {
    return structuredClone([...this.outbox.values()]);
  }

  async saveScreening(screening: StoredScreening, event: DomainEvent, options: SaveScreeningOptions = {}): Promise<void> {
    // Шалгалт + бичилт НЭГ тик дотор (await-гүй): prisma хувилбарын харилцагчийн advisory түгжээтэй ижил — зэрэгцээ хадгалалт цувна.
    if (options.expectedPreviousId !== undefined && (this.latestOf(screening.orgId, screening.customerId)?.id ?? null) !== options.expectedPreviousId) {
      throw new ScreeningRaceError();
    }
    const hitIds = new Set<string>();
    if (this.screenings.has(screening.id)) throw new Error(`Screening ${screening.id} already exists`);
    if (this.outbox.has(event.eventId)) throw new Error(`Outbox event ${event.eventId} already exists`);
    for (const hit of screening.hits) {
      if (hitIds.has(hit.id) || this.locateHit(hit.id)) throw new Error(`Hit ${hit.id} already exists`);
      hitIds.add(hit.id);
    }
    this.screenings.set(screening.id, structuredClone(screening));
    this.outbox.set(event.eventId, structuredClone(event));
  }

  async findScreening(orgId: string, id: string): Promise<StoredScreening | null> {
    const s = this.screenings.get(id);
    return s && s.orgId === orgId ? structuredClone(s) : null;
  }

  async findLatestForCustomer(orgId: string, customerId: string): Promise<StoredScreening | null> {
    const latest = this.latestOf(orgId, customerId);
    return latest ? structuredClone(latest) : null;
  }

  async findHit(orgId: string, hitId: string): Promise<HitRef | null> {
    const found = this.locateHit(hitId);
    return found && found.screening.orgId === orgId ? structuredClone(found) : null;
  }

  async listHits(orgId: string, filter: HitFilter): Promise<{ total: number; items: HitRef[] }> {
    const latestIds = new Set(this.latestPerCustomer(orgId).map((s) => s.id));
    const matches = this.orgScreenings(orgId)
      .filter((screening) => latestIds.has(screening.id))
      .flatMap((screening) => screening.hits.map((hit) => ({ screening, hit })))
      .filter(({ hit }) => (!filter.status || hit.status === filter.status) && (!filter.list || hit.list === filter.list))
      .sort((a, b) => b.screening.screenedAt.getTime() - a.screening.screenedAt.getTime() || compare(a.hit.id, b.hit.id));
    return { total: matches.length, items: structuredClone(matches.slice(filter.offset, filter.offset + filter.limit)) };
  }

  async applyHitReview(cmd: HitReviewCommand): Promise<ApplyHitReviewResult> {
    const found = this.locateHit(cmd.hitId);
    if (!found || found.screening.orgId !== cmd.orgId) return { outcome: 'not_found' };
    // Нэг тик дотор (await-гүй) явагдана: prisma хувилбарын "харилцагчийн түгжээ + screening түгжих" дүрэмтэй ижил — зэрэгцээ шийдвэр, хадгалалт цувна.
    if (this.latestOf(cmd.orgId, found.screening.customerId)?.id !== found.screening.id) return { outcome: 'superseded' };
    if (found.hit.status !== cmd.expectedStatus) return { outcome: 'already_reviewed' };
    const decided = structuredClone(found.screening.hits).map((h): AmlHit => h.id === cmd.hitId
      ? { ...h, status: cmd.status, reviewedBy: cmd.reviewedBy, reviewedAt: cmd.reviewedAt.toISOString(), reviewComment: cmd.comment }
      : h);
    const derived = cmd.derive(structuredClone(decided)); // шидвэл юу ч өөрчлөгдөөгүй
    if (this.outbox.has(derived.event.eventId)) throw new Error(`Outbox event ${derived.event.eventId} already exists`);
    found.screening.hits = decided;
    Object.assign(found.screening, {
      status: derived.status, blocking: derived.blocking, riskScore: derived.riskScore, riskLevel: derived.riskLevel, riskFactors: structuredClone(derived.riskFactors),
    });
    this.outbox.set(derived.event.eventId, structuredClone(derived.event));
    return { outcome: 'applied', screening: structuredClone(found.screening) };
  }

  async findOutdatedLatestScreenings(orgId: string, currentVersions: Record<string, string>, limit: number): Promise<StoredScreening[]> {
    const outdated = this.latestPerCustomer(orgId)
      .filter((s) => Object.entries(currentVersions).some(([list, version]) => s.listVersions[list] !== version))
      .sort((a, b) => a.screenedAt.getTime() - b.screenedAt.getTime() || compare(a.id, b.id));
    return structuredClone(outdated.slice(0, limit));
  }

  async applyBlacklistProjection(projection: BlacklistProjection, eventId: string): Promise<ProjectionResult> {
    if (this.processedEvents.has(eventId)) return 'DUPLICATE';
    this.processedEvents.add(eventId);
    const existing = this.blacklist.get(projection.id);
    if (existing && existing.changedAt.getTime() >= projection.changedAt.getTime()) return 'STALE';
    this.blacklist.set(projection.id, structuredClone(projection));
    return 'APPLIED';
  }

  async findBlacklistByRegisterHash(orgId: string, registerNoHash: string): Promise<BlacklistProjection[]> {
    const active = [...this.blacklist.values()]
      .filter((p) => p.orgId === orgId && p.registerNoHash === registerNoHash && p.isActive)
      .sort((a, b) => compare(a.id, b.id));
    return structuredClone(active);
  }

  private orgScreenings(orgId: string): StoredScreening[] {
    return [...this.screenings.values()].filter((s) => s.orgId === orgId);
  }

  /** Харилцагчийн ОДООГИЙН сүүлийн screening (clone хийгээгүй). */
  private latestOf(orgId: string, customerId: string): StoredScreening | undefined {
    return this.orgScreenings(orgId).filter((s) => s.customerId === customerId).sort(newestFirst)[0];
  }

  /** Харилцагч тутмын сүүлийн screening (clone хийгээгүй). */
  private latestPerCustomer(orgId: string): StoredScreening[] {
    const latestByCustomer = new Map<string, StoredScreening>();
    for (const s of this.orgScreenings(orgId).sort(newestFirst)) {
      if (!latestByCustomer.has(s.customerId)) latestByCustomer.set(s.customerId, s);
    }
    return [...latestByCustomer.values()];
  }

  /** Дотоод (clone хийгээгүй) лавлагаа; гаднаа буцаахдаа заавал clone хийнэ. */
  private locateHit(hitId: string): HitRef | null {
    for (const screening of this.screenings.values()) {
      const hit = screening.hits.find((h) => h.id === hitId);
      if (hit) return { screening, hit };
    }
    return null;
  }
}
