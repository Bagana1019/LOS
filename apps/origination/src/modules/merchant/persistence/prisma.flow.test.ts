import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantDashboard, PosLeaseAdminView, PosLeaseView, PosLeaseWithOtp, type PosScreeningRequest, type PosScreeningResponse } from '@los/contracts';
import { POS_CONFIG, loadPosConfig } from '../config/pos.config';
import { DemoPiiCipher } from '../integrations/demo-pii-cipher';
import { FixedOtpGenerator } from '../integrations/otp/fixed-otp.generator';
import { mockScreeningFor } from '../integrations/screening/mock-buyer-screening';
import { MockSmsGateway } from '../integrations/sms/mock-sms.gateway';
import { MerchantModule } from '../merchant.module';
import { BuyerScreeningPort, Clock, OtpGenerator, PiiCipher, SmsGateway } from '../ports';
import { MerchantService } from '../services/merchant.service';
import { PlanService } from '../services/plan.service';
import { dbTestGuard } from '../testing/db-test-guard';
import { parseWith } from '../testing/expect-schema';
import { FakeClock } from '../testing/fake-clock';
import { seedFixtures, leaseBody, type Fixtures } from '../testing/fixtures';
import { personasFor, type HeaderMap } from '../testing/personas';
import { PrismaModule, PrismaService } from '../../../prisma.service';

// Бодит Postgres дээрх HTTP урсгалын тест: Nest app (MerchantModule.register({ persistence: 'prisma' })) → controller → service → Prisma repository → DB.
// Санах ойн e2e-ээр илрэхгүй Postgres-д онцлог согог (pos_lease_version_check, P2002 уралдаан, relation шүүлт, numeric → number) энд баригдана.
//
// АЮУЛГҮЙ БАЙДАЛ: ЮУГ Ч TRUNCATE ХИЙХГҮЙ. Ажиллах бүрд өвөрмөц orgId (өөрийн мерчант, хөтөлбөр, лизинг) үүсгэх тул хуваалцсан өгөгдөл/outbox-д хүрэхгүй, давтан ажиллуулж болно.
// prisma.contract.test.ts-тэй ижил хаалт: DATABASE_URL тавигдсан БА (DB-ийн нэр тусдаа `test` үгтэй ЭСВЭЛ LOS_DB_TEST_ALLOW_TRUNCATE=1) үед л ажиллана, бусад үед алгасна.
//   TEST_DATABASE_URL=postgresql://…/los_test pnpm --filter @los/origination exec vitest run prisma.flow
const guard = dbTestGuard();
if (guard.skipReason) console.warn(`[prisma.flow] skipped: ${guard.skipReason}`);

const OTP = '123456'; // FixedOtpGenerator (DEMO_OTP)

/** Mock fixture-ийг тест бүрт өөрчилдөг лавлагаа. */
class ScriptedScreening extends BuyerScreeningPort {
  clock: Clock | null = null;
  patch: (r: PosScreeningResponse) => PosScreeningResponse = (r) => r;
  async screen(req: PosScreeningRequest): Promise<PosScreeningResponse> {
    return this.patch(mockScreeningFor(req.registerNo, this.clock?.now() ?? new Date('2026-10-28T04:00:00.000Z')));
  }
}

/** SMS: хаалга хаалттай үед илгээлт хүлээнэ (үүсгэгчийн SMS гацсан үеийн уралдаан). */
class GatedSms extends MockSmsGateway {
  attempts = 0;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  close(): void { this.gate = new Promise<void>((resolve) => { this.release = resolve; }); }
  open(): void { this.release?.(); this.gate = null; this.release = null; }
  override async send(toPhone: string, text: string): Promise<void> {
    this.attempts++;
    if (this.gate) await this.gate;
    return super.send(toPhone, text);
  }
}

