import { quotePosLease } from '@los/calc';
import {
  MerchantDashboard, MerchantProfile, MerchantView, OtpSent, PlanView, PosLeaseAdminView, PosLeaseListItem, PosLeaseView, PosLeaseWithOtp, PosQuote, StoreView,
  type GoodsCategory, type MerchantRole, type MerchantStatus, type PosLeaseAction, type PosLeaseStatus,
} from '@los/contracts';
// Contract-valid fixtures: бүгд @los/contracts-ын zod схемээр parse() хийгдэнэ — гэрээ өөрчлөгдвөл e2e нэн даруй унана.

export const IDS = {
  merchant: '11111111-1111-4111-8111-111111111111',
  storeA: '22222222-2222-4222-8222-222222222221',
  storeB: '22222222-2222-4222-8222-222222222222',
  planLaptop: '33333333-3333-4333-8333-333333333331',
  planGames: '33333333-3333-4333-8333-333333333332',
  planGlobal: '33333333-3333-4333-8333-333333333333',
  lease: '44444444-4444-4444-8444-444444444441',
} as const;
export const leaseId = (n: number): string => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

export const NOW = () => new Date();
const iso = (d: Date) => d.toISOString();
export const minutesFromNow = (m: number) => iso(new Date(Date.now() + m * 60_000));
export const secondsFromNow = (s: number) => iso(new Date(Date.now() + s * 1000));
export const minutesAgo = (m: number) => minutesFromNow(-m);

// ───────────── Профайл ─────────────
export function makeProfile(opts: { role?: MerchantRole; status?: MerchantStatus; plans?: boolean } = {}): MerchantProfile {
  const role = opts.role ?? 'MERCHANT_STAFF';
  return MerchantProfile.parse({
    merchant: { id: IDS.merchant, code: 'TECHMALL', name: 'Тех Молл ХХК', status: opts.status ?? 'ACTIVE', maxTicketAmount: 8_000_000, dailyLimitAmount: 20_000_000 },
    stores: [
      { id: IDS.storeA, code: 'UB-01', name: 'Сүхбаатарын талбай салбар' },
      { id: IDS.storeB, code: 'UB-02', name: 'Зайсан салбар' },
    ],
    currentStoreId: role === 'MERCHANT_STAFF' ? IDS.storeA : null,
    role,
    plans: opts.plans === false ? [] : [
      { id: IDS.planLaptop, code: 'LAPTOP', name: 'Компьютер, утас 6–24 сар', goodsCategories: ['COMPUTER', 'PHONE_TABLET'], minAmount: 300_000, maxAmount: 8_000_000, termOptions: [6, 12, 18, 24], annualRate: 0.24, feeRate: 0.01, minDownPaymentRate: 0.1, validFrom: null, validTo: null },
      { id: IDS.planGames, code: 'GAMES', name: 'Тоглоом, электрон бараа', goodsCategories: ['GAMES', 'ELECTRONICS'], minAmount: 100_000, maxAmount: 3_000_000, termOptions: [3, 6], annualRate: 0.18, feeRate: 0, minDownPaymentRate: 0.2, validFrom: null, validTo: null },
    ],
  });
}

// ───────────── Quote (серверийн ижил цэвэр функц) ─────────────
const PLAN_PARAMS: Record<string, { annualRate: number; feeRate: number; commissionRate: number }> = {
  LAPTOP: { annualRate: 0.24, feeRate: 0.01, commissionRate: 0.02 },
  GAMES: { annualRate: 0.18, feeRate: 0, commissionRate: 0.02 },
};
export function makeQuote(i: { planCode?: string; goodsPrice: number; downPayment: number; termMonths: number }): PosQuote {
  const planCode = i.planCode ?? 'LAPTOP';
  return PosQuote.parse(quotePosLease({ planCode, goodsPrice: i.goodsPrice, downPayment: i.downPayment, termMonths: i.termMonths, ...(PLAN_PARAMS[planCode] ?? PLAN_PARAMS.LAPTOP!) }));
}

