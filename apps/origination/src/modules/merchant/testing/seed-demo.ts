/**
 * DEMO ONLY — `scripts/merchant-demo.ts`-д зориулсан өгөгдөл үүсгэгч.
 * Бүх өгөгдөл зохиомол (мерчант, худалдан авагч, регистр, утас). Production-д ашиглахгүй.
 * Бүх бичилт жинхэнэ service-ээр (бизнес дүрэм, event, timeline-тай) дамждаг; зөвхөн цагийг DemoClock-оор ухраадаг.
 */
import { PosLeaseCreate, type PosLeaseView } from '@los/contracts';
import { DEMO_OTP } from '../integrations/otp/fixed-otp.generator';
import { addMinutes, addSeconds, DAY_MS, mnStartOfDay } from '../common/time';
import { Clock } from '../ports';
import type { DashboardService } from '../services/dashboard.service';
import type { LeaseService } from '../services/lease.service';
import type { MerchantService } from '../services/merchant.service';
import type { PlanService } from '../services/plan.service';
import { adminContext, buyerPhone, buyerRegister, seedFixtures, storeInput, type Fixtures } from './fixtures';
import { personasFor, toContext } from './personas';

export const DEMO_ORG_ID = 'org-demo';
/** Demo хэрэглэгчдийн ID (seed болон cookie persona-д ижил) */
export const DEMO_USERS = {
  cashier1: 'demo-cashier-1', cashier2: 'demo-cashier-2', cashierB: 'demo-cashier-b', merchantAdmin: 'demo-merchant-admin',
  lenderAdmin: 'demo-lender-admin', approver: 'demo-approver',
} as const;

/** Seed хийх үед цагийг ухраана; дууссаны дараа жинхэнэ цаг руу шилжинэ. */
export class DemoClock extends Clock {
  private fixed: Date | null = null;
  now(): Date { return this.fixed ? new Date(this.fixed.getTime()) : new Date(); }
  freeze(at: Date): this { this.fixed = new Date(at.getTime()); return this; }
  advanceSeconds(s: number): this { if (this.fixed) this.fixed = addSeconds(this.fixed, s); return this; }
  advanceMinutes(m: number): this { if (this.fixed) this.fixed = addMinutes(this.fixed, m); return this; }
  live(): this { this.fixed = null; return this; }
}

export interface DemoServices { merchants: MerchantService; plans: PlanService; leases: LeaseService; dashboard: DashboardService }

type Outcome = 'SETTLED' | 'DELIVERED' | 'ACCEPTED' | 'APPROVED' | 'REFERRED' | 'REFERRED_THEN_SETTLED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'DRAFT';
type Place = 'A1' | 'A2' | 'B1' | 'B2';
interface When { daysAgo?: number; hourMn?: number; minutesAgo?: number }
interface Spec {
  when: When; place: Place; outcome: Outcome; plan: 'LAPTOP' | 'PROMO0' | 'GAMES'; digit: number;
  goods: { category: string; name: string; price: number }; down: number; term: number;
}

