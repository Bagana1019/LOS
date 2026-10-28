import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { amlRisk, type AmlRiskInput } from '@los/calc';
import {
  ScreeningList, type AmlHit, type AmlHitReviewRequest, type AmlListStatus, type AmlPolicy, type AmlScreenRequest,
  type AmlScreeningResult, type AmlSubject, type DomainEvent, type HitStatus,
} from '@los/contracts';
import { hashRegisterNo, maskRegisterNoStrict, normalizeRegisterNo } from '@los/database';
import type { RequestContext } from './aml.context';
import {
  AML_CLOCK, AML_IDS, AML_POLICY_PROVIDER, AML_REPOSITORY, PII_CIPHER, ScreeningRaceError,
  type AmlPolicyProvider, type AmlRepository, type Clock, type IdGenerator, type PiiCipher, type StoredScreening,
} from './aml.ports';
import { carryOverDecisions } from './carry-over';
import { runScreening } from './engine/screening-engine';
import { deriveScreeningStatus, isBlocking } from './engine/screening-status';
import { hasScreenableName, subjectNames } from './engine/subject-names';
import { evidenceDigestOf } from './evidence-digest';
import { subjectIdentityKey } from './subject-identity';
import { stampedVersion, WatchlistService } from './watchlist.service';

const DEFAULT_COUNTRY = 'MN';
/** Зэрэгцээ шалгалттай мөргөлдөхөд (ScreeningRaceError) өмнөх төлвөө дахин уншаад шинээр бодох дээд оролдлогын тоо. */
const MAX_SCREEN_ATTEMPTS = 3;
const SUPERSEDED_MESSAGE = 'Screening is superseded by a newer one; review the hits of the latest screening';

/** rescreen-ийн сонгосон screening харилцагчийн сүүлийнх биш болсон (шинэ шалгалт орчихсон): хуучирсан субъектийг дахин шалгахгүй. */
class ScreeningSupersededError extends Error {
  constructor() {
    super('The selected screening is no longer the latest of the customer');
    this.name = 'ScreeningSupersededError';
  }
}

export interface RescreenSummary { checked: number; rescreened: number; failed: number; skipped: number }

/** Алдааны лог-д зөвхөн ангийн нэр + код (мессеж, субъектийн өгөгдөл хэзээ ч орохгүй). */
function errorSummary(e: unknown): { errorClass: string; code: string } {
  const errorClass = e instanceof Error ? e.constructor.name : typeof e;
  const raw = (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined) ?? (e instanceof HttpException ? `HTTP_${e.getStatus()}` : undefined);
  const code = (typeof raw === 'string' || typeof raw === 'number') && /^[A-Za-z0-9_.-]{1,32}$/.test(String(raw)) ? String(raw) : 'n/a';
  return { errorClass, code };
}

export function toResult(s: StoredScreening): AmlScreeningResult {
  return {
    id: s.id, orgId: s.orgId, customerId: s.customerId, applicationId: s.applicationId, trigger: s.trigger,
    status: s.status, blocking: s.blocking, riskScore: s.riskScore, riskLevel: s.riskLevel, riskFactors: s.riskFactors,
    subjectName: s.subjectName, registerNoMasked: s.registerNoMasked, hits: s.hits, listVersions: s.listVersions,
    screenedAt: s.screenedAt.toISOString(), screenedBy: s.screenedBy,
  };
}

/** Эрсдэлийн оролт: шийдвэрлэгдээгүй / баталгаажсан hit-үүдээс (FALSE_POSITIVE тооцохгүй). */
export function riskInputOf(subject: Pick<AmlSubject, 'isPep' | 'isRelatedParty'>, hits: Pick<AmlHit, 'list' | 'status' | 'details'>[]): AmlRiskInput {
  const live = hits.filter((h) => h.status !== 'FALSE_POSITIVE');
  const un = live.filter((h) => h.list === 'UN_SC');
  const fatf = live.filter((h) => h.list === 'FATF').map((h) => h.details['category']);
  return {
    isPep: subject.isPep,
    isRelatedParty: subject.isRelatedParty,
    fatfCategory: fatf.includes('CALL_FOR_ACTION') ? 'CALL_FOR_ACTION' : fatf.includes('INCREASED_MONITORING') ? 'INCREASED_MONITORING' : null,
    internalBlacklistHit: live.some((h) => h.list === 'INTERNAL_BLACKLIST'),
    sanctions: un.some((h) => h.status === 'CONFIRMED') ? 'CONFIRMED' : un.length > 0 ? 'POSSIBLE' : 'NONE',
  };
}

interface ComputedHits { fresh: AmlHit[]; listVersions: Record<string, string> }

