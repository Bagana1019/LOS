import { MerchantCreate, PlanCreate, StoreCreate, type MerchantView, type PlanView, type StoreView } from '@los/contracts';
import type { RequestContext } from '../common/request-context';
import type { MerchantService } from '../services/merchant.service';
import type { PlanService } from '../services/plan.service';
import { TEST_ORG_ID } from './personas';

/** Fixture/seed-ийг service-ээр дамжуулан үүсгэх ADMIN контекст. */
export const adminContext = (orgId: string = TEST_ORG_ID): RequestContext => ({
  userId: 'fixture-admin', roles: ['ADMIN'], orgId, branchId: 'BR-HQ', merchantId: null, storeId: null, correlationId: 'fixture',
});

export const merchantInput = (over: Partial<Record<string, unknown>> = {}) => MerchantCreate.parse({
  code: 'TEMUULEL', name: 'Тэмүүлэл Дижитал', legalName: 'Тэмүүлэл Дижитал ХХК', companyRegisterNo: '1234567', category: 'COMPUTER', contactName: 'Д. Тэмүүлэн', phone: '99110011',
  branchId: 'BR-X', commissionRate: 0.03, maxTicketAmount: 15_000_000, dailyLimitAmount: 50_000_000,
  settlement: { bankCode: 'KHAN', accountNo: '5012345678', holderName: 'Тэмүүлэл Дижитал ХХК' }, ...over,
});

export const storeInput = (over: Partial<Record<string, unknown>> = {}) => StoreCreate.parse({
  code: 'STORE-1', name: 'Төв дэлгүүр', address: { city: 'Улаанбаатар', district: 'Сүхбаатар', detail: 'Энхтайвны өргөн чөлөө 1' }, phone: '77001122', ...over,
});

export const laptopPlanInput = (over: Partial<Record<string, unknown>> = {}) => PlanCreate.parse({
  code: 'LAPTOP', name: 'Зөөврийн компьютер лизинг', goodsCategories: ['COMPUTER', 'PHONE_TABLET', 'ELECTRONICS', 'HOME_APPLIANCE'], minAmount: 300_000, maxAmount: 20_000_000,
  termOptions: [6, 12, 18, 24], annualRate: 0.24, feeRate: 0.01, minDownPaymentRate: 0.1, ...over,
});

export interface Fixtures {
  merchantA: MerchantView;
  storeA1: StoreView;
  storeA2: StoreView;
  merchantB: MerchantView;
  storeB1: StoreView;
  laptop: PlanView;
  promo: PlanView;
  games: PlanView;
}

/** Мерчант A (салбар BR-X, 2 дэлгүүр), мерчант B (салбар BR-Y, 1 дэлгүүр), 3 хөтөлбөр. Хоёр мерчант ACTIVE. */
export async function seedFixtures(svc: { merchants: MerchantService; plans: PlanService }, orgId: string = TEST_ORG_ID): Promise<Fixtures> {
  const admin = adminContext(orgId);
  const activate = async (id: string) => svc.merchants.changeStatus(admin, id, { status: 'ACTIVE', reason: 'Fixture activation' });

  const a = await svc.merchants.create(admin, merchantInput());
  const storeA1 = await svc.merchants.createStore(admin, a.id, storeInput());
  const storeA2 = await svc.merchants.createStore(admin, a.id, storeInput({ code: 'STORE-2', name: 'Салбар дэлгүүр', address: { city: 'Улаанбаатар', detail: 'Хан-Уул дүүрэг 5' } }));
  const merchantA = await activate(a.id);

  const b = await svc.merchants.create(admin, merchantInput({ code: 'ALTAN-GER', name: 'Алтан Гэр Бараа', legalName: 'Алтан Гэр Бараа ХХК', branchId: 'BR-Y', phone: '99220022', category: 'HOME_APPLIANCE', settlement: { bankCode: 'GOLOMT', accountNo: '1105009911', holderName: 'Алтан Гэр Бараа ХХК' } }));
  const storeB1 = await svc.merchants.createStore(admin, b.id, storeInput({ code: 'B-STORE-1', name: 'Алтан Гэр төв' }));
  const merchantB = await activate(b.id);

  const laptop = await svc.plans.create(admin, laptopPlanInput());
  const promo = await svc.plans.create(admin, laptopPlanInput({ code: 'PROMO0', name: '0% урамшуулал', termOptions: [3, 6], annualRate: 0, feeRate: 0.02, minDownPaymentRate: 0.2 }));
  const games = await svc.plans.create(admin, laptopPlanInput({ code: 'GAMES', name: 'Тоглоом, хобби', goodsCategories: ['GAMES', 'SPORT_OUTDOOR', 'OTHER'], minAmount: 100_000, maxAmount: 5_000_000, termOptions: [3, 6, 12], annualRate: 0.3 }));
  return { merchantA, storeA1, storeA2, merchantB, storeB1, laptop, promo, games };
}

/** Регистр: сүүлийн цифр = mock сценари (docs/05 §11.1). `seed` өөр өөр хүнийг (өдөр + 2-р сүүлийн цифр) гаргана. */
export function buyerRegister(scenarioDigit: number, seed = 0): string {
  const day = String(1 + (seed % 28)).padStart(2, '0');
  return `УЕ9005${day}${Math.floor(seed / 28) % 10}${scenarioDigit}`;
}

/** 8 оронтой тестийн утас (seed тутамд өөр). */
export function buyerPhone(seed = 0): string {
  return `9911${String(1000 + seed).padStart(4, '0')}`;
}

/** Ердийн POS лизингийн хүсэлт (LAPTOP, 3,000,000₮, урьдчилгаа 600,000₮, 12 сар). */
export function leaseBody(storeId: string | undefined, scenarioDigit = 0, over: Partial<Record<string, unknown>> = {}, seed = 0) {
  return {
    planCode: 'LAPTOP', ...(storeId ? { storeId } : {}),
    goods: { category: 'COMPUTER', name: 'Зөөврийн компьютер 15"', serialNo: 'SN-0001', price: 3_000_000 },
    downPayment: 600_000, termMonths: 12,
    buyer: { registerNo: buyerRegister(scenarioDigit, seed), phone: buyerPhone(seed) },
    ...over,
  };
}