const L = (name: string, price: number, category = 'COMPUTER') => ({ category, name, price });
const SPECS: Spec[] = [
  // 14 хоногийн түүх (хаагдсан / дууссан)
  { when: { daysAgo: 13, hourMn: 11 }, place: 'A1', outcome: 'SETTLED', plan: 'LAPTOP', digit: 0, goods: L('Зөөврийн компьютер 15"', 3_200_000), down: 640_000, term: 12 },
  { when: { daysAgo: 12, hourMn: 14 }, place: 'B1', outcome: 'SETTLED', plan: 'PROMO0', digit: 9, goods: L('Ухаалаг утас', 1_800_000, 'PHONE_TABLET'), down: 360_000, term: 6 },
  { when: { daysAgo: 11, hourMn: 12 }, place: 'A2', outcome: 'DECLINED', plan: 'LAPTOP', digit: 3, goods: L('Тоглоомын зөөврийн компьютер', 5_400_000), down: 1_080_000, term: 18 },
  { when: { daysAgo: 10, hourMn: 16 }, place: 'A1', outcome: 'SETTLED', plan: 'GAMES', digit: 0, goods: L('Тоглоомын консол', 1_650_000, 'GAMES'), down: 330_000, term: 6 },
  { when: { daysAgo: 9, hourMn: 10 }, place: 'B2', outcome: 'CANCELLED', plan: 'LAPTOP', digit: 0, goods: L('Хөргөгч', 2_700_000, 'HOME_APPLIANCE'), down: 540_000, term: 12 },
  { when: { daysAgo: 9, hourMn: 15 }, place: 'A1', outcome: 'REFERRED_THEN_SETTLED', plan: 'LAPTOP', digit: 2, goods: L('Зөөврийн компьютер 14"', 3_900_000), down: 780_000, term: 12 },
  { when: { daysAgo: 8, hourMn: 13 }, place: 'B1', outcome: 'SETTLED', plan: 'LAPTOP', digit: 0, goods: L('Угаалгын машин', 2_300_000, 'HOME_APPLIANCE'), down: 460_000, term: 18 },
  { when: { daysAgo: 7, hourMn: 11 }, place: 'A2', outcome: 'SETTLED', plan: 'PROMO0', digit: 0, goods: L('Таблет', 1_400_000, 'PHONE_TABLET'), down: 280_000, term: 3 },
  { when: { daysAgo: 6, hourMn: 17 }, place: 'A1', outcome: 'EXPIRED', plan: 'LAPTOP', digit: 0, goods: L('Зөөврийн компьютер 13"', 2_900_000), down: 580_000, term: 12 },
  { when: { daysAgo: 6, hourMn: 12 }, place: 'B2', outcome: 'DECLINED', plan: 'LAPTOP', digit: 3, goods: L('Телевиз 55"', 2_600_000, 'ELECTRONICS'), down: 520_000, term: 12 },
  { when: { daysAgo: 5, hourMn: 14 }, place: 'A1', outcome: 'DELIVERED', plan: 'LAPTOP', digit: 0, goods: L('Зөөврийн компьютер 16"', 4_500_000), down: 900_000, term: 24 },
  { when: { daysAgo: 5, hourMn: 16 }, place: 'B1', outcome: 'SETTLED', plan: 'GAMES', digit: 9, goods: L('Дугуй (хобби)', 2_100_000, 'SPORT_OUTDOOR'), down: 420_000, term: 12 },
  { when: { daysAgo: 4, hourMn: 10 }, place: 'A2', outcome: 'CANCELLED', plan: 'PROMO0', digit: 0, goods: L('Ухаалаг цаг', 900_000, 'ELECTRONICS'), down: 180_000, term: 6 },
  { when: { daysAgo: 4, hourMn: 15 }, place: 'A1', outcome: 'DELIVERED', plan: 'LAPTOP', digit: 0, goods: L('Ухаалаг утас Pro', 3_600_000, 'PHONE_TABLET'), down: 720_000, term: 12 },
  { when: { daysAgo: 3, hourMn: 11 }, place: 'B1', outcome: 'DECLINED', plan: 'LAPTOP', digit: 3, goods: L('Зөөврийн компьютер 15"', 3_000_000), down: 600_000, term: 12 },
  { when: { daysAgo: 3, hourMn: 13 }, place: 'A1', outcome: 'SETTLED', plan: 'LAPTOP', digit: 0, goods: L('Агааржуулагч', 2_800_000, 'HOME_APPLIANCE'), down: 560_000, term: 12 },
  { when: { daysAgo: 2, hourMn: 12 }, place: 'A2', outcome: 'EXPIRED', plan: 'GAMES', digit: 0, goods: L('Тоглоомын хүрээ, дэлгэц', 1_200_000, 'GAMES'), down: 240_000, term: 6 },
  { when: { daysAgo: 2, hourMn: 16 }, place: 'B2', outcome: 'DELIVERED', plan: 'LAPTOP', digit: 0, goods: L('Шоо тоглоомын компьютер', 4_100_000), down: 820_000, term: 18 },
  { when: { daysAgo: 1, hourMn: 11 }, place: 'A1', outcome: 'CANCELLED', plan: 'LAPTOP', digit: 0, goods: L('Зөөврийн компьютер 14"', 3_400_000), down: 680_000, term: 12 },
  { when: { daysAgo: 1, hourMn: 15 }, place: 'B1', outcome: 'SETTLED', plan: 'PROMO0', digit: 0, goods: L('Хөгжмийн систем', 1_950_000, 'ELECTRONICS'), down: 390_000, term: 6 },
  // Сүүлийн цагууд (нээлттэй) — демо дээр шууд үргэлжлүүлэх боломжтой
  { when: { minutesAgo: 190 }, place: 'A1', outcome: 'ACCEPTED', plan: 'LAPTOP', digit: 0, goods: L('Зөөврийн компьютер 15"', 3_100_000), down: 620_000, term: 12 },
  { when: { minutesAgo: 120 }, place: 'A2', outcome: 'REFERRED', plan: 'LAPTOP', digit: 2, goods: L('Зөөврийн компьютер 14"', 3_700_000), down: 740_000, term: 12 },
  { when: { minutesAgo: 60 }, place: 'B1', outcome: 'REFERRED', plan: 'LAPTOP', digit: 5, goods: L('Зөөврийн компьютер 13"', 2_800_000), down: 560_000, term: 12 },
  { when: { minutesAgo: 12 }, place: 'A1', outcome: 'APPROVED', plan: 'LAPTOP', digit: 0, goods: L('Таблет Pro', 2_400_000, 'PHONE_TABLET'), down: 480_000, term: 12 },
  { when: { minutesAgo: 6 }, place: 'A1', outcome: 'DRAFT', plan: 'GAMES', digit: 0, goods: L('Тоглоомын компьютер', 3_000_000, 'GAMES'), down: 600_000, term: 12 },
];

export interface DemoSeedResult {
  fixtures: Fixtures;
  storeB2Id: string;
  leases: number;
  byStatus: Record<string, number>;
}

