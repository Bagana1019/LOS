import { z } from 'zod';
import { StepStatus } from '../enums';

// ── Модуль 5 · Зээлийн нөхцөл (FR-5.1…5.4) ─────────────────────────────────────────────────────────
// Нэгж (pricing-тай ижил): interestRate = жилийн хувь (23.99); feeRate = бутархай (0.015 = 1.5%); мөнгө = валютын нэгж, 2 орон.

const noNul = (s: string) => !s.includes('\u0000');
const text = (max: number) => z.string().trim().min(1).max(max).refine(noNul, 'NUL тэмдэгт зөвшөөрөгдөхгүй');
const money = z.number().finite().nonnegative().max(1e13).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, '2 оронтой тоо байх ёстой');
const rate4 = (max: number) => z.number().finite().min(0).max(max).refine((v) => Math.abs(v * 1e4 - Math.round(v * 1e4)) < 1e-6, '4 оронтой тоо байх ёстой');

/** FR-5.2 · ЗМС зориулалтын ангилал. DEMO кодууд (Q-101) — бодит ЗМС-ийн жагсаалтыг ББСБ баталгаажуулна (docs/DECISIONS.md). */
export const CIB_PURPOSES = [
  { code: 'CONS', name: 'Хэрэглээний зээл', subs: [{ code: 'CONS-HH', name: 'Гэр ахуйн хэрэгцээ' }, { code: 'CONS-EDU', name: 'Боловсрол' }, { code: 'CONS-MED', name: 'Эмчилгээ' }] },
  { code: 'BUS', name: 'Бизнесийн эргэлтийн хөрөнгө', subs: [{ code: 'BUS-TRADE', name: 'Худалдаа' }, { code: 'BUS-SERV', name: 'Үйлчилгээ' }, { code: 'BUS-PROD', name: 'Үйлдвэрлэл' }] },
  { code: 'INV', name: 'Хөрөнгө оруулалт', subs: [{ code: 'INV-EQ', name: 'Тоног төхөөрөмж' }, { code: 'INV-RE', name: 'Үл хөдлөх' }] },
  { code: 'AGRI', name: 'Мал аж ахуй, хөдөө аж ахуй', subs: [{ code: 'AGRI-LIVE', name: 'Мал аж ахуй' }, { code: 'AGRI-CROP', name: 'Газар тариалан' }] },
  { code: 'VEH', name: 'Тээврийн хэрэгсэл', subs: [{ code: 'VEH-CAR', name: 'Суудлын автомашин' }, { code: 'VEH-COM', name: 'Ачааны, тусгай' }] },
] as const;
export const isCibPurpose = (code: string, sub?: string | null): boolean => {
  const p = CIB_PURPOSES.find((x) => x.code === code);
  return !!p && (sub == null || p.subs.some((s) => s.code === sub));
};

export const SaveLoanTermsRequest = z.object({
  productId: text(64),
  amount: money.refine((v) => v > 0, '0-ээс их байх ёстой'),
  termMonths: z.number().int().min(1).max(600),
  /** Хоосон бол систем санал болгосноор (default шатлал, бүтээгдэхүүний хязгаарт тайрсан) бөглөнө. */
  interestRate: rate4(100).optional(),
  /** Хоосон бол шатлалын / бүтээгдэхүүний default шимтгэл. */
  feeRate: rate4(1).optional(),
  downPayment: money.optional(),
  charges: money.optional(),
  insurance: money.optional(),
  purpose: text(200),
  purposeDetail: text(500).optional(),
  cibPurposeCode: text(16).optional(),
  cibSubCode: text(16).optional(),
  /** ЗЭЗ-ийн санал (FR-5.3) */
  officerNote: text(2000).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.cibSubCode && !v.cibPurposeCode) ctx.addIssue({ code: 'custom', path: ['cibPurposeCode'], message: 'Дэд ангилал сонгохдоо ангиллыг заавал сонгоно' });
  if (v.cibPurposeCode && !isCibPurpose(v.cibPurposeCode, v.cibSubCode)) ctx.addIssue({ code: 'custom', path: ['cibPurposeCode'], message: 'ЗМС зориулалтын ангилал буруу' });
});
export type SaveLoanTermsRequest = z.infer<typeof SaveLoanTermsRequest>;

export const ProductLimits = z.object({
  minAmount: z.number(), maxAmount: z.number(), minTermMonths: z.number().int(), maxTermMonths: z.number().int(),
  minRate: z.number(), maxRate: z.number(), defaultFeeRate: z.number().nullable(),
});
export type ProductLimits = z.infer<typeof ProductLimits>;

export const LoanProductView = z.object({ id: z.string(), code: z.string(), name: z.string(), productType: z.string(), currency: z.string(), requiresCollateral: z.boolean(), limits: ProductLimits });
export type LoanProductView = z.infer<typeof LoanProductView>;
export const LoanProductsResponse = z.object({ items: z.array(LoanProductView) });
export type LoanProductsResponse = z.infer<typeof LoanProductsResponse>;

export const LimitViolation = z.object({ field: z.enum(['amount', 'termMonths', 'interestRate']), value: z.number(), min: z.number(), max: z.number() });
export type LimitViolation = z.infer<typeof LimitViolation>;

const StepInfo = z.object({ status: z.enum(StepStatus), staleReason: z.string().nullable() });

export const LoanTermsView = z.object({
  applicationId: z.string(),
  editable: z.boolean(),
  productId: z.string().nullable(),
  currency: z.string(),
  amount: z.number().nullable(),
  termMonths: z.number().int().nullable(),
  interestRate: z.number().nullable(),
  feeRate: z.number().nullable(),
  /** Шимтгэлийн дүн = amount × feeRate */
  feeAmount: z.number().nullable(),
  downPayment: z.number().nullable(),
  charges: z.number().nullable(),
  insurance: z.number().nullable(),
  purpose: z.string().nullable(),
  purposeDetail: z.string().nullable(),
  cibPurposeCode: z.string().nullable(),
  cibSubCode: z.string().nullable(),
  officerNote: z.string().nullable(),
  limits: ProductLimits.nullable(),
  /** 4-р алхам `loan` */
  step: StepInfo.nullable(),
  /** 6-р алхам `installment` — нөхцөл өөрчлөгдвөл STALE (FR-7.3) */
  installmentStep: StepInfo.nullable(),
});
export type LoanTermsView = z.infer<typeof LoanTermsView>;

export const CibPurposesResponse = z.object({ items: z.array(z.object({ code: z.string(), name: z.string(), subs: z.array(z.object({ code: z.string(), name: z.string() })) })) });
export type CibPurposesResponse = z.infer<typeof CibPurposesResponse>;
