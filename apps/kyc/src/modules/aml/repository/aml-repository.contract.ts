// AmlRepository-ийн хамтын гэрээний тест: in-memory болон Prisma хэрэгжүүлэлт хоёулаа ижил дүрмийг биелүүлнэ (aml.ports.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmlHit, DomainEvent } from '@los/contracts';
import {
  ScreeningRaceError, type AmlRepository, type ApplyHitReviewResult, type BlacklistProjection, type HitReviewCommand, type ReviewDerivation, type StoredScreening,
} from '../aml.ports';
import { deriveScreeningStatus, isBlocking } from '../engine/screening-status';

export interface RepositoryHarness {
  repo: AmlRepository;
  /** Outbox-д бичигдсэн event-үүд (дараалал баталгаагүй). */
  outbox(): Promise<DomainEvent[]>;
}

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const T = (iso: string) => new Date(iso);

/** Тогтмол, эрэмбэлэхэд хялбар uuid. */
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

let seq = 100;
const nextId = () => uid(seq++);

function hit(over: Partial<AmlHit> = {}): AmlHit {
  return {
    id: nextId(), list: 'UN_SC', matchType: 'NAME_FUZZY', score: 0.9123, severity: 'BLOCKING', status: 'OPEN',
    entryRef: 'TEST-001', entryName: 'Test Entry', matchedValue: 'Test Entry', details: { programme: 'TEST', nested: { years: [1980, 1981] } },
    listVersion: 'v1', reviewedBy: null, reviewedAt: null, reviewComment: null, ...over,
  };
}

function screening(over: Partial<StoredScreening> = {}): StoredScreening {
  return {
    id: nextId(), orgId: ORG, customerId: 'cust-1', applicationId: 'app-1', trigger: 'APPLICATION', status: 'REVIEW_REQUIRED', blocking: true,
    riskScore: 42.5, riskLevel: 'MEDIUM', riskFactors: [{ code: 'SANCTIONS_POSSIBLE', weight: 40, detail: 'possible match' }],
    subjectName: 'Test Subject', registerNoMasked: 'УБ****5678', registerNoHash: 'hash-1', registerNoEncrypted: 'enc-1',
    subject: { subjectType: 'INDIVIDUAL', firstName: 'Test', lastName: 'Subject', aliases: ['T. Subject'], countries: ['MN'], isPep: false, isRelatedParty: false },
    listVersions: { UN_SC: 'v1', FATF: 'f1' }, screenedAt: T('2026-03-01T10:00:00.123Z'), screenedBy: 'user-1', correlationId: 'corr-1',
    hits: [hit(), hit({ list: 'FATF', severity: 'WARNING', matchType: 'COUNTRY', score: 1 })], ...over,
  };
}

function completed(s: StoredScreening, eventId = nextId()): DomainEvent {
  return {
    type: 'AmlScreeningCompleted', eventId, occurredAt: s.screenedAt.toISOString(), version: 1, orgId: s.orgId, actorId: s.screenedBy,
    correlationId: s.correlationId, screeningId: s.id, customerId: s.customerId, applicationId: s.applicationId, status: s.status,
    blocking: s.blocking, riskScore: s.riskScore, riskLevel: s.riskLevel, hitCount: s.hits.length,
  };
}

type Derived = Omit<ReviewDerivation, 'event'>;
const CLEARED: Derived = { status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [] };

interface ReviewOptions {
  orgId?: string;
  hitId?: string;
  status?: HitReviewCommand['status'];
  reviewedBy?: string;
  comment?: string;
  eventId?: string;
  /** derive-ийн тогтмол үр дүн (default: CLEARED_AFTER_REVIEW, blocking=false). */
  derived?: Partial<Derived>;
}

function reviewEvent(s: StoredScreening, h: AmlHit, eventId: string, reviewedBy: string, decision: HitReviewCommand['status'], d: Derived): DomainEvent {
  return {
    type: 'AmlHitReviewed', eventId, occurredAt: '2026-03-02T09:30:00.456Z', version: 1, orgId: s.orgId, actorId: reviewedBy,
    correlationId: 'corr-2', screeningId: s.id, hitId: h.id, customerId: s.customerId, applicationId: s.applicationId, list: h.list,
    decision, screeningStatus: d.status, blocking: d.blocking, riskScore: d.riskScore, riskLevel: d.riskLevel,
  };
}

/** Тогтмол үр дүнтэй derive; repository-д ямар hit-үүд дамжуулснаа `seen`-д цуглуулна. */
function review(s: StoredScreening, h: AmlHit, over: ReviewOptions = {}) {
  const eventId = over.eventId ?? nextId();
  const status = over.status ?? 'FALSE_POSITIVE';
  const reviewedBy = over.reviewedBy ?? 'reviewer-1';
  const derived: Derived = { ...CLEARED, ...over.derived };
  const event = reviewEvent(s, h, eventId, reviewedBy, status, derived);
  const seen: AmlHit[][] = [];
  const cmd: HitReviewCommand = {
    orgId: over.orgId ?? s.orgId, hitId: over.hitId ?? h.id, expectedStatus: 'OPEN', status, reviewedBy,
    reviewedAt: T('2026-03-02T09:30:00.456Z'), comment: over.comment ?? 'Different person, birth year mismatch',
    derive: (hits) => { seen.push(structuredClone(hits)); return { ...derived, event }; },
  };
  return { cmd, event, seen };
}

