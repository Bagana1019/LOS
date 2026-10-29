import { MerchantCreate, MerchantUpdate, PlanCreate, PlanUpdate, POS_POLICY_DEFAULTS, PosPolicyOverride } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { IDS, makeMerchantView, makePlanView } from '../../../../e2e/fixtures';
import { niceMax } from '../dashboard/BarChart';
import { DECISION_TARGET_SECONDS } from '../dashboard/Kpis';
import { buildCreatePayload, buildUpdatePayload } from './MerchantFormDrawer';
import { MERCHANT_TARGETS } from './MerchantStatusModal';
import { buildPlanCreate, buildPlanUpdate, buildPolicy, policyToForm } from './PlansTab';

const FORM = {
  code: ' newshop ', name: ' Шинэ дэлгүүр ХХК ', contactName: 'Бат Дорж', phone: '99 00 11 22', branchId: ' BR-UB-02 ', commissionRate: 2.5, maxTicketAmount: 5_000_000,
  dailyLimitAmount: null, settlement: { bankCode: ' khan ', accountNo: ' 5012345678 ', holderName: 'Шинэ дэлгүүр ХХК' },
};

describe('buildCreatePayload', () => {
  it('normalises input and produces a contract-valid MerchantCreate', () => {
    const p = buildCreatePayload(FORM);
    expect(p).toEqual({
      code: 'NEWSHOP', name: 'Шинэ дэлгүүр ХХК', contactName: 'Бат Дорж', phone: '99001122', branchId: 'BR-UB-02', commissionRate: 0.025, maxTicketAmount: 5_000_000, dailyLimitAmount: null,
      settlement: { bankCode: 'KHAN', accountNo: '5012345678', holderName: 'Шинэ дэлгүүр ХХК' },
    });
    expect(MerchantCreate.safeParse(p).success).toBe(true);
  });
  it('omits blank optional fields and converts dates to UB ISO', () => {
    const p = buildCreatePayload({ ...FORM, legalName: '  ', email: '', contractNo: '', category: 'COMPUTER', contractSignedAt: '2026-09-01', dailyLimitAmount: 20_000_000 });
    expect(p).not.toHaveProperty('legalName');
    expect(p).not.toHaveProperty('email');
    expect(p).not.toHaveProperty('contractNo');
    expect(p.category).toBe('COMPUTER');
    expect(p.contractSignedAt).toBe('2026-09-01T00:00:00+08:00');
    expect(p.dailyLimitAmount).toBe(20_000_000);
    expect(MerchantCreate.safeParse(p).success).toBe(true);
  });
});

describe('buildUpdatePayload (PATCH sends only what changed)', () => {
  const original = makeMerchantView();
  const unchanged = {
    code: original.code, name: original.name, legalName: original.legalName ?? undefined, companyRegisterNo: original.companyRegisterNo ?? undefined, category: original.category ?? undefined,
    contactName: original.contactName, phone: original.phone, email: original.email ?? undefined, branchId: original.branchId, commissionRate: original.commissionRate * 100,
    maxTicketAmount: original.maxTicketAmount, dailyLimitAmount: original.dailyLimitAmount, settlement: { bankCode: original.settlement.bankCode, accountNo: undefined, holderName: original.settlement.holderName },
    contractNo: original.contractNo ?? undefined, contractSignedAt: '2026-09-01',
  };
  it('an untouched form yields an empty patch', () => {
    expect(buildUpdatePayload(unchanged, original)).toEqual({});
  });
  it('only the changed field is sent; the code is never sent', () => {
    expect(buildUpdatePayload({ ...unchanged, name: 'Тех Молл Плюс ХХК', code: 'HACKED' }, original)).toEqual({ name: 'Тех Молл Плюс ХХК' });
    const patch = buildUpdatePayload({ ...unchanged, commissionRate: 3, maxTicketAmount: 9_000_000 }, original);
    expect(patch).toEqual({ commissionRate: 0.03, maxTicketAmount: 9_000_000 });
    expect(MerchantUpdate.safeParse(patch).success).toBe(true);
  });
  it('clearing the daily limit sends null', () => {
    expect(buildUpdatePayload({ ...unchanged, dailyLimitAmount: null }, { ...original, dailyLimitAmount: 5_000_000 })).toEqual({ dailyLimitAmount: null });
  });
  it('settlement is sent only when a full new account number is entered (never the masked one)', () => {
    expect(buildUpdatePayload({ ...unchanged, settlement: { bankCode: 'KHAN', accountNo: undefined, holderName: 'Өөр нэр' } }, original)).not.toHaveProperty('settlement');
    const patch = buildUpdatePayload({ ...unchanged, settlement: { bankCode: 'tdb', accountNo: '1234567890', holderName: 'Тех Молл ХХК' } }, original);
    expect(patch.settlement).toEqual({ bankCode: 'TDB', accountNo: '1234567890', holderName: 'Тех Молл ХХК' });
    expect(JSON.stringify(patch)).not.toContain(original.settlement.accountMasked);
  });
});