@Injectable()
export class AmlService {
  constructor(
    @Inject(AML_REPOSITORY) private readonly repo: AmlRepository,
    @Inject(AML_POLICY_PROVIDER) private readonly policies: AmlPolicyProvider,
    @Inject(PII_CIPHER) private readonly cipher: PiiCipher,
    @Inject(AML_CLOCK) private readonly clock: Clock,
    @Inject(AML_IDS) private readonly ids: IdGenerator,
    @Inject(WatchlistService) private readonly watchlists: WatchlistService,
  ) {}

  private readonly log = new Logger(AmlService.name);

  /**
   * FR-3.4 / FR-2.5: UN, FATF, дотоод хар жагсаалтаар ҮРГЭЛЖ гурвуулангаар нь шалгаж, эрсдэлийн оноо бодож, үр дүнг outbox event-тэй хамт хадгална.
   * `opts.screenedBy`: дотоод хэрэглээ (rescreen) — анхны шалгалтыг эхлүүлсэн хүнийг хадгална (segregation of duties).
   * `opts.supersedes`: дотоод хэрэглээ (rescreen) — энэ screening одоо ч харилцагчийн сүүлийнх байх ёстой, үгүй бол ScreeningSupersededError.
   *
   * Харилцагч (org, customerId) тутамд цувна: өмнөх сүүлийн screening-ийг уншаад (guard, carry-over) бодож, хадгалахдаа repository тэр id одоо ч
   * сүүлийнх эсэхийг транзакц дотор шалгана. Зэрэгцээ шалгалт орчихсон бол (ScreeningRaceError) өмнөх төлвөө дахин уншаад guard + carry-over-оо
   * шинээр хийнэ (жагсаалт татах, engine-ийг дахин ажиллуулахгүй), 3 оролдлогоор бүтэхгүй бол 409.
   */
  async screen(
    req: AmlScreenRequest, ctx: RequestContext, opts: { screenedBy?: string | null; supersedes?: string } = {},
  ): Promise<AmlScreeningResult> {
    if (req.orgId !== ctx.orgId) throw new ForbiddenException('orgId does not match the caller organisation');
    const policy = await this.policies.getPolicy(req.orgId);
    const subject: AmlSubject = { ...req.subject, countries: req.subject.countries.length ? req.subject.countries : [DEFAULT_COUNTRY] };
    // Нэр нь цэвэрлэгдэхэд хоосорч байвал (зөвхөн тэмдэгт / үл үзэгдэх тэмдэгт) нэрээр шалгах боломжгүй — "цэвэр" гэж хэзээ ч хариулахгүй.
    if (!hasScreenableName(subject)) throw new BadRequestException('Subject has no name that can be screened');
    const registerNoHash = hashRegisterNo(subject.registerNo);
    const identityKey = subjectIdentityKey(subject);

    let computed: ComputedHits | null = null;
    for (let attempt = 1; attempt <= MAX_SCREEN_ATTEMPTS; attempt++) {
      const previous = await this.repo.findLatestForCustomer(req.orgId, req.customerId);
      if (opts.supersedes !== undefined && previous?.id !== opts.supersedes) throw new ScreeningSupersededError();
      // Блоклосон шалгалтыг өөр субъектоор (регистр, нэр, төрсөн огноо, төрөл, улс солиод) дарж болохгүй; ижил субъектын дахин шалгалт зөвшөөрөгдөнө.
      if (previous && isBlocking(previous.status) && (previous.registerNoHash !== registerNoHash || subjectIdentityKey(previous.subject) !== identityKey)) {
        throw new ConflictException('The customer has a blocking screening for a different identity; resolve the open hits first');
      }
      // Fail closed: жагсаалтыг уншиж чадаагүй бол "цэвэр" гэж хэзээ ч хариулахгүй (WatchlistUnavailableError → 503).
      computed ??= await this.computeHits(req, subject, policy, registerNoHash);
      const hits = carryOverDecisions(previous, registerNoHash, identityKey, computed.fresh);
      const status = deriveScreeningStatus(hits);
      const risk = amlRisk(riskInputOf(subject, hits), policy.risk);

      const { registerNo, ...snapshot } = subject;
      // Шинэ screening үргэлж өмнөхөөсөө хожуу: ижил мс / серверүүдийн цагийн зөрүүд санамсаргүй uuid-аар "сүүлийн" нь буруу сонгогдохгүй.
      const now = this.clock.now();
      const screenedAt = previous && now.getTime() <= previous.screenedAt.getTime() ? new Date(previous.screenedAt.getTime() + 1) : now;
      const screening: StoredScreening = {
        id: this.ids.uuid(), orgId: req.orgId, customerId: req.customerId, applicationId: req.applicationId ?? null, trigger: req.trigger,
        status, blocking: isBlocking(status), riskScore: risk.score, riskLevel: risk.level, riskFactors: risk.factors,
        subjectName: subjectNames(subject)[0] ?? '', registerNoMasked: maskRegisterNoStrict(registerNo), registerNoHash,
        registerNoEncrypted: this.cipher.encrypt(normalizeRegisterNo(registerNo)), subject: snapshot, listVersions: computed.listVersions,
        screenedAt, screenedBy: opts.screenedBy !== undefined ? opts.screenedBy : ctx.userId, correlationId: ctx.correlationId, hits,
      };
      const event: DomainEvent = {
        ...this.baseEvent(ctx), type: 'AmlScreeningCompleted', screeningId: screening.id, customerId: screening.customerId,
        applicationId: screening.applicationId, status, blocking: screening.blocking, riskScore: risk.score, riskLevel: risk.level, hitCount: hits.length,
      };
      try {
        await this.repo.saveScreening(screening, event, { expectedPreviousId: previous?.id ?? null });
        return toResult(screening);
      } catch (e) {
        if (!(e instanceof ScreeningRaceError)) throw e;
      }
    }
    throw new ConflictException('Another screening of this customer was saved at the same time (concurrent screening, retry)');
  }