type Res = { status: number; body: any; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe.skipIf(!guard.enabled)('postgres (prisma): merchant POS HTTP flow', () => {
  const orgId = `org-flow-${randomUUID().slice(0, 8)}`;
  const clock = new FakeClock();
  const screening = new ScriptedScreening();
  const sms = new GatedSms();
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixtures;
  let p: ReturnType<typeof personasFor>;
  let seed = 100;
  let keyN = 0;

  const http = async (method: 'get' | 'post' | 'patch', path: string, headers: HeaderMap, body?: unknown, extra: HeaderMap = {}): Promise<Res> => {
    let req = request(app.getHttpServer())[method](`/api${path}`).set({ ...headers, ...extra });
    if (body !== undefined) req = req.send(body);
    const res = await req;
    return { status: res.status, body: res.body, text: res.text };
  };
  const get = (path: string, headers: HeaderMap) => http('get', path, headers);
  const post = (path: string, headers: HeaderMap, body: unknown = {}, extra: HeaderMap = {}) => http('post', path, headers, body, extra);
  const patch = (path: string, headers: HeaderMap, body: unknown) => http('patch', path, headers, body);

  const staff = () => p.staff(fx.storeA1.id);
  const bm = (branchId: string) => p.branchManager(branchId);
  const reset = () => { screening.patch = (r) => r; };
  const create = (digit = 0, over: Record<string, unknown> = {}, key?: string, bodySeed?: number) =>
    post('/merchant-portal/leases', staff(), leaseBody(fx.storeA1.id, digit, over, bodySeed ?? seed++), { 'idempotency-key': key ?? `flow-key-${++keyN}-${randomUUID().slice(0, 8)}` });
  async function createOk(digit = 0, over: Record<string, unknown> = {}) {
    const res = await create(digit, over);
    expect(res.status, res.text).toBe(201);
    return parseWith(PosLeaseWithOtp, res.body).lease;
  }
  const submit = (id: string) => post(`/merchant-portal/leases/${id}/submit`, staff(), { otp: OTP });
  async function decided(digit = 0, over: Record<string, unknown> = {}) {
    const lease = await createOk(digit, over);
    const res = await submit(lease.id);
    expect(res.status, res.text).toBe(200);
    return parseWith(PosLeaseView, res.body);
  }
  async function accepted(digit = 0) {
    const lease = await decided(digit);
    expect(lease.status).toBe('APPROVED');
    clock.advanceSeconds(31);
    expect((await post(`/merchant-portal/leases/${lease.id}/otp/accept`, staff())).status).toBe(200);
    const res = await post(`/merchant-portal/leases/${lease.id}/accept`, staff(), { otp: OTP });
    expect(res.status, res.text).toBe(200);
    return parseWith(PosLeaseView, res.body);
  }
  const adminView = async (id: string) => {
    const res = await get(`/pos-leases/${id}`, p.lenderAdmin());
    expect(res.status, res.text).toBe(200);
    return parseWith(PosLeaseAdminView, res.body);
  };
  /** Энэ байгууллагын (өвөрмөц orgId) нэг лизингийн outbox event-үүд. */
  const outboxFor = async (leaseId: string) => (await prisma.outbox.findMany({ where: { payload: { path: ['leaseId'], equals: leaseId } } })).sort((a, b) => a.type.localeCompare(b.type));
  const dbLease = async (id: string) => (await prisma.posLease.findUnique({ where: { id } }))!;

  beforeAll(async () => {
    screening.clock = clock;
    const config = loadPosConfig({ NODE_ENV: 'test' });
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, MerchantModule.register({
        persistence: 'prisma', integrationMode: 'mock',
        overrides: [
          { provide: PiiCipher, useClass: DemoPiiCipher }, // DatabasePiiCipher PII_HASH_KEY шаардана; энд зөвхөн тестийн түлхүүргүй cipher
          { provide: Clock, useValue: clock }, { provide: OtpGenerator, useClass: FixedOtpGenerator }, { provide: BuyerScreeningPort, useValue: screening }, { provide: SmsGateway, useValue: sms },
          { provide: POS_CONFIG, useValue: config },
        ],
      })],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService, { strict: false });
    fx = await seedFixtures({ merchants: app.get(MerchantService, { strict: false }), plans: app.get(PlanService, { strict: false }) }, orgId);
    p = personasFor(fx.merchantA.id, orgId);
  });
  afterAll(async () => { await app?.close(); });
  // prisma.contract.test.ts тест бүрийн өмнө ЭНЭ ИЖИЛ DB-ийн merchant POS хүснэгтүүдийг TRUNCATE хийдэг. Хоёр файлыг зэрэг ажиллуулбал (vitest-ийн анхдагч file parallelism) манай мерчант устаж
  // 404/500 гэх мэт төөрөгдүүлэх алдаа гарна → шалтгааныг шууд хэлнэ. Persistence тестүүдийг дараалуулж ажиллуулна: `vitest run --no-file-parallelism --config …/persistence/vitest.config.ts`.
  beforeEach(async () => {
    const alive = await prisma.merchant.count({ where: { orgId } });
    if (alive === 0) throw new Error('the fixtures of this suite were deleted: prisma.contract.test.ts TRUNCATEs the same tables. Run the persistence tests sequentially (--no-file-parallelism / fileParallelism: false).');
  });

  // ───────────── n=0: лизинг version 1-ээр үүсч, save бүр +1 ─────────────
  let settledId = '';
  it('create → consent → submit (APPROVED) → accept → deliver → settle: every step persists, timeline/OTP/outbox are consistent', async () => {
    reset();
    const created = await create(0);
    expect(created.status, created.text).toBe(201); // version 0 бол pos_lease_version_check зөрчиж 500 болдог байсан
    const { lease, otp } = parseWith(PosLeaseWithOtp, created.body);
    expect(otp.purpose).toBe('CONSENT');
    expect((await dbLease(lease.id)).version).toBe(1);

    const approved = parseWith(PosLeaseView, (await submit(lease.id)).body);
    expect(approved).toMatchObject({ status: 'APPROVED', decision: { result: 'APPROVE', decidedBy: 'SYSTEM' }, buyer: { fullName: 'Тест Харилцагч' } });

    clock.advanceSeconds(31);
    expect((await post(`/merchant-portal/leases/${lease.id}/otp/accept`, staff())).status).toBe(200);
    const acc = await post(`/merchant-portal/leases/${lease.id}/accept`, staff(), { otp: OTP });
    expect(parseWith(PosLeaseView, acc.body).status, acc.text).toBe('ACCEPTED');
    clock.advanceMinutes(5);
    const del = await post(`/merchant-portal/leases/${lease.id}/deliver`, staff(), { serialNo: 'SN-FLOW-1' });
    expect(parseWith(PosLeaseView, del.body)).toMatchObject({ status: 'DELIVERED', goods: { serialNo: 'SN-FLOW-1' } });
    const settled = await post(`/pos-leases/${lease.id}/settle`, p.lenderAdmin(), { settlementRef: 'PAY-FLOW-0001' });
    expect(parseWith(PosLeaseAdminView, settled.body)).toMatchObject({ status: 'SETTLED', review: { settlementRef: 'PAY-FLOW-0001' } });
    settledId = lease.id;

    // DB: version = 1 + хадгалалт бүр = timeline-ийн мөр бүр; мөнгөн багана numeric(18,2)
    const row = await dbLease(lease.id);
    const events = await prisma.posLeaseEvent.findMany({ where: { leaseId: lease.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    expect(events.map((e) => e.action)).toEqual(['CREATED', 'CONSENT_VERIFIED', 'DECIDED', 'ACCEPTED', 'DELIVERED', 'SETTLED']);
    expect(row.version).toBe(events.length);
    expect(row).toMatchObject({ status: 'SETTLED', orgId, branchId: 'BR-X', settlementRef: 'PAY-FLOW-0001', buyerLastName: 'Тест', buyerFirstName: 'Харилцагч' });
    expect(row.financedAmount.toString()).toBe('2400000');
    expect(row.merchantNetAmount.toString()).toBe('2328000');
    expect(events.map((e) => e.actorLabel)).toEqual(['MERCHANT:staff-1', 'BUYER', 'SYSTEM', 'BUYER', 'MERCHANT:staff-1', 'LENDER:lender-admin-1']);

    // OTP: хоёр зорилго, код өөрөө хадгалагдаагүй (hash л)
    const otps = await prisma.posLeaseOtp.findMany({ where: { leaseId: lease.id }, orderBy: { sentAt: 'asc' } });
    expect(otps.map((o) => o.purpose)).toEqual(['CONSENT', 'ACCEPT']);
    expect(otps.every((o) => o.verifiedAt !== null && o.codeHash.length === 64)).toBe(true);
    expect(JSON.stringify(otps)).not.toContain(OTP);

    // outbox: нэг tx-д бичигдсэн 4 event; PII-гүй
    const outbox = await outboxFor(lease.id);
    expect(outbox.map((o) => o.type)).toEqual(['PosLeaseAccepted', 'PosLeaseDecided', 'PosLeaseDelivered', 'PosLeaseSettled']);
    expect(outbox.every((o) => (o.payload as { orgId: string }).orgId === orgId)).toBe(true);
    const payloads = JSON.stringify(outbox.map((o) => o.payload));
    expect(payloads).not.toMatch(/9911\d{4}|УЕ9005|Харилцагч/);

    // merchant харагдац: зөвхөн дүр; back-office: бүтэн actor
    const merchantView = parseWith(PosLeaseView, (await get(`/merchant-portal/leases/${lease.id}`, staff())).body);
    expect(merchantView.timeline.map((e) => e.actor)).toEqual(['MERCHANT', 'BUYER', 'SYSTEM', 'BUYER', 'MERCHANT', 'LENDER']);
    expect((await adminView(lease.id)).timeline.map((e) => e.actor)).toEqual(['MERCHANT:staff-1', 'BUYER', 'SYSTEM', 'BUYER', 'MERCHANT:staff-1', 'LENDER:lender-admin-1']);
  });

  it('the database really enforces pos_lease_version_check (version >= 1)', async () => {
    const err = await prisma.$executeRawUnsafe('UPDATE origination.pos_lease SET version = 0 WHERE id = $1::uuid', settledId).then(() => '', (e: unknown) => String(e));
    expect(err).toContain('pos_lease_version_check');
    expect((await dbLease(settledId)).version).toBeGreaterThanOrEqual(1);
  });

  // ───────────── REFER → хянах ─────────────
  it('REFER → BRANCH_MANAGER of the merchant branch approves → the buyer can accept', async () => {
    reset();
    const referred = await decided(2); // хар жагсаалт → REFER
    expect(referred).toMatchObject({ status: 'REFERRED', decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW' } });
    expect((await adminView(referred.id)).review.reasons.map((r) => r.code)).toContain('BLACKLISTED');
    expect((await post(`/pos-leases/${referred.id}/review`, bm('BR-Y'), { decision: 'APPROVE', comment: 'Өөр салбар' })).status).toBe(404);
    const reviewed = await post(`/pos-leases/${referred.id}/review`, bm('BR-X'), { decision: 'APPROVE', comment: 'Баримтыг шалгаж баталлаа' });
    expect(parseWith(PosLeaseAdminView, reviewed.body)).toMatchObject({ status: 'APPROVED', decision: { decidedBy: 'REVIEWER' } });
    expect(reviewed.body.timeline.at(-1).actor).toBe('LENDER:branch-manager-1');
    expect((await outboxFor(referred.id)).map((o) => o.type)).toEqual(['PosLeaseDecided', 'PosLeaseDecided']);
    clock.advanceSeconds(31);
    expect((await post(`/merchant-portal/leases/${referred.id}/otp/accept`, staff())).status).toBe(200);
    expect((await post(`/merchant-portal/leases/${referred.id}/accept`, staff(), { otp: OTP })).status).toBe(200);
  });

  // ───────────── цуцлах ─────────────
  it('cancel persists the reason and writes one PosLeaseCancelled event; a second cancel is rejected', async () => {
    reset();
    const lease = await createOk(0);
    const res = await post(`/merchant-portal/leases/${lease.id}/cancel`, staff(), { reason: 'Худалдан авагч татгалзав' });
    expect(parseWith(PosLeaseView, res.body)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Худалдан авагч татгалзав' });
    expect((await post(`/merchant-portal/leases/${lease.id}/cancel`, staff(), { reason: 'Дахин цуцлах' })).status).toBeGreaterThanOrEqual(400);
    expect((await outboxFor(lease.id)).map((o) => o.type)).toEqual(['PosLeaseCancelled']);
    expect(await prisma.posLeaseEvent.count({ where: { leaseId: lease.id, action: 'CANCELLED' } })).toBe(1);
  });

  // ───────────── n=2: баталгаажаагүй суваг ─────────────
  it('unverified consent channel on Postgres: REFERRED / MANUAL_REVIEW, no buyer name stored or shown, internal reasons kept', async () => {
    reset();
    screening.patch = (r) => ({ ...r, identity: { ...r.identity, phoneMatches: false } });
    const view = await decided(3); // DPD 120
    expect(view).toMatchObject({ status: 'REFERRED', buyer: { fullName: null }, decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW', suggestedMinDownPayment: null } });
    const row = await dbLease(view.id);
    expect(row).toMatchObject({ buyerLastName: null, buyerFirstName: null, decision: 'REFER' });
    expect(JSON.stringify(row.decisionReasonsJson)).toMatch(/PHONE_MISMATCH/);
    expect(JSON.stringify(row.decisionReasonsJson)).toMatch(/DPD_EXCEEDED/);
    const list = await get('/merchant-portal/leases?pageSize=100', staff());
    expect(list.body.items.find((i: { id: string }) => i.id === view.id)).toMatchObject({ buyerName: null, publicReason: 'MANUAL_REVIEW' });
    reset();
  });

  // ───────────── n=13: зэрэгцээ ижил түлхүүр ─────────────
  it('parallel creates with the same Idempotency-Key: one 201, the rest 200 replays, exactly one lease row, one OTP row and one SMS (never 429/500)', async () => {
    reset();
    const key = `flow-concurrent-${randomUUID().slice(0, 8)}`;
    const attemptsBefore = sms.attempts;
    const sentBefore = sms.sent.length;
    const mySeed = seed++;
    sms.close();
    let results: Res[] = [];
    try {
      const all = Promise.all(Array.from({ length: 8 }, () => create(0, {}, key, mySeed)));
      await waitFor(() => sms.attempts > attemptsBefore, 'the creator to reach the SMS gateway');
      await new Promise<void>((resolve) => setTimeout(resolve, 150)); // бусад хүсэлт unique зөрчил → replay хийх цонх
      sms.open();
      results = await all;
    } finally {
      sms.open();
    }
    expect(results.map((r) => r.status).sort(), results.map((r) => r.text).join('\n')).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => r.body.lease.id as string));
    expect(ids.size).toBe(1);
    const [leaseId] = [...ids];
    expect(await prisma.posLease.count({ where: { orgId, idempotencyKey: key } })).toBe(1);
    expect(await prisma.posLeaseOtp.count({ where: { leaseId } })).toBe(1);
    expect(sms.attempts - attemptsBefore).toBe(1);
    expect(sms.sent.length - sentBefore).toBe(1);
    expect(await prisma.posLeaseEvent.count({ where: { leaseId } })).toBe(1);
    expect((await post(`/merchant-portal/leases/${leaseId}/submit`, staff(), { otp: OTP })).status).toBe(200);
  });

  // ───────────── n=4: салбар = мерчантын ОДООГИЙН салбар ─────────────
  it("BRANCH_MANAGER scope follows the merchant's current branch (relation filter in find/list/dashboard); the lease snapshot stays", async () => {
    reset();
    const lease = await decided(5); // PEP → REFER
    expect(lease.status).toBe('REFERRED');
    const ids = async (branchId: string) => ((await get('/pos-leases?pageSize=100', bm(branchId))).body.items as Array<{ id: string }>).map((i) => i.id);
    expect(await ids('BR-X')).toContain(lease.id);
    expect(await ids('BR-Z')).not.toContain(lease.id);
    try {
      expect((await patch(`/merchants/${fx.merchantA.id}`, p.lenderAdmin(), { branchId: 'BR-Z' })).status).toBe(200);
      expect((await get(`/pos-leases/${lease.id}`, bm('BR-X'))).status).toBe(404);
      expect(await ids('BR-X')).not.toContain(lease.id);
      expect((await get(`/pos-leases?merchantId=${fx.merchantA.id}`, bm('BR-X'))).body.total).toBe(0);
      expect((await post(`/pos-leases/${lease.id}/review`, bm('BR-X'), { decision: 'APPROVE', comment: 'Хуучин салбар' })).status).toBe(404);
      expect((await get(`/pos-leases/${lease.id}`, bm('BR-Z'))).status).toBe(200);
      expect(await ids('BR-Z')).toContain(lease.id);
      expect((await post(`/pos-leases/${lease.id}/review`, bm('BR-Z'), { decision: 'DECLINE', comment: 'Шинэ салбар татгалзав' })).status).toBe(200);
      expect((await dbLease(lease.id)).branchId).toBe('BR-X'); // түүхэн хуулбар
      const fresh = await createOk(0);
      expect((await dbLease(fresh.id)).branchId).toBe('BR-Z'); // шинэ лизинг одоогийн салбарыг хуулна
    } finally {
      expect((await patch(`/merchants/${fx.merchantA.id}`, p.lenderAdmin(), { branchId: 'BR-X' })).status).toBe(200);
    }
    expect((await get(`/pos-leases/${lease.id}`, bm('BR-X'))).status).toBe(200);
  });

  // ───────────── n=14: dashboard, жагсаалт ─────────────
  it('dashboard: funnel counts vs live money (ACCEPTED then CANCELLED is counted as accepted but not financed); Postgres numeric sums', async () => {
    reset();
    const dashboard = async () => {
      const res = await get('/merchant-portal/dashboard', p.merchantAdmin());
      expect(res.status, res.text).toBe(200);
      return parseWith(MerchantDashboard, res.body);
    };
    const before = await dashboard();
    await accepted(0); // ACCEPTED: мөнгөн дүнд орно
    const cancelledAfterAccept = await accepted(0);
    const cancel = await post(`/merchant-portal/leases/${cancelledAfterAccept.id}/cancel`, staff(), { reason: 'Худалдан авагч татгалзав' });
    expect(parseWith(PosLeaseView, cancel.body).status).toBe('CANCELLED');

    const dash = await dashboard();
    // хоёр лизинг хүлээн зөвшөөрөгдсөн (funnel +2) боловч зөвхөн цуцлагдаагүй нь санхүүжилтэд (+2,400,000 / +3,000,000)
    expect(dash.totals.requests - before.totals.requests).toBe(2);
    expect(dash.totals.accepted - before.totals.accepted).toBe(2);
    expect(dash.totals.financedAmount - before.totals.financedAmount).toBe(2_400_000);
    expect(dash.totals.goodsSalesAmount - before.totals.goodsSalesAmount).toBe(3_000_000);
    expect(dash.totals.cancelledOrExpired - before.totals.cancelledOrExpired).toBe(1);
    expect(dash.totals).toMatchObject({ delivered: 1, settled: 1, commissionAmount: 72_000, settledNet: 2_328_000, awaitingSettlementNet: 0 });
    // Postgres-ийн үнэн: ACCEPTED/DELIVERED/SETTLED төлөвтэй мөрүүдийн numeric(18,2) нийлбэр dashboard-той тэнцүү
    const truth = await prisma.posLease.aggregate({ _sum: { financedAmount: true, goodsPrice: true }, _count: true, where: { orgId, status: { in: ['ACCEPTED', 'DELIVERED', 'SETTLED'] } } });
    expect(dash.totals.financedAmount).toBe(Number(truth._sum.financedAmount));
    expect(dash.totals.goodsSalesAmount).toBe(Number(truth._sum.goodsPrice));
    expect(dash.limits.dailyUsedAmount).toBe(dash.totals.financedAmount); // POS-BR-9: өдрийн лимитийн ашиглалттай нэг багц
    expect(dash.todo.awaitingDelivery).toBe(truth._count - 1); // ACCEPTED (SETTLED нь хүрээнээс гарсан)
    expect(dash.byStore.find((x) => x.storeId === fx.storeA1.id)!.financedAmount).toBe(dash.totals.financedAmount);
    expect(dash.byPlan.find((x) => x.planCode === 'LAPTOP')!.financedAmount).toBe(dash.totals.financedAmount);
    expect(dash.daily.reduce((sum, d) => sum + d.financedAmount, 0)).toBe(dash.totals.financedAmount);

    // жагсаалт ба dashboard ижил тоо; lender талын жагсаалт мөн адил
    const list = await get('/merchant-portal/leases?pageSize=100', staff());
    expect(dash.totals.requests).toBe(list.body.total);
    const adminList = await get(`/pos-leases?merchantId=${fx.merchantA.id}&pageSize=100`, p.lenderAdmin());
    expect(adminList.body.total).toBe(list.body.total);
    const settledOnly = await get('/pos-leases?status=SETTLED', p.lenderAdmin());
    expect(settledOnly.body.items.map((i: { id: string }) => i.id)).toEqual([settledId]);
    const search = await get(`/merchant-portal/leases?q=${encodeURIComponent((await adminView(settledId)).leaseNo)}`, staff());
    expect(search.body.total).toBe(1);
  });
});