/** Service-тэй ижил санаагаар: нэгтгэл + event нь derive-д ирсэн hit-үүдийн ОДООГИЙН төлвөөс бодогдоно. */
function derivingReview(s: StoredScreening, h: AmlHit, status: HitReviewCommand['status'], reviewedBy: string) {
  const eventId = nextId();
  const cmd: HitReviewCommand = {
    orgId: s.orgId, hitId: h.id, expectedStatus: 'OPEN', status, reviewedBy, reviewedAt: T('2026-03-02T09:30:00.456Z'), comment: 'Decision by reviewer',
    derive: (hits) => {
      const st = deriveScreeningStatus(hits);
      const d: Derived = {
        status: st, blocking: isBlocking(st),
        riskScore: hits.some((x) => x.status === 'CONFIRMED') ? 100 : hits.some((x) => x.status === 'OPEN') ? 60 : 0,
        riskLevel: hits.some((x) => x.status !== 'FALSE_POSITIVE') ? 'HIGH' : 'LOW', riskFactors: [],
      };
      return { ...d, event: reviewEvent(s, h, eventId, reviewedBy, status, d) };
    },
  };
  return { cmd, eventId };
}

function projection(over: Partial<BlacklistProjection> = {}): BlacklistProjection {
  return {
    id: nextId(), orgId: ORG, registerNoHash: 'hash-1', customerType: 'INDIVIDUAL', name: 'Debtor One', listType: 'DELINQUENT',
    reasonCode: 'OVERDUE_90', isActive: true, changedAt: T('2026-03-01T00:00:00.000Z'), ...over,
  };
}

const eventIds = (events: DomainEvent[]) => events.map((e) => e.eventId).sort();

/** applyHitReview 'applied' үр дүнгийн screening-ийг гаргана; өөр үр дүн бол тестийг унагана. */
function applied(result: ApplyHitReviewResult): StoredScreening {
  if (result.outcome !== 'applied') throw new Error(`expected the review to be applied, got ${result.outcome}`);
  return result.screening;
}