  /** Жагсаалтуудаар шалгаж, hit бүрт нотолгооны хуруун мөр (evidenceDigest) тамгалах. Өмнөх шалгалтаас хамаарахгүй тул оролдлого бүрт дахин бодохгүй. */
  private async computeHits(req: AmlScreenRequest, subject: AmlSubject, policy: AmlPolicy, registerNoHash: string): Promise<ComputedHits> {
    const wl = { maxStaleHours: policy.maxStaleListHours };
    const un = await this.watchlists.getUn(wl);
    const fatf = await this.watchlists.getFatf(wl);
    const blacklist = await this.repo.findBlacklistByRegisterHash(req.orgId, registerNoHash);
    const listVersions: Record<string, string> = { UN_SC: stampedVersion(un), FATF: stampedVersion(fatf), INTERNAL_BLACKLIST: 'live' };
    const fresh: AmlHit[] = runScreening({ subject, policy, lists: ScreeningList, un: un.snapshot, fatf: fatf.snapshot, blacklist }).map((c) => ({
      ...c, id: this.ids.uuid(), status: 'OPEN', reviewedBy: null, reviewedAt: null, reviewComment: null,
      details: { ...c.details, evidenceDigest: evidenceDigestOf(c) },
    }));
    return { fresh, listVersions };
  }

  async getScreening(orgId: string, id: string): Promise<AmlScreeningResult> {
    const s = await this.repo.findScreening(orgId, id);
    if (!s) throw new NotFoundException('Screening not found');
    return toResult(s);
  }

  /** Харилцагчийн хамгийн сүүлийн шалгалт (wizard-ийн "Лавлагаа" алхамд). */
  async latestForCustomer(orgId: string, customerId: string): Promise<AmlScreeningResult> {
    const s = await this.repo.findLatestForCustomer(orgId, customerId);
    if (!s) throw new NotFoundException('No screening for this customer');
    return toResult(s);
  }

  async listHits(orgId: string, filter: { status?: HitStatus; list?: ScreeningList; limit: number; offset: number }) {
    const page = await this.repo.listHits(orgId, filter);
    return {
      total: page.total,
      items: page.items.map(({ screening: s, hit }) => ({
        hit,
        screening: { id: s.id, customerId: s.customerId, applicationId: s.applicationId, status: s.status, subjectName: s.subjectName, registerNoMasked: s.registerNoMasked, screenedAt: s.screenedAt.toISOString() },
      })),
    };
  }