// ───────────── Лизинг ─────────────
export function allowedActionsFor(status: PosLeaseStatus, consentVerified: boolean): PosLeaseAction[] {
  switch (status) {
    case 'DRAFT': return consentVerified ? ['SUBMIT', 'CANCEL'] : ['SUBMIT', 'RESEND_CONSENT_OTP', 'CANCEL'];
    case 'REFERRED': return ['CANCEL'];
    case 'APPROVED': return ['REQUEST_ACCEPT_OTP', 'ACCEPT', 'CANCEL'];
    case 'ACCEPTED': return ['DELIVER', 'CANCEL'];
    default: return [];
  }
}

export interface LeaseOpts {
  id?: string;
  leaseNo?: string;
  status?: PosLeaseStatus;
  price?: number;
  down?: number;
  term?: number;
  planCode?: string;
  planName?: string;
  category?: GoodsCategory;
  goodsName?: string;
  serialNo?: string | null;
  buyerName?: string | null;
  decision?: Partial<{ result: 'APPROVE' | 'REFER' | 'DECLINE' | null; publicReason: 'AFFORDABILITY' | 'CREDIT_POLICY' | 'ELIGIBILITY' | 'MANUAL_REVIEW' | null; suggestedMinDownPayment: number | null; decidedBy: 'SYSTEM' | 'REVIEWER' | null; decisionSeconds: number | null }>;
  consentVerified?: boolean;
  /** Серверийн `allowedActions`-ийг шууд зааж өгөх (жишээ нь түдгэлзсэн/идэвхгүй мерчантын үед сервер [] эсвэл зөвхөн DELIVER/CANCEL буцаана). */
  allowedActions?: PosLeaseAction[];
  expiresAt?: string | null;
  cancelReason?: string | null;
  storeId?: string;
  storeName?: string;
  createdAt?: string;
}

const DECISION_BY_STATUS: Partial<Record<PosLeaseStatus, 'APPROVE' | 'REFER' | 'DECLINE'>> = { APPROVED: 'APPROVE', ACCEPTED: 'APPROVE', DELIVERED: 'APPROVE', SETTLED: 'APPROVE', REFERRED: 'REFER', DECLINED: 'DECLINE' };