describe('merchant status transitions offered in the UI', () => {
  it('mirror the origination state machine; TERMINATED is final; nothing goes back to PENDING', () => {
    expect(MERCHANT_TARGETS.PENDING).toEqual(['ACTIVE', 'TERMINATED']);
    expect(MERCHANT_TARGETS.ACTIVE).toEqual(['SUSPENDED', 'TERMINATED']);
    expect(MERCHANT_TARGETS.SUSPENDED).toEqual(['ACTIVE', 'TERMINATED']);
    expect(MERCHANT_TARGETS.TERMINATED).toEqual([]);
    for (const targets of Object.values(MERCHANT_TARGETS)) expect(targets as readonly string[]).not.toContain('PENDING');
  });
});

describe('plan payloads and the advanced policy', () => {
  it('buildPolicy converts percents, drops empties and parses as PosPolicyOverride', () => {
    const policy = buildPolicy({ maxDti: 50, referDti: undefined, minAge: 21, autoDeclineEnabled: 'false', autoApproveMaxAmount: 5_000_000 } as never);
    expect(policy).toEqual({ maxDti: 0.5, minAge: 21, autoDeclineEnabled: false, autoApproveMaxAmount: 5_000_000 });
    expect(PosPolicyOverride.safeParse(policy).success).toBe(true);
    expect(buildPolicy(undefined)).toEqual({});
    expect(buildPolicy({})).toEqual({});
  });
  it('an untouched advanced policy sends no overrides (defaults come from the system, not from the form)', () => {
    const create = buildPlanCreate({ code: 'tv', name: 'ТВ', scope: 'MERCHANT', goodsCategories: ['ELECTRONICS'], minAmount: 100_000, maxAmount: 3_000_000, termOptions: [12, 6], annualRate: 18, feeRate: 0, minDownPaymentRate: 20, commissionRate: null, policy: {}, isActive: true }, IDS.merchant);
    expect(create.policy).toEqual({});
    expect(create).toMatchObject({ code: 'TV', merchantId: IDS.merchant, termOptions: [6, 12], annualRate: 0.18, minDownPaymentRate: 0.2, commissionRate: null, validFrom: null, validTo: null, productId: null });
    expect(PlanCreate.safeParse(create).success).toBe(true);
    // Анхдагч утгуудыг формд хуулж илгээхгүй
    for (const k of Object.keys(POS_POLICY_DEFAULTS)) expect(create.policy).not.toHaveProperty(k);
  });
  it('GLOBAL scope sends merchantId null; update never sends code or scope', () => {
    const create = buildPlanCreate({ code: 'g1', name: 'Глобал', scope: 'GLOBAL', goodsCategories: ['OTHER'], minAmount: 1, maxAmount: 10, termOptions: [3], annualRate: 10, policy: {} }, IDS.merchant);
    expect(create.merchantId).toBeNull();
    const update = buildPlanUpdate({ code: 'g1', name: 'Глобал 2', scope: 'GLOBAL', goodsCategories: ['OTHER'], minAmount: 1, maxAmount: 10, termOptions: [3], annualRate: 10, policy: {}, validFrom: '2026-10-01', validTo: '2026-12-31' });
    expect(update).not.toHaveProperty('code');
    expect(update).not.toHaveProperty('merchantId');
    expect(update.validFrom).toBe('2026-10-01T00:00:00+08:00');
    expect(update.validTo).toBe('2026-12-31T23:59:59.999+08:00');
    expect(PlanUpdate.safeParse(update).success).toBe(true);
  });
  it('policyToForm is the inverse of buildPolicy for overrides', () => {
    const plan = makePlanView({ policy: { maxDti: 0.5, minAge: 21, autoDeclineEnabled: false } });
    const form = policyToForm(plan.policy);
    expect(form).toEqual({ maxDti: 50, minAge: 21, autoDeclineEnabled: 'false' });
    expect(buildPolicy(form)).toEqual({ maxDti: 0.5, minAge: 21, autoDeclineEnabled: false });
  });
});

describe('dashboard helpers', () => {
  it('niceMax picks a round axis maximum', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(9)).toBe(10);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(110)).toBe(200);
    expect(niceMax(8_200_000)).toBe(10_000_000);
    expect(niceMax(3_300_000)).toBe(5_000_000);
    for (const v of [0.3, 1.7, 4, 12, 99, 1234, 56_789_012]) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });
  it('the decision-time target is one minute (docs/05 goal)', () => {
    expect(DECISION_TARGET_SECONDS).toBe(60);
  });
});