/** 2 мерчант × 2 дэлгүүр, 3 хөтөлбөр, ~25 лизинг (сүүлийн 14 хоног). Дууссаны дараа цаг жинхэнэ болно. */
export async function seedDemo(svc: DemoServices, clock: DemoClock, orgId: string = DEMO_ORG_ID): Promise<DemoSeedResult> {
  const realNow = new Date();
  const fx = await seedFixtures(svc, orgId);
  const admin = adminContext(orgId);
  const storeB2 = await svc.merchants.createStore(admin, fx.merchantB.id, storeInput({ code: 'B-STORE-2', name: 'Алтан Гэр салбар', address: { city: 'Улаанбаатар', district: 'Баянгол', detail: 'Нарны зам 12' }, phone: '77003344' }));

  const pA = personasFor(fx.merchantA.id, orgId);
  const pB = personasFor(fx.merchantB.id, orgId);
  const ctx = {
    A1: toContext(pA.staff(fx.storeA1.id, DEMO_USERS.cashier1), 'demo-seed'),
    A2: toContext(pA.staff(fx.storeA2.id, DEMO_USERS.cashier2), 'demo-seed'),
    B1: toContext(pB.staff(fx.storeB1.id, DEMO_USERS.cashierB), 'demo-seed'),
    B2: toContext(pB.staff(storeB2.id, DEMO_USERS.cashierB), 'demo-seed'),
  } satisfies Record<Place, ReturnType<typeof toContext>>;
  const storeIds: Record<Place, string> = { A1: fx.storeA1.id, A2: fx.storeA2.id, B1: fx.storeB1.id, B2: storeB2.id };
  const lender = toContext(pA.lenderAdmin(DEMO_USERS.lenderAdmin), 'demo-seed');
  const approver = toContext(pA.approver(DEMO_USERS.approver), 'demo-seed');

  const at = (w: When): Date => (w.minutesAgo !== undefined
    ? addMinutes(realNow, -w.minutesAgo)
    : new Date(mnStartOfDay(new Date(realNow.getTime() - (w.daysAgo ?? 0) * DAY_MS)).getTime() + (w.hourMn ?? 12) * 3_600_000));
  const ordered = SPECS.map((spec, index) => ({ spec, index, time: at(spec.when) })).sort((a, b) => a.time.getTime() - b.time.getTime() || a.index - b.index);

  for (const { spec, index, time } of ordered) {
    clock.freeze(time);
    const c = ctx[spec.place];
    const body = PosLeaseCreate.parse({
      planCode: spec.plan, storeId: storeIds[spec.place], goods: { ...spec.goods, serialNo: `DEMO-SN-${String(index + 1).padStart(4, '0')}` }, downPayment: spec.down, termMonths: spec.term,
      buyer: { registerNo: buyerRegister(spec.digit, 100 + index), phone: buyerPhone(100 + index) },
    });
    const { result } = await svc.leases.createLease(c, `demo-seed-${String(index + 1).padStart(4, '0')}`, body);
    await advance(svc, clock, c, lender, approver, result.lease, spec);
  }

  clock.live();
  await svc.leases.expireStale(); // хугацаа хэтэрсэн DRAFT/APPROVED → EXPIRED (event-тэй)

  const page = await svc.leases.listForBackOffice(lender, { page: 1, pageSize: 100 });
  const byStatus: Record<string, number> = {};
  for (const item of page.items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  return { fixtures: fx, storeB2Id: storeB2.id, leases: page.total, byStatus };
}

async function advance(
  svc: DemoServices, clock: DemoClock, c: ReturnType<typeof toContext>, lender: ReturnType<typeof toContext>, approver: ReturnType<typeof toContext>,
  created: PosLeaseView, spec: Spec,
): Promise<void> {
  if (spec.outcome === 'DRAFT') return;
  clock.advanceSeconds(40);
  const lease = await svc.leases.submit(c, created.id, { otp: DEMO_OTP });
  if (spec.outcome === 'EXPIRED') return; // APPROVED хэвээр, хугацаа нь өнгөрсөн → expireStale
  if (spec.outcome === 'DECLINED' || spec.outcome === 'REFERRED') return;
  if (lease.status === 'REFERRED') {
    clock.advanceMinutes(8);
    await svc.leases.review(approver, created.id, { decision: 'APPROVE', comment: 'Баримт бичгийг шалгаж баталлаа' });
  }
  if (spec.outcome === 'CANCELLED') {
    clock.advanceMinutes(5);
    await svc.leases.cancel(c, created.id, { reason: 'Худалдан авагч шийдвэрээ өөрчилсөн' });
    return;
  }
  if (spec.outcome === 'APPROVED') return;
  clock.advanceSeconds(40);
  await svc.leases.requestAcceptOtp(c, created.id);
  clock.advanceSeconds(40);
  await svc.leases.accept(c, created.id, { otp: DEMO_OTP });
  if (spec.outcome === 'ACCEPTED') return;
  clock.advanceMinutes(30);
  await svc.leases.deliver(c, created.id, {});
  if (spec.outcome === 'DELIVERED') return;
  clock.advanceMinutes(24 * 60);
  await svc.leases.settle(lender, created.id, { settlementRef: `DEMO-PAY-${created.leaseNo}` });
}