export function makeLease(o: LeaseOpts = {}): PosLeaseView {
  const status = o.status ?? 'DRAFT';
  const price = o.price ?? 1_500_000;
  const down = o.down ?? 300_000;
  const term = o.term ?? 12;
  const consentVerified = o.consentVerified ?? status !== 'DRAFT';
  const decided = status !== 'DRAFT' && status !== 'CANCELLED' && status !== 'EXPIRED';
  const createdAt = o.createdAt ?? minutesAgo(3);
  const result = o.decision?.result !== undefined ? o.decision.result : (DECISION_BY_STATUS[status] ?? null);
  const stages: Array<[string, PosLeaseStatus | null, PosLeaseStatus | null, string]> = [['CREATED', null, 'DRAFT', 'MERCHANT:u-1']];
  if (consentVerified) stages.push(['CONSENT_VERIFIED', 'DRAFT', 'DRAFT', 'BUYER']);
  if (decided) stages.push(['DECIDED', 'DRAFT', status === 'ACCEPTED' || status === 'DELIVERED' || status === 'SETTLED' ? 'APPROVED' : status, 'SYSTEM']);
  if (status === 'ACCEPTED' || status === 'DELIVERED' || status === 'SETTLED') stages.push(['ACCEPTED', 'APPROVED', 'ACCEPTED', 'BUYER']);
  if (status === 'DELIVERED' || status === 'SETTLED') stages.push(['DELIVERED', 'ACCEPTED', 'DELIVERED', 'MERCHANT:u-1']);
  if (status === 'SETTLED') stages.push(['SETTLED', 'DELIVERED', 'SETTLED', 'LENDER:u-9']);
  if (status === 'CANCELLED') stages.push(['CANCELLED', 'DRAFT', 'CANCELLED', 'MERCHANT:u-1']);
  if (status === 'EXPIRED') stages.push(['EXPIRED', 'DRAFT', 'EXPIRED', 'SYSTEM']);
  const quote = makeQuote({ planCode: o.planCode, goodsPrice: price, downPayment: down, termMonths: term });
  return PosLeaseView.parse({
    id: o.id ?? IDS.lease, leaseNo: o.leaseNo ?? 'POS-261028-0001', status, merchantId: IDS.merchant, storeId: o.storeId ?? IDS.storeA, storeName: o.storeName ?? 'Сүхбаатарын талбай салбар',
    planCode: o.planCode ?? 'LAPTOP', planName: o.planName ?? 'Компьютер, утас 6–24 сар',
    goods: { category: o.category ?? 'COMPUTER', name: o.goodsName ?? 'Lenovo IdeaPad 3 15"', serialNo: o.serialNo ?? null, price },
    quote,
    buyer: { registerMasked: 'УЕ******01', phoneMasked: '99****12', fullName: o.buyerName === undefined ? (consentVerified ? 'Бат-Эрдэнэ Болормаа' : null) : o.buyerName },
    decision: {
      result, publicReason: o.decision?.publicReason ?? null, suggestedMinDownPayment: o.decision?.suggestedMinDownPayment ?? null,
      decidedAt: decided ? minutesAgo(2) : null, decidedBy: o.decision?.decidedBy !== undefined ? o.decision.decidedBy : (decided ? 'SYSTEM' : null), decisionSeconds: o.decision?.decisionSeconds !== undefined ? o.decision.decisionSeconds : (decided ? 42 : null),
    },
    consentVerifiedAt: consentVerified ? minutesAgo(3) : null,
    expiresAt: o.expiresAt !== undefined ? o.expiresAt : (status === 'APPROVED' ? minutesFromNow(28) : status === 'DRAFT' ? minutesFromNow(57) : null),
    acceptedAt: ['ACCEPTED', 'DELIVERED', 'SETTLED'].includes(status) ? minutesAgo(1) : null,
    deliveredAt: ['DELIVERED', 'SETTLED'].includes(status) ? minutesAgo(1) : null,
    settledAt: status === 'SETTLED' ? minutesAgo(0) : null,
    cancelledAt: status === 'CANCELLED' ? minutesAgo(1) : null,
    cancelReason: status === 'CANCELLED' ? (o.cancelReason ?? 'Худалдан авагч татгалзсан') : null,
    allowedActions: o.allowedActions ?? allowedActionsFor(status, consentVerified),
    timeline: stages.map(([action, from, to, actor], i) => ({ at: minutesAgo(Math.max(0, 3 - i * 0.5)), action, fromStatus: from, toStatus: to, actor })),
    createdAt,
  });
}

export function makeOtp(purpose: 'CONSENT' | 'ACCEPT' = 'CONSENT', o: { resendInSeconds?: number } = {}): OtpSent {
  return OtpSent.parse({ purpose, phoneMasked: '99****12', expiresAt: minutesFromNow(5), resendAvailableAt: secondsFromNow(o.resendInSeconds ?? 30) });
}
export const makeLeaseWithOtp = (lease: PosLeaseView, otp: OtpSent = makeOtp()) => PosLeaseWithOtp.parse({ lease, otp });

export function toListItem(l: PosLeaseView): PosLeaseListItem {
  return PosLeaseListItem.parse({
    id: l.id, leaseNo: l.leaseNo, status: l.status, createdAt: l.createdAt, storeId: l.storeId, storeName: l.storeName, planCode: l.planCode, goodsName: l.goods.name, goodsPrice: l.goods.price,
    financedAmount: l.quote.financedAmount, monthlyPayment: l.quote.monthlyPayment, termMonths: l.quote.termMonths, buyerName: l.buyer.fullName, buyerRegisterMasked: l.buyer.registerMasked, buyerPhoneMasked: l.buyer.phoneMasked, publicReason: l.decision.publicReason,
  });
}

export const paged = <T>(items: T[], page = 1, pageSize = 20, total = items.length) => ({ items, total, page, pageSize });