export function describeAmlRepositoryContract(name: string, factory: () => Promise<RepositoryHarness>): void {
  describe(`${name}: AmlRepository contract`, () => {
    let h: RepositoryHarness;
    let repo: AmlRepository;
    beforeEach(async () => {
      h = await factory();
      repo = h.repo;
    });

    describe('saveScreening', () => {
      it('stores the screening with every hit and round-trips all fields', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        expect(await repo.findScreening(ORG, s.id)).toEqual(s);
      });

      it('round-trips nulls, reviewed hits and dates as Date', async () => {
        const reviewed = hit({ status: 'CONFIRMED', matchedValue: null, reviewedBy: 'u-2', reviewedAt: '2026-03-02T09:30:00.456Z', reviewComment: 'confirmed by phone' });
        const s = screening({ applicationId: null, screenedBy: null, hits: [reviewed] });
        await repo.saveScreening(s, completed(s));
        const got = await repo.findScreening(ORG, s.id);
        expect(got).toEqual(s);
        expect(got?.screenedAt).toBeInstanceOf(Date);
        expect(got?.screenedAt.getTime()).toBe(s.screenedAt.getTime());
      });

      it('keeps scores within their decimal precision', async () => {
        const s = screening({ riskScore: 12.3456, hits: [hit({ score: 0.91234 })] });
        await repo.saveScreening(s, completed(s));
        const got = await repo.findScreening(ORG, s.id);
        expect(got?.riskScore).toBeCloseTo(12.3456, 2);
        expect(got?.hits[0]?.score).toBeCloseTo(0.91234, 4);
      });

      it('keeps the hit ids and the order of the hits it was given', async () => {
        const hits = [hit({ id: uid(30) }), hit({ id: uid(10) }), hit({ id: uid(20) })];
        const s = screening({ hits });
        await repo.saveScreening(s, completed(s));
        expect((await repo.findScreening(ORG, s.id))?.hits.map((x) => x.id)).toEqual([uid(30), uid(10), uid(20)]);
      });

      it('stores a clean screening without hits', async () => {
        const s = screening({ status: 'CLEAR', blocking: false, hits: [] });
        await repo.saveScreening(s, completed(s));
        expect(await repo.findScreening(ORG, s.id)).toEqual(s);
      });

      it('writes the event to the outbox', async () => {
        const s = screening();
        const event = completed(s);
        await repo.saveScreening(s, event);
        expect(await h.outbox()).toEqual([event]);
      });

      it('rejects a duplicate screening id and leaves the original and the outbox untouched', async () => {
        const s = screening();
        const event = completed(s);
        await repo.saveScreening(s, event);
        const again = screening({ id: s.id, status: 'CLEAR', blocking: false, hits: [] });
        await expect(repo.saveScreening(again, completed(again))).rejects.toThrow();
        expect(await repo.findScreening(ORG, s.id)).toEqual(s);
        expect(await h.outbox()).toEqual([event]);
      });

      it('stores nothing when the outbox event id already exists', async () => {
        const first = screening();
        const event = completed(first);
        await repo.saveScreening(first, event);
        const second = screening({ customerId: 'cust-2' });
        await expect(repo.saveScreening(second, completed(second, event.eventId))).rejects.toThrow();
        expect(await repo.findScreening(ORG, second.id)).toBeNull();
        expect(await repo.findHit(ORG, second.hits[0].id)).toBeNull();
        expect(await h.outbox()).toEqual([event]);
      });

      it('stores nothing when a hit id already exists', async () => {
        const first = screening();
        const event = completed(first);
        await repo.saveScreening(first, event);
        const second = screening({ customerId: 'cust-2', hits: [hit(), hit({ id: first.hits[0].id })] });
        await expect(repo.saveScreening(second, completed(second))).rejects.toThrow();
        expect(await repo.findScreening(ORG, second.id)).toBeNull();
        expect(await h.outbox()).toEqual([event]);
      });
    });

    describe('saveScreening: expectedPreviousId (serialisation per customer)', () => {
      const first = () => screening({ screenedAt: T('2026-03-01T00:00:00.000Z') });
      const second = () => screening({ screenedAt: T('2026-03-02T00:00:00.000Z') });
      const stored = async (...ids: string[]) => (await Promise.all(ids.map((id) => repo.findScreening(ORG, id)))).filter(Boolean).length;

      it('accepts null for a customer without screenings, then the id of the current latest', async () => {
        const a = first();
        const b = second();
        await repo.saveScreening(a, completed(a), { expectedPreviousId: null });
        await repo.saveScreening(b, completed(b), { expectedPreviousId: a.id });
        expect((await repo.findLatestForCustomer(ORG, 'cust-1'))?.id).toBe(b.id);
      });

      it('throws ScreeningRaceError and stores nothing when null is expected but the customer already has a screening', async () => {
        const a = first();
        const savedA = completed(a);
        await repo.saveScreening(a, savedA);
        const b = second();
        await expect(repo.saveScreening(b, completed(b), { expectedPreviousId: null })).rejects.toBeInstanceOf(ScreeningRaceError);
        expect(await repo.findScreening(ORG, b.id)).toBeNull();
        expect(await repo.findHit(ORG, b.hits[0].id)).toBeNull();
        expect(await h.outbox()).toEqual([savedA]);
      });

      it('compares with the CURRENT latest screening, not with an older one', async () => {
        const a = first();
        const b = second();
        await repo.saveScreening(a, completed(a));
        await repo.saveScreening(b, completed(b), { expectedPreviousId: a.id });
        const c = screening({ screenedAt: T('2026-03-03T00:00:00.000Z') });
        await expect(repo.saveScreening(c, completed(c), { expectedPreviousId: a.id })).rejects.toBeInstanceOf(ScreeningRaceError);
        await expect(repo.saveScreening(c, completed(c), { expectedPreviousId: uid(999_999) })).rejects.toBeInstanceOf(ScreeningRaceError);
        expect(await stored(c.id)).toBe(0);
        await repo.saveScreening(c, completed(c), { expectedPreviousId: b.id });
        expect((await repo.findLatestForCustomer(ORG, 'cust-1'))?.id).toBe(c.id);
      });

      it('looks only at the same organisation and customer', async () => {
        const otherCustomer = screening({ customerId: 'cust-2' });
        const otherOrg = screening({ orgId: OTHER_ORG });
        for (const s of [otherCustomer, otherOrg]) await repo.saveScreening(s, completed(s));
        const mine = screening();
        await repo.saveScreening(mine, completed(mine), { expectedPreviousId: null });
        expect(await stored(mine.id)).toBe(1);
        const next = screening({ screenedAt: T('2026-03-02T00:00:00.000Z') });
        await expect(repo.saveScreening(next, completed(next), { expectedPreviousId: otherCustomer.id })).rejects.toBeInstanceOf(ScreeningRaceError);
        await repo.saveScreening(next, completed(next), { expectedPreviousId: mine.id });
      });

      it('does not check anything when expectedPreviousId is omitted', async () => {
        const a = first();
        const b = second();
        await repo.saveScreening(a, completed(a));
        await repo.saveScreening(b, completed(b));
        expect(await stored(a.id, b.id)).toBe(2);
      });

      it('lets exactly one of several concurrent saves that expect the same previous screening win', async () => {
        const racers = Array.from({ length: 5 }, (_, i) => screening({ screenedAt: T(`2026-03-0${i + 1}T00:00:00.000Z`) }));
        const outcomes = await Promise.allSettled(racers.map((s) => repo.saveScreening(s, completed(s), { expectedPreviousId: null })));
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        for (const o of outcomes) if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(ScreeningRaceError);
        expect(await stored(...racers.map((s) => s.id))).toBe(1);
        expect(await h.outbox()).toHaveLength(1);
      });
    });

    describe('findScreening', () => {
      it('is scoped to the organisation', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        expect(await repo.findScreening(OTHER_ORG, s.id)).toBeNull();
      });

      it('returns null for unknown and malformed ids', async () => {
        expect(await repo.findScreening(ORG, uid(999_999))).toBeNull();
        expect(await repo.findScreening(ORG, 'not-a-uuid')).toBeNull();
      });
    });

    describe('findLatestForCustomer', () => {
      it('returns null when the customer was never screened', async () => {
        expect(await repo.findLatestForCustomer(ORG, 'nobody')).toBeNull();
      });

      it('returns the most recent screening by screenedAt whatever the insert order', async () => {
        const newest = screening({ screenedAt: T('2026-03-03T00:00:00.000Z') });
        const oldest = screening({ screenedAt: T('2026-03-01T00:00:00.000Z') });
        const middle = screening({ screenedAt: T('2026-03-02T00:00:00.000Z') });
        for (const s of [middle, newest, oldest]) await repo.saveScreening(s, completed(s));
        expect((await repo.findLatestForCustomer(ORG, 'cust-1'))?.id).toBe(newest.id);
      });

      it('breaks screenedAt ties by the greater id', async () => {
        const at = T('2026-03-01T00:00:00.000Z');
        const low = screening({ id: uid(1), screenedAt: at });
        const high = screening({ id: uid(2), screenedAt: at });
        for (const s of [high, low]) await repo.saveScreening(s, completed(s));
        expect((await repo.findLatestForCustomer(ORG, 'cust-1'))?.id).toBe(high.id);
      });

      it('is scoped to the organisation and the customer, and carries all hits', async () => {
        const mine = screening();
        const otherCustomer = screening({ customerId: 'cust-2', screenedAt: T('2026-04-01T00:00:00.000Z') });
        const otherOrg = screening({ orgId: OTHER_ORG, screenedAt: T('2026-04-02T00:00:00.000Z') });
        for (const s of [mine, otherCustomer, otherOrg]) await repo.saveScreening(s, completed(s));
        expect(await repo.findLatestForCustomer(ORG, 'cust-1')).toEqual(mine);
      });
    });

    describe('findHit', () => {
      it('returns the hit with its parent screening and all sibling hits', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        const found = await repo.findHit(ORG, s.hits[1].id);
        expect(found?.hit).toEqual(s.hits[1]);
        expect(found?.screening).toEqual(s);
      });

      it('is scoped to the organisation', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        expect(await repo.findHit(OTHER_ORG, s.hits[0].id)).toBeNull();
      });

      it('returns null for unknown and malformed ids', async () => {
        expect(await repo.findHit(ORG, uid(999_999))).toBeNull();
        expect(await repo.findHit(ORG, 'not-a-uuid')).toBeNull();
      });
    });

    describe('listHits', () => {
      // Бүх hit-ийн id тогтмол: эрэмбийг баталгаатай шалгана.
      const newest = () => screening({ screenedAt: T('2026-03-03T00:00:00.000Z'), hits: [
        hit({ id: uid(52), list: 'FATF' }), hit({ id: uid(51), list: 'UN_SC', status: 'CONFIRMED' }),
      ] });
      const middle = () => screening({ customerId: 'cust-2', screenedAt: T('2026-03-02T00:00:00.000Z'), hits: [
        hit({ id: uid(61), list: 'INTERNAL_BLACKLIST', status: 'FALSE_POSITIVE' }),
      ] });
      const oldest = () => screening({ customerId: 'cust-3', screenedAt: T('2026-03-01T00:00:00.000Z'), hits: [
        hit({ id: uid(72), list: 'FATF' }), hit({ id: uid(71), list: 'UN_SC' }),
      ] });
      const foreign = () => screening({ orgId: OTHER_ORG, customerId: 'cust-9', screenedAt: T('2026-03-04T00:00:00.000Z'), hits: [hit({ id: uid(81) })] });
      const page = { limit: 50, offset: 0 };

      let seeded: StoredScreening[];
      beforeEach(async () => {
        seeded = [oldest(), foreign(), newest(), middle()];
        for (const s of seeded) await repo.saveScreening(s, completed(s));
      });

      it('orders by screening date descending, then by hit id, within the organisation', async () => {
        const { total, items } = await repo.listHits(ORG, page);
        expect(total).toBe(5);
        expect(items.map((i) => i.hit.id)).toEqual([uid(51), uid(52), uid(61), uid(71), uid(72)]);
      });

      it('filters by status and by list', async () => {
        expect((await repo.listHits(ORG, { ...page, status: 'OPEN' })).items.map((i) => i.hit.id)).toEqual([uid(52), uid(71), uid(72)]);
        expect((await repo.listHits(ORG, { ...page, list: 'FATF' })).items.map((i) => i.hit.id)).toEqual([uid(52), uid(72)]);
        expect((await repo.listHits(ORG, { ...page, status: 'OPEN', list: 'UN_SC' })).items.map((i) => i.hit.id)).toEqual([uid(71)]);
        expect((await repo.listHits(ORG, { ...page, status: 'CONFIRMED', list: 'FATF' }))).toEqual({ total: 0, items: [] });
      });

      it('pages with limit and offset and reports the total before paging', async () => {
        const second = await repo.listHits(ORG, { limit: 2, offset: 2 });
        expect(second.total).toBe(5);
        expect(second.items.map((i) => i.hit.id)).toEqual([uid(61), uid(71)]);
        const past = await repo.listHits(ORG, { limit: 2, offset: 10 });
        expect(past).toEqual({ total: 5, items: [] });
      });

      it('carries the full parent screening, including every hit, on each item', async () => {
        const { items } = await repo.listHits(ORG, { ...page, list: 'FATF' });
        const parents = items.map((i) => i.screening);
        expect(parents).toEqual([seeded[2], seeded[0]]);
        expect(items[0]?.hit).toEqual(seeded[2]?.hits[0]);
      });

      it('does not leak other organisations', async () => {
        const { total, items } = await repo.listHits(OTHER_ORG, page);
        expect(total).toBe(1);
        expect(items.map((i) => i.hit.id)).toEqual([uid(81)]);
      });
    });

    describe('listHits and superseded screenings', () => {
      const page = { limit: 50, offset: 0 };
      const old = () => screening({ customerId: 'cust-s', screenedAt: T('2026-03-01T00:00:00.000Z'), hits: [
        hit({ id: uid(201) }), hit({ id: uid(202), list: 'FATF' }), hit({ id: uid(203), status: 'FALSE_POSITIVE' }),
      ] });
      const latest = () => screening({ customerId: 'cust-s', screenedAt: T('2026-03-02T00:00:00.000Z'), hits: [hit({ id: uid(211) })] });
      const other = () => screening({ customerId: 'cust-o', screenedAt: T('2026-03-01T00:00:00.000Z'), hits: [hit({ id: uid(221) })] });

      it('returns only the hits of the latest screening of each customer, in the items and in the total', async () => {
        for (const s of [old(), other(), latest()]) await repo.saveScreening(s, completed(s));
        const all = await repo.listHits(ORG, page);
        expect(all.total).toBe(2);
        expect(all.items.map((i) => i.hit.id)).toEqual([uid(211), uid(221)]);
        expect((await repo.listHits(ORG, { ...page, status: 'OPEN' })).items.map((i) => i.hit.id)).toEqual([uid(211), uid(221)]);
        expect(await repo.listHits(ORG, { ...page, list: 'FATF' })).toEqual({ total: 0, items: [] });
        expect(await repo.listHits(ORG, { ...page, status: 'FALSE_POSITIVE' })).toEqual({ total: 0, items: [] });
        expect((await repo.listHits(ORG, { limit: 1, offset: 1 })).items.map((i) => i.hit.id)).toEqual([uid(221)]);
      });

      it('uses the same notion of latest as findLatestForCustomer: equal timestamps are broken by the greater screening id', async () => {
        const at = T('2026-03-05T00:00:00.000Z');
        const low = screening({ id: uid(301), customerId: 'cust-t', screenedAt: at, hits: [hit({ id: uid(311) })] });
        const high = screening({ id: uid(302), customerId: 'cust-t', screenedAt: at, hits: [hit({ id: uid(312) })] });
        for (const s of [high, low]) await repo.saveScreening(s, completed(s));
        expect((await repo.listHits(ORG, page)).items.map((i) => i.hit.id)).toEqual([uid(312)]);
      });

      it('shows the hits of an older screening again only if it is the latest (other organisations are independent)', async () => {
        const a = old();
        const foreign = screening({ orgId: OTHER_ORG, customerId: 'cust-s', screenedAt: T('2026-03-09T00:00:00.000Z'), hits: [hit({ id: uid(231) })] });
        for (const s of [a, foreign]) await repo.saveScreening(s, completed(s));
        expect((await repo.listHits(ORG, page)).items.map((i) => i.hit.id)).toEqual([uid(201), uid(202), uid(203)]);
        expect((await repo.listHits(OTHER_ORG, page)).items.map((i) => i.hit.id)).toEqual([uid(231)]);
      });
    });

    describe('applyHitReview', () => {
      it('updates the hit and the screening, writes the event to the outbox and returns the stored screening', async () => {
        const s = screening();
        const saved = completed(s);
        await repo.saveScreening(s, saved);
        const { cmd, event } = review(s, s.hits[0]);
        const result = applied(await repo.applyHitReview(cmd));

        const found = await repo.findHit(ORG, s.hits[0].id);
        expect(found?.hit).toEqual({
          ...s.hits[0], status: 'FALSE_POSITIVE', reviewedBy: 'reviewer-1', reviewedAt: '2026-03-02T09:30:00.456Z', reviewComment: 'Different person, birth year mismatch',
        });
        expect(found?.screening).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [] });
        expect(found?.screening.hits[1]).toEqual(s.hits[1]);
        // Буцаасан утга нь хадгалагдсан (дахин уншсан) screening — локал бодсон объект биш.
        expect(result).toEqual(found?.screening);
        expect(eventIds(await h.outbox())).toEqual(eventIds([saved, event]));
        expect((await h.outbox()).find((e) => e.eventId === event.eventId)).toEqual(event);
      });

      it('derives from every hit of the screening as it stands after the decision', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        const { cmd, seen } = review(s, s.hits[0]);
        await repo.applyHitReview(cmd);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual([
          { ...s.hits[0], status: 'FALSE_POSITIVE', reviewedBy: 'reviewer-1', reviewedAt: '2026-03-02T09:30:00.456Z', reviewComment: 'Different person, birth year mismatch' },
          s.hits[1],
        ]);
      });

      it('stores whatever the derivation returns (status, blocking, risk, factors)', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        const derived = { status: 'CONFIRMED_MATCH' as const, blocking: true, riskScore: 100, riskLevel: 'HIGH' as const, riskFactors: [{ code: 'SANCTIONS_CONFIRMED', weight: 100 }] };
        const { cmd } = review(s, s.hits[0], { status: 'CONFIRMED', derived });
        const result = applied(await repo.applyHitReview(cmd));
        expect(result).toMatchObject(derived);
        expect(await repo.findScreening(ORG, s.id)).toMatchObject(derived);
      });

      it('answers already_reviewed and changes nothing when the hit is no longer OPEN', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        const first = review(s, s.hits[0]);
        applied(await repo.applyHitReview(first.cmd));
        const second = review(s, s.hits[0], { status: 'CONFIRMED', reviewedBy: 'reviewer-2', comment: 'Overruled', derived: { status: 'CONFIRMED_MATCH', blocking: true } });
        expect(await repo.applyHitReview(second.cmd)).toEqual({ outcome: 'already_reviewed' });
        expect(second.seen).toHaveLength(0);

        const found = await repo.findHit(ORG, s.hits[0].id);
        expect(found?.hit).toMatchObject({ status: 'FALSE_POSITIVE', reviewedBy: 'reviewer-1' });
        expect(found?.screening).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false });
        expect(eventIds(await h.outbox())).not.toContain(second.event.eventId);
        expect(await h.outbox()).toHaveLength(2);
      });

      it('answers not_found for another organisation, an unknown hit and a malformed id, without an outbox row', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        const attempts = [review(s, s.hits[0], { orgId: OTHER_ORG }), review(s, s.hits[0], { hitId: uid(999_999) }), review(s, s.hits[0], { hitId: 'not-a-uuid' })];
        for (const a of attempts) {
          expect(await repo.applyHitReview(a.cmd)).toEqual({ outcome: 'not_found' });
          expect(a.seen).toHaveLength(0);
        }
        expect((await repo.findHit(ORG, s.hits[0].id))?.hit.status).toBe('OPEN');
        expect(await h.outbox()).toHaveLength(1);
      });

      it('changes nothing when the outbox event id already exists', async () => {
        const s = screening();
        const saved = completed(s);
        await repo.saveScreening(s, saved);
        const { cmd } = review(s, s.hits[0], { eventId: saved.eventId });
        await expect(repo.applyHitReview(cmd)).rejects.toThrow();
        const found = await repo.findHit(ORG, s.hits[0].id);
        expect(found?.hit.status).toBe('OPEN');
        expect(found?.screening).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
        expect(await h.outbox()).toEqual([saved]);
      });

      it('changes nothing when the derivation throws', async () => {
        const s = screening();
        const saved = completed(s);
        await repo.saveScreening(s, saved);
        const { cmd } = review(s, s.hits[0]);
        await expect(repo.applyHitReview({ ...cmd, derive: () => { throw new Error('derive failed'); } })).rejects.toThrow('derive failed');
        expect(await repo.findScreening(ORG, s.id)).toEqual(s);
        expect(await h.outbox()).toEqual([saved]);
      });

      it('lets exactly one of two concurrent reviews of the same hit win', async () => {
        const s = screening();
        await repo.saveScreening(s, completed(s));
        const a = review(s, s.hits[0], { reviewedBy: 'reviewer-a' });
        const b = review(s, s.hits[0], { reviewedBy: 'reviewer-b', status: 'CONFIRMED', derived: { status: 'CONFIRMED_MATCH', blocking: true } });
        const results = await Promise.all([repo.applyHitReview(a.cmd), repo.applyHitReview(b.cmd)]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['already_reviewed', 'applied']);
        const winner = results[0].outcome === 'applied' ? a.cmd : b.cmd;
        expect((await repo.findHit(ORG, s.hits[0].id))?.hit).toMatchObject({ status: winner.status, reviewedBy: winner.reviewedBy });
        expect(await h.outbox()).toHaveLength(2);
      });

      describe('superseded screenings', () => {
        const older = () => screening({ screenedAt: T('2026-03-01T00:00:00.000Z') });
        const newer = () => screening({ screenedAt: T('2026-03-02T00:00:00.000Z') });

        it('answers superseded, changes nothing and writes no event for a hit of a screening that has a newer one', async () => {
          const a = older();
          const b = newer();
          for (const s of [a, b]) await repo.saveScreening(s, completed(s));
          const stale = review(a, a.hits[0]);
          expect(await repo.applyHitReview(stale.cmd)).toEqual({ outcome: 'superseded' });
          expect(stale.seen).toHaveLength(0);
          const found = await repo.findHit(ORG, a.hits[0].id);
          expect(found?.hit.status).toBe('OPEN');
          expect(found?.screening).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
          expect(await h.outbox()).toHaveLength(2);
          // Харин сүүлийн screening-ийн hit-ийг шийдвэрлэж болно.
          applied(await repo.applyHitReview(review(b, b.hits[0]).cmd));
        });

        it('treats a decided hit of a superseded screening as superseded too', async () => {
          const a = older();
          const b = newer();
          await repo.saveScreening(a, completed(a));
          applied(await repo.applyHitReview(review(a, a.hits[0]).cmd));
          await repo.saveScreening(b, completed(b), { expectedPreviousId: a.id });
          expect(await repo.applyHitReview(review(a, a.hits[0], { reviewedBy: 'reviewer-2' }).cmd)).toEqual({ outcome: 'superseded' });
        });

        it('a review that races a newer screening either lands before it or is refused, and never on the superseded screening afterwards', async () => {
          const a = older();
          const b = newer();
          await repo.saveScreening(a, completed(a));
          const { cmd } = review(a, a.hits[0]);
          const [result] = await Promise.all([repo.applyHitReview(cmd), repo.saveScreening(b, completed(b), { expectedPreviousId: a.id })]);
          expect(['applied', 'superseded']).toContain(result.outcome);
          const reviewedEvents = (await h.outbox()).filter((e) => e.type === 'AmlHitReviewed');
          expect((await repo.findHit(ORG, a.hits[0].id))?.hit.status).toBe(result.outcome === 'applied' ? 'FALSE_POSITIVE' : 'OPEN');
          expect(reviewedEvents).toHaveLength(result.outcome === 'applied' ? 1 : 0);
          expect((await repo.findLatestForCustomer(ORG, 'cust-1'))?.id).toBe(b.id);
        });
      });

      describe('concurrent reviews of different hits of one screening', () => {
        const blockingHit = (entryRef: string) => hit({ list: 'UN_SC', severity: 'BLOCKING', entryRef });
        const twoBlocking = () => screening({ hits: [blockingHit('TEST-001'), blockingHit('TEST-002')] });
        const reviewedEvent = (events: DomainEvent[], eventId: string) => events.find((e) => e.eventId === eventId) as Extract<DomainEvent, { type: 'AmlHitReviewed' }>;

        it('ends CLEARED_AFTER_REVIEW / not blocking when both hits are cleared, and each event is consistent with its own view', async () => {
          const s = twoBlocking();
          await repo.saveScreening(s, completed(s));
          const a = derivingReview(s, s.hits[0], 'FALSE_POSITIVE', 'reviewer-a');
          const b = derivingReview(s, s.hits[1], 'FALSE_POSITIVE', 'reviewer-b');
          const [ra, rb] = (await Promise.all([repo.applyHitReview(a.cmd), repo.applyHitReview(b.cmd)])).map(applied) as [StoredScreening, StoredScreening];

          const final = await repo.findScreening(ORG, s.id);
          expect(final).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW' });
          expect(final?.hits.map((x) => x.status)).toEqual(['FALSE_POSITIVE', 'FALSE_POSITIVE']);

          // Сүүлд шийдвэрлэсэн хүний буцаасан үр дүн хоёр шийдвэрийг хоёуланг нь агуулна; эхнийх нь зөвхөн өөрийнхийг.
          const results = [ra, rb];
          const last = results.filter((r) => r.hits.every((x) => x.status === 'FALSE_POSITIVE'));
          const first = results.filter((r) => r.hits.some((x) => x.status === 'OPEN'));
          expect(last).toHaveLength(1);
          expect(first).toHaveLength(1);
          expect(last[0]).toEqual(final);
          expect(first[0]).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true, riskScore: 60 });

          // Event бүр тухайн үеийн бүрэн, дотроо зөрчилгүй өгөгдлийг агуулна: яг нэг нь CLEARED, нөгөө нь REVIEW_REQUIRED.
          const events = await h.outbox();
          for (const [cmd, result] of [[a, ra], [b, rb]] as const) {
            const ev = reviewedEvent(events, cmd.eventId);
            expect(ev).toMatchObject({ screeningStatus: result.status, blocking: result.blocking, riskScore: result.riskScore, riskLevel: result.riskLevel });
          }
          expect([a, b].map((c) => reviewedEvent(events, c.eventId).screeningStatus).sort()).toEqual(['CLEARED_AFTER_REVIEW', 'REVIEW_REQUIRED']);
          expect(events).toHaveLength(3);
        });

        it('ends CONFIRMED_MATCH / blocking whichever order a false positive and a confirmation commit in', async () => {
          const s = twoBlocking();
          await repo.saveScreening(s, completed(s));
          const fp = derivingReview(s, s.hits[0], 'FALSE_POSITIVE', 'reviewer-a');
          const confirm = derivingReview(s, s.hits[1], 'CONFIRMED', 'reviewer-b');
          (await Promise.all([repo.applyHitReview(fp.cmd), repo.applyHitReview(confirm.cmd)])).forEach(applied);
          const final = await repo.findScreening(ORG, s.id);
          expect(final).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true, riskScore: 100, riskLevel: 'HIGH' });
          expect(final?.hits.map((x) => x.status)).toEqual(['FALSE_POSITIVE', 'CONFIRMED']);
          expect(reviewedEvent(await h.outbox(), confirm.eventId)).toMatchObject({ screeningStatus: 'CONFIRMED_MATCH', blocking: true, decision: 'CONFIRMED' });
        });

        it('serialises many simultaneous reviews: only the last-committed one sees the screening cleared', async () => {
          const s = screening({ hits: ['A', 'B', 'C', 'D'].map((ref) => blockingHit(`TEST-${ref}`)) });
          await repo.saveScreening(s, completed(s));
          const reviews = s.hits.map((x, i) => derivingReview(s, x, 'FALSE_POSITIVE', `reviewer-${i}`));
          const results = (await Promise.all(reviews.map((r) => repo.applyHitReview(r.cmd)))).map(applied);
          expect(await repo.findScreening(ORG, s.id)).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false });
          const events = await h.outbox();
          const statuses = reviews.map((r) => reviewedEvent(events, r.eventId).screeningStatus);
          expect(statuses.filter((x) => x === 'CLEARED_AFTER_REVIEW')).toHaveLength(1);
          expect(statuses.filter((x) => x === 'REVIEW_REQUIRED')).toHaveLength(3);
          // Хэдэн hit шийдвэрлэгдсэнийг нь үр дүн бүр өөр өөрөөр харуулна (1, 2, 3, 4) — хэн ч өөр хүний шийдвэрийг алдаагүй.
          const decided = results.map((r) => r.hits.filter((x) => x.status === 'FALSE_POSITIVE').length).sort();
          expect(decided).toEqual([1, 2, 3, 4]);
        });
      });
    });

    describe('findOutdatedLatestScreenings', () => {
      const current = { UN_SC: 'v2', FATF: 'f1' };
      const make = (customerId: string, screenedAt: string, listVersions: Record<string, string>, over: Partial<StoredScreening> = {}) =>
        screening({ customerId, screenedAt: T(screenedAt), listVersions, ...over });

      it('considers only the latest screening of each customer and returns the oldest first', async () => {
        const rows = [
          make('c-current', '2026-01-01T00:00:00.000Z', { UN_SC: 'v1', FATF: 'f1' }), // хуучин нь хуучирсан ч сүүлийнх нь шинэ
          make('c-current', '2026-02-01T00:00:00.000Z', { UN_SC: 'v2', FATF: 'f1' }),
          make('c-outdated', '2026-01-10T00:00:00.000Z', { UN_SC: 'v2', FATF: 'f1' }), // хуучин нь шинэ ч сүүлийнх нь хуучирсан
          make('c-outdated', '2026-02-10T00:00:00.000Z', { UN_SC: 'v1', FATF: 'f1' }),
          make('c-missing', '2026-01-20T00:00:00.000Z', { UN_SC: 'v2' }), // FATF түлхүүр байхгүй
          make('c-extra', '2026-01-05T00:00:00.000Z', { UN_SC: 'v2', FATF: 'f1', INTERNAL_BLACKLIST: 'live' }), // илүү түлхүүр нь хамаагүй
          make('c-foreign', '2026-01-02T00:00:00.000Z', { UN_SC: 'v0' }, { orgId: OTHER_ORG }),
        ];
        for (const s of rows) await repo.saveScreening(s, completed(s));

        const got = await repo.findOutdatedLatestScreenings(ORG, current, 10);
        expect(got.map((s) => s.customerId)).toEqual(['c-missing', 'c-outdated']);
        expect(got[1]).toEqual(rows[3]);
      });

      it('honours the limit', async () => {
        const rows = [make('c-1', '2026-01-03T00:00:00.000Z', {}), make('c-2', '2026-01-01T00:00:00.000Z', {}), make('c-3', '2026-01-02T00:00:00.000Z', {})];
        for (const s of rows) await repo.saveScreening(s, completed(s));
        expect((await repo.findOutdatedLatestScreenings(ORG, current, 2)).map((s) => s.customerId)).toEqual(['c-2', 'c-3']);
      });

      it('finds nothing when there are no current versions to compare against', async () => {
        const s = make('c-1', '2026-01-01T00:00:00.000Z', { UN_SC: 'v1' });
        await repo.saveScreening(s, completed(s));
        expect(await repo.findOutdatedLatestScreenings(ORG, {}, 10)).toEqual([]);
      });
    });

    describe('applyBlacklistProjection', () => {
      it('applies a new projection', async () => {
        const p = projection();
        expect(await repo.applyBlacklistProjection(p, nextId())).toBe('APPLIED');
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([p]);
      });

      it('applies a newer change to an existing projection', async () => {
        const p = projection();
        await repo.applyBlacklistProjection(p, nextId());
        const newer = { ...p, name: 'Debtor One (updated)', reasonCode: 'OVERDUE_180', changedAt: T('2026-03-02T00:00:00.000Z') };
        expect(await repo.applyBlacklistProjection(newer, nextId())).toBe('APPLIED');
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([newer]);
      });

      it('reports DUPLICATE for a replayed event id without touching the data', async () => {
        const p = projection();
        const eventId = nextId();
        await repo.applyBlacklistProjection(p, eventId);
        const replay = { ...p, name: 'Changed', changedAt: T('2026-04-01T00:00:00.000Z') };
        expect(await repo.applyBlacklistProjection(replay, eventId)).toBe('DUPLICATE');
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([p]);
      });

      it('reports STALE for an older or equal changedAt, keeps the data, and still records the event', async () => {
        const p = projection({ changedAt: T('2026-03-05T00:00:00.000Z') });
        await repo.applyBlacklistProjection(p, nextId());
        const older = { ...p, name: 'Older', changedAt: T('2026-03-04T00:00:00.000Z') };
        const equal = { ...p, name: 'Equal' };
        const olderEvent = nextId();
        expect(await repo.applyBlacklistProjection(older, olderEvent)).toBe('STALE');
        expect(await repo.applyBlacklistProjection(equal, nextId())).toBe('STALE');
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([p]);
        expect(await repo.applyBlacklistProjection(older, olderEvent)).toBe('DUPLICATE');
      });

      it('ends with the newest change when events arrive concurrently and out of order', async () => {
        const older = projection({ name: 'Older', changedAt: T('2026-03-01T00:00:00.000Z') });
        const newer = { ...older, name: 'Newer', changedAt: T('2026-03-02T00:00:00.000Z') };
        await Promise.all([repo.applyBlacklistProjection(older, nextId()), repo.applyBlacklistProjection(newer, nextId())]);
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([newer]);
      });
    });

    describe('findBlacklistByRegisterHash', () => {
      it('returns active entries of the organisation for that hash only', async () => {
        const active1 = projection({ id: uid(1) });
        const active2 = projection({ id: uid(2), listType: 'FRAUD', reasonCode: 'FRAUD_CASE' });
        const inactive = projection({ id: uid(3), isActive: false });
        const otherOrg = projection({ id: uid(4), orgId: OTHER_ORG });
        const otherHash = projection({ id: uid(5), registerNoHash: 'hash-2' });
        for (const p of [active2, inactive, otherOrg, otherHash, active1]) await repo.applyBlacklistProjection(p, nextId());
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([active1, active2]);
        expect(await repo.findBlacklistByRegisterHash(ORG, 'unknown')).toEqual([]);
      });

      it('stops returning an entry once a newer change deactivates it', async () => {
        const p = projection();
        await repo.applyBlacklistProjection(p, nextId());
        await repo.applyBlacklistProjection({ ...p, isActive: false, changedAt: T('2026-03-02T00:00:00.000Z') }, nextId());
        expect(await repo.findBlacklistByRegisterHash(ORG, 'hash-1')).toEqual([]);
      });
    });
  });
}
