import { quotePosLease } from '@los/calc';
import type { LeaseDashboardRow, LeaseRecord, MerchantRecord, PlanRecord, StoreRecord } from '../domain/records';
import { DemoPiiCipher } from '../integrations/demo-pii-cipher';
import { maskRegister } from '../common/masking';

// Unit тестэд зориулсан бичлэгийн үйлдвэр (persistence-гүйгээр).
const T0 = new Date('2026-10-28T04:00:00.000Z');
const cipher = new DemoPiiCipher();

export function makeMerchantRecord(over: Partial<MerchantRecord> = {}): MerchantRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000a1', orgId: 'org-test', version: 1, code: 'M-1', name: 'Тест мерчант', legalName: null, companyRegisterNo: null, category: null,
    contactName: 'Тест', phone: '99110011', email: null, branchId: 'BR-X', status: 'ACTIVE', statusReason: null, commissionRate: 0.03, maxTicketAmount: 15_000_000, dailyLimitAmount: null,
    settlementBankCode: 'KHAN', settlementAccountEncrypted: cipher.encrypt('5012345678'), settlementAccountLast4: '5678', settlementHolderName: 'Тест',
    contractNo: null, contractSignedAt: null, createdAt: T0, updatedAt: T0, createdBy: 'u', updatedBy: 'u', ...over,
  };
}

export function makeStoreRecord(over: Partial<StoreRecord> = {}): StoreRecord {
  return { id: '00000000-0000-4000-8000-0000000000b1', orgId: 'org-test', version: 1, merchantId: '00000000-0000-4000-8000-0000000000a1', code: 'S-1', name: 'Дэлгүүр', address: { detail: 'Хаяг 1' }, phone: null, isActive: true, createdAt: T0, updatedAt: T0, createdBy: 'u', updatedBy: 'u', ...over };
}

export function makePlanRecord(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000c1', orgId: 'org-test', version: 1, merchantId: null, code: 'LAPTOP', name: 'Laptop', productId: null, goodsCategories: ['COMPUTER'], minAmount: 300_000, maxAmount: 20_000_000,
    termOptions: [6, 12], annualRate: 0.24, feeRate: 0.01, minDownPaymentRate: 0.1, commissionRate: null, policy: {}, validFrom: null, validTo: null, isActive: true,
    createdAt: T0, updatedAt: T0, createdBy: 'u', updatedBy: 'u', ...over,
  };
}

export function makeLeaseRecord(over: Partial<LeaseRecord> = {}): LeaseRecord {
  const quote = quotePosLease({ planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, annualRate: 0.24, feeRate: 0.01, commissionRate: 0.03 });
  return {
    id: '00000000-0000-4000-8000-0000000000d1', orgId: 'org-test', branchId: 'BR-X', leaseNo: 'POS-261028-000001', version: 1,
    merchantId: '00000000-0000-4000-8000-0000000000a1', storeId: '00000000-0000-4000-8000-0000000000b1', planId: '00000000-0000-4000-8000-0000000000c1', planCode: 'LAPTOP', planName: 'Laptop',
    status: 'DRAFT', idempotencyKey: 'idem-00000001', requestHash: 'hash',
    buyerRegisterEncrypted: cipher.encrypt('УЕ90051500'), buyerRegisterHash: cipher.hash('УЕ90051500'), buyerRegisterMasked: maskRegister('УЕ90051500'), buyerPhone: '99111000',
    buyerLastName: null, buyerFirstName: null, goodsCategory: 'COMPUTER', goodsName: 'Laptop', goodsSerialNo: null, goodsPrice: 3_000_000, quote,
    decision: null, decisionReasons: [], dtiRatio: null, affordability: null, screeningSummary: null,
    decidedAt: null, decidedBy: null, decisionComment: null, consentVerifiedAt: null, consentTextVersion: null,
    expiresAt: new Date(T0.getTime() + 3_600_000), acceptedAt: null, deliveredAt: null, deliveredBy: null, settledAt: null, settlementRef: null, cancelledAt: null, cancelReason: null, applicationId: null,
    createdAt: T0, updatedAt: T0, createdBy: 'staff-1', updatedBy: 'staff-1', ...over,
  };
}

export function makeDashboardRow(over: Partial<LeaseDashboardRow> = {}): LeaseDashboardRow {
  return {
    id: 'row', status: 'DRAFT', storeId: 's1', planCode: 'P1', decision: null, createdAt: T0, decidedAt: null, decidedBy: null, expiresAt: null, acceptedAt: null, deliveredAt: null, settledAt: null,
    goodsPrice: 0, financedAmount: 0, merchantCommissionAmount: 0, merchantNetAmount: 0, ...over,
  };
}