export function sampleLeases(): PosLeaseView[] {
  return [
    makeLease({ id: leaseId(1), leaseNo: 'POS-261028-0007', status: 'APPROVED', goodsName: 'Apple iPhone 15 128GB', category: 'PHONE_TABLET', price: 3_200_000, down: 700_000, term: 12, buyerName: 'Ганбаатар Сарнай' }),
    makeLease({ id: leaseId(2), leaseNo: 'POS-261028-0006', status: 'DELIVERED', goodsName: 'ASUS TUF Gaming F15', price: 4_800_000, down: 1_000_000, term: 18, buyerName: 'Мөнхбат Төгөлдөр' }),
    makeLease({ id: leaseId(3), leaseNo: 'POS-261028-0005', status: 'DECLINED', goodsName: 'Samsung Galaxy Tab S9', category: 'PHONE_TABLET', price: 2_600_000, down: 260_000, term: 12, buyerName: 'Эрдэнэбат Золзаяа', decision: { publicReason: 'AFFORDABILITY', suggestedMinDownPayment: 900_000 } }),
    makeLease({ id: leaseId(4), leaseNo: 'POS-261028-0004', status: 'REFERRED', goodsName: 'MacBook Air M2', price: 5_900_000, down: 1_200_000, term: 24, buyerName: 'Нямдорж Энхжин', decision: { publicReason: 'MANUAL_REVIEW' } }),
    makeLease({ id: leaseId(5), leaseNo: 'POS-261027-0012', status: 'SETTLED', goodsName: 'Sony PlayStation 5', category: 'GAMES', planCode: 'GAMES', planName: 'Тоглоом, электрон бараа', price: 2_400_000, down: 480_000, term: 6, buyerName: 'Батсүх Ариунаа', storeId: IDS.storeB, storeName: 'Зайсан салбар' }),
    makeLease({ id: leaseId(6), leaseNo: 'POS-261027-0011', status: 'DRAFT', goodsName: 'HP Pavilion 14', price: 2_100_000, down: 300_000, term: 12 }),
  ];
}

// ───────────── Dashboard ─────────────
export function makeDashboard(o: { empty?: boolean; avgDecisionSeconds?: number | null; days?: number } = {}): MerchantDashboard {
  const days = o.days ?? 7;
  const today = new Date();
  const daily = Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() + 8 * 3_600_000 - (days - 1 - i) * 86_400_000);
    const requests = o.empty ? 0 : [3, 5, 2, 8, 6, 9, 7][i % 7]!;
    const approved = o.empty ? 0 : Math.max(0, requests - [1, 2, 0, 3, 2, 3, 2][i % 7]!);
    return { date: d.toISOString().slice(0, 10), requests, approved, financedAmount: approved * 1_650_000 };
  });
  const leases = o.empty ? [] : sampleLeases();
  return MerchantDashboard.parse({
    range: { from: minutesAgo(7 * 24 * 60), to: minutesFromNow(0) },
    totals: o.empty ? {
      requests: 0, approved: 0, referred: 0, declined: 0, accepted: 0, delivered: 0, settled: 0, cancelledOrExpired: 0, approvalRate: null, conversionRate: null, avgDecisionSeconds: null,
      financedAmount: 0, goodsSalesAmount: 0, commissionAmount: 0, awaitingSettlementNet: 0, settledNet: 0,
    } : {
      requests: 40, approved: 27, referred: 4, declined: 8, accepted: 22, delivered: 19, settled: 12, cancelledOrExpired: 3, approvalRate: 0.675, conversionRate: 0.8148, avgDecisionSeconds: o.avgDecisionSeconds === undefined ? 47 : o.avgDecisionSeconds,
      financedAmount: 42_600_000, goodsSalesAmount: 55_200_000, commissionAmount: 852_000, awaitingSettlementNet: 11_480_000, settledNet: 29_100_000,
    },
    daily,
    byStore: o.empty ? [] : [
      { storeId: IDS.storeA, storeName: 'Сүхбаатарын талбай салбар', requests: 26, approved: 18, financedAmount: 28_900_000 },
      { storeId: IDS.storeB, storeName: 'Зайсан салбар', requests: 14, approved: 9, financedAmount: 13_700_000 },
    ],
    byPlan: o.empty ? [] : [
      { planCode: 'LAPTOP', requests: 31, approved: 21, financedAmount: 36_400_000 },
      { planCode: 'GAMES', requests: 9, approved: 6, financedAmount: 6_200_000 },
    ],
    todo: o.empty ? { awaitingOtp: 0, awaitingAcceptance: 0, awaitingDelivery: 0, referred: 0 } : { awaitingOtp: 1, awaitingAcceptance: 2, awaitingDelivery: 3, referred: 1 },
    limits: { maxTicketAmount: 8_000_000, dailyLimitAmount: 20_000_000, dailyUsedAmount: o.empty ? 0 : 13_400_000 },
    recent: leases.slice(0, 6).map(toListItem),
  });
}

