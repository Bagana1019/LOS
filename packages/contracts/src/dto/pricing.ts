import { z } from 'zod';
import { RiskBand } from '../enums';
// FR-5.5 Эрсдэлд суурилсан үнэ тогтоолт. Нэгж нь scaffold-ийн дагуу:
//   interestRate = ЖИЛИЙН ХУВЬ (23.99) — product.min_rate/max_rate, loan_application.interest_rate, annuityPayment-тай ижил;
//   feeRate      = БУТАРХАЙ (0.015 = 1.5%), зээлийн дүнгийн нэг удаагийн хувь — product.default_fee_rate-тай ижил. Хоёулаа numeric(7,4).

// 4 орноос илүү бутархайг хадгалж чадахгүй (numeric(7,4)) тул хүлээж авахгүй. Floating point-ийн хэлбэлзлийг (0.1+0.2) 4 оронд тэнцүүлж,
// validateTierSet болон DB хоёр яг ижил утга харна.
const atMost4Decimals = (v: number) => Math.abs(v * 1e4 - Math.round(v * 1e4)) < 1e-6;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const fraction = z.number().min(0).max(1).refine(atMost4Decimals, 'at most 4 decimal places').transform(round4);
const percent = z.number().min(0).max(100).refine(atMost4Decimals, 'at most 4 decimal places').transform(round4);
// PostgreSQL NUL болон хосгүй surrogate-ийг хүлээн авдаггүй (500 болохоос өмнө 400 болгоно)
const isSafeText = (s: string) => !s.includes('\u0000') && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
const safeText = (max: number) => z.string().min(1).max(max).refine(isSafeText, 'invalid characters');
const ProductId = safeText(64);

export const SoscoScoreValue = z.number().min(0).max(1000);

export const PricingTierInput = z.object({
  code: z.string().regex(/^[A-Z0-9_]{1,16}$/),
  name: safeText(64),
  band: z.enum(RiskBand),
  /** Энэ оноогоос (оруулаад) дээш, дараагийн tier-ийн minScore-оос доош оноо энэ tier-д орно. Хамгийн доод tier 0-ээс эхэлнэ. */
  minScore: z.number().int().min(0).max(1000),
  /** Жилийн хувь, 0..100 (23.99) */
  interestRate: percent,
  /** Зээлийн дүнгийн хувь, бутархай 0..1 (0.015 = 1.5%) */
  feeRate: fraction,
  /** Sosco Score байхгүй үед (лавлагаа бүрдээгүй) ашиглах tier — багцад яг нэг */
  isDefault: z.boolean(),
});
export type PricingTierInput = z.infer<typeof PricingTierInput>;

export const PricingTierSet = z.object({
  /** PRODUCT = бүтээгдэхүүний өөрийн шатлал, DEFAULT = байгууллагын нийтлэг шатлал */
  scope: z.enum(['PRODUCT', 'DEFAULT']),
  productId: z.string().nullable(),
  version: z.number().int().positive(),
  tiers: z.array(PricingTierInput),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().nullable(),
});
export type PricingTierSet = z.infer<typeof PricingTierSet>;

export const SavePricingTiersRequest = z.object({
  /** null → байгууллагын нийтлэг шатлал */
  productId: ProductId.nullable().default(null),
  tiers: z.array(PricingTierInput).min(1).max(10),
});
export type SavePricingTiersRequest = z.infer<typeof SavePricingTiersRequest>;

export const PricingTiersQuery = z.object({
  /** Хоосон утга = заагаагүй (нийтлэг шатлал) */
  productId: z.preprocess((v) => (v === '' ? undefined : v), ProductId.optional()),
});
export type PricingTiersQuery = z.infer<typeof PricingTiersQuery>;

export const PricingQuoteRequest = z.object({
  productId: ProductId,
  /** null → Sosco Score хараахан тооцогдоогүй; default tier-ээр санал болгоно */
  soscoScore: SoscoScoreValue.nullable(),
  amount: z.number().positive().max(1e13).optional(),
});
export type PricingQuoteRequest = z.infer<typeof PricingQuoteRequest>;

export const PricingQuoteResponse = z.object({
  basis: z.enum(['SCORE', 'DEFAULT_TIER']),
  soscoScore: SoscoScoreValue.nullable(),
  tier: z.object({ code: z.string(), name: z.string(), band: z.enum(RiskBand), minScore: z.number().int() }),
  /** Tier-ийн хүү, шимтгэл (бүтээгдэхүүний хязгаар хэрэглэхээс өмнө) */
  tierInterestRate: z.number(),
  tierFeeRate: z.number(),
  /** Санал болгож буй хүү — бүтээгдэхүүний [minRate, maxRate]-д багтсан */
  interestRate: z.number(),
  feeRate: z.number(),
  /** Tier-ийн хүү бүтээгдэхүүний хязгаараас хэтэрсэн бол аль талаас нь тайрсан */
  rateBound: z.enum(['MIN', 'MAX']).nullable(),
  feeAmount: z.number().nullable(),
  productRateBounds: z.object({ minRate: z.number(), maxRate: z.number() }),
  /** Шатлалын хувилбар — зээлийн хүсэлтийн snapshot/аудитад хадгалах */
  config: z.object({ scope: z.enum(['PRODUCT', 'DEFAULT']), productId: z.string().nullable(), version: z.number().int().positive() }),
});
export type PricingQuoteResponse = z.infer<typeof PricingQuoteResponse>;