  /**
   * Хориг жагсаалтын тохирлыг ХҮН шийдвэрлэнэ. Тайлбар заавал; шийдвэрийг өөрчлөх боломжгүй (дахин шалгалтаар шинэ hit үүснэ).
   * Зөвхөн харилцагчийн ОДООГИЙН сүүлийн screening-ийн hit-ийг шийдвэрлэнэ (хуучин screening-ийнх 409): үгүй бол AmlHitReviewed blocking:false нь
   * блоклосон харилцагчийг чөлөөлчихнө. Энэ шалгалтыг repository транзакц дотор давтан хэрэгжүүлнэ (review ба шинэ шалгалтын уралдаан).
   */
  async reviewHit(ctx: RequestContext, hitId: string, body: AmlHitReviewRequest): Promise<AmlScreeningResult> {
    const policy = await this.policies.getPolicy(ctx.orgId);
    const found = await this.repo.findHit(ctx.orgId, hitId);
    if (!found) throw new NotFoundException('Hit not found');
    const { screening, hit } = found;
    if (hit.status !== 'OPEN') throw new ConflictException('Hit has already been reviewed');
    const latest = await this.repo.findLatestForCustomer(ctx.orgId, screening.customerId);
    if (latest?.id !== screening.id) throw new ConflictException(SUPERSEDED_MESSAGE);
    // Segregation of duties: шалгалтыг эхлүүлсэн хүн өөрөө тохирлыг цэвэрлэж болохгүй (4 нүдний зарчим).
    if (policy.requireSeparateReviewer && screening.screenedBy === ctx.userId) throw new ForbiddenException('The reviewer must differ from the user who requested the screening');

    const reviewedAt = this.clock.now();
    // Screening-ийн нэгтгэл + event-ийг repository транзакц дотор, бүх hit-ийн одоогийн төлвөөс гаргана (зэрэгцээ шийдвэр алдагдахгүй).
    const result = await this.repo.applyHitReview({
      orgId: ctx.orgId, hitId, expectedStatus: 'OPEN', status: body.decision, reviewedBy: ctx.userId, reviewedAt, comment: body.comment,
      derive: (hits) => {
        const status = deriveScreeningStatus(hits);
        const blocking = isBlocking(status);
        const risk = amlRisk(riskInputOf(screening.subject, hits), policy.risk);
        return {
          status, blocking, riskScore: risk.score, riskLevel: risk.level, riskFactors: risk.factors,
          event: {
            ...this.baseEvent(ctx), type: 'AmlHitReviewed', screeningId: screening.id, hitId, customerId: screening.customerId,
            applicationId: screening.applicationId, list: hit.list, decision: body.decision, screeningStatus: status,
            blocking, riskScore: risk.score, riskLevel: risk.level,
          },
        };
      },
    });
    switch (result.outcome) {
      case 'applied': return toResult(result.screening);
      case 'superseded': throw new ConflictException(SUPERSEDED_MESSAGE);
      case 'already_reviewed': throw new ConflictException('Hit has already been reviewed');
      case 'not_found': throw new NotFoundException('Hit not found');
    }
  }

  async listStatuses(orgId: string): Promise<AmlListStatus[]> {
    return this.watchlists.status((await this.policies.getPolicy(orgId)).maxStaleListHours);
  }

  async refreshLists(list?: 'UN_SC' | 'FATF'): Promise<void> {
    await this.watchlists.refresh(list);
  }

  /**
   * Жагсаалт шинэчлэгдсэний дараа хуучин хувилбараар шалгагдсан харилцагчдыг дахин шалгана (LIST_UPDATE). Cron/BullMQ-ээс дуудна.
   * Жагсаалтууд бүгд унасан (cache байхгүй) бол ХҮСЭЛТ ДЭЭР 503 (харилцагч тутмын failed биш); давталтын дундуур унасан нь failed.
   * Сонгосон screening давталтын үед шинэ шалгалтаар солигдсон бол (хуучирсан субъект) шалгалгүй `skipped`-д тооцно.
   */
  async rescreenOutdated(ctx: RequestContext, limit: number): Promise<RescreenSummary> {
    const policy: AmlPolicy = await this.policies.getPolicy(ctx.orgId);
    const versions = await this.watchlists.currentVersions({ maxStaleHours: policy.maxStaleListHours });
    const outdated = await this.repo.findOutdatedLatestScreenings(ctx.orgId, versions, limit);
    let rescreened = 0;
    let failed = 0;
    let skipped = 0;
    for (const s of outdated) {
      try {
        await this.screen(
          {
            orgId: s.orgId, customerId: s.customerId, applicationId: s.applicationId, trigger: 'LIST_UPDATE',
            subject: { ...s.subject, registerNo: this.cipher.decrypt(s.registerNoEncrypted) },
          },
          ctx,
          // Анхны шалгалтыг эхлүүлсэн хүн (maker) хэвээр үлдэнэ: rescreen-ийг дуудсан admin зөвхөн event-ийн actorId.
          { screenedBy: s.screenedBy, supersedes: s.id },
        );
        rescreened++;
      } catch (e) {
        if (e instanceof ScreeningSupersededError) {
          skipped++;
          continue;
        }
        failed++; // дараагийн ажиллагаанд дахин оролдоно (screening хуучин хэвээр)
        // Оператор харах ёстой (DB тасарсан, програмын алдаа): PII-гүй — зөвхөн ангийн нэр, код, харилцагчийн id, correlationId.
        const { errorClass, code } = errorSummary(e);
        this.log.error(`rescreen failed: error=${errorClass} code=${code} customerId=${s.customerId} correlationId=${ctx.correlationId}`);
      }
    }
    return { checked: outdated.length, rescreened, failed, skipped };
  }

  private baseEvent(ctx: RequestContext) {
    return { eventId: this.ids.uuid(), occurredAt: this.clock.now().toISOString(), version: 1 as const, orgId: ctx.orgId, actorId: ctx.userId, correlationId: ctx.correlationId };
  }
}