// ───────────── Back-office ─────────────
export function makeMerchantView(o: Partial<{ id: string; code: string; name: string; status: MerchantStatus }> = {}): MerchantView {
  return MerchantView.parse({
    id: o.id ?? IDS.merchant, code: o.code ?? 'TECHMALL', name: o.name ?? 'Тех Молл ХХК', legalName: 'Тех Молл Группи ХХК', companyRegisterNo: '5123456', category: 'COMPUTER', contactName: 'Дорж Цэцэгмаа', phone: '99112233',
    email: 'info@techmall.mn', branchId: 'BR-UB-01', status: o.status ?? 'ACTIVE', commissionRate: 0.02, maxTicketAmount: 8_000_000, dailyLimitAmount: 20_000_000,
    settlement: { bankCode: 'KHAN', accountMasked: '****4821', holderName: 'Тех Молл ХХК' }, contractNo: 'CN-2026-014', contractSignedAt: '2026-09-01T00:00:00+08:00', createdAt: '2026-09-01T09:00:00+08:00', updatedAt: '2026-10-20T10:30:00+08:00',
  });
}
export function makeStoreView(o: Partial<{ id: string; code: string; name: string; isActive: boolean }> = {}): StoreView {
  return StoreView.parse({ id: o.id ?? IDS.storeA, merchantId: IDS.merchant, code: o.code ?? 'UB-01', name: o.name ?? 'Сүхбаатарын талбай салбар', address: { city: 'Улаанбаатар', district: 'Сүхбаатар', khoroo: '1-р хороо', detail: 'Peace Avenue 12' }, phone: '77001122', isActive: o.isActive ?? true, createdAt: '2026-09-01T09:00:00+08:00' });
}
export function makePlanView(o: Partial<{ id: string; code: string; name: string; merchantId: string | null; policy: Record<string, number | boolean> }> = {}): PlanView {
  return PlanView.parse({
    id: o.id ?? IDS.planLaptop, code: o.code ?? 'LAPTOP', name: o.name ?? 'Компьютер, утас 6–24 сар', merchantId: o.merchantId === undefined ? IDS.merchant : o.merchantId, productId: null, goodsCategories: ['COMPUTER', 'PHONE_TABLET'],
    minAmount: 300_000, maxAmount: 8_000_000, termOptions: [6, 12, 18, 24], annualRate: 0.24, feeRate: 0.01, minDownPaymentRate: 0.1, commissionRate: null, policy: o.policy ?? {}, validFrom: null, validTo: null, isActive: true, createdAt: '2026-09-01T09:00:00+08:00',
  });
}

export function makeAdminLease(o: LeaseOpts & { reasons?: Array<{ code: string; severity: 'DECLINE' | 'REFER' | 'INFO' }>; dtiRatio?: number | null; settlementRef?: string | null; comment?: string | null } = {}): PosLeaseAdminView {
  const base = makeLease(o);
  return PosLeaseAdminView.parse({
    ...base,
    merchantName: 'Тех Молл ХХК',
    review: {
      reasons: o.reasons ?? [{ code: 'DTI_EXCEEDED', severity: 'REFER' }, { code: 'BLACKLISTED', severity: 'REFER' }, { code: 'INCOME_UNVERIFIED', severity: 'INFO' }],
      dtiRatio: o.dtiRatio === undefined ? 0.5832 : o.dtiRatio,
      affordability: { maxMonthlyPayment: 420_000, maxFinancedAmount: 4_400_000, suggestedMinDownPayment: 1_500_000 },
      comment: o.comment ?? null, settlementRef: o.settlementRef ?? null, applicationId: null,
    },
  });
}
