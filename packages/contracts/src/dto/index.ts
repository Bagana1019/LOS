import { z } from 'zod';
// REST DTO (sync) — сервис хоорондын гэрээ; OpenAPI-г эндээс үүсгэнэ
export const ScoreRequest = z.object({
  applicationId: z.string(), amount: z.number(), termMonths: z.number().int(), interestRate: z.number(),
  monthlyPayment: z.number(), salaryMonthly: z.number(), businessNcfMonthly: z.number(),
  householdExpenseMonthly: z.number(), existingDebtServiceMonthly: z.number(),
  collateralValueTotal: z.number(), policy: z.object({ maxDti: z.number(), minDscr: z.number(), maxLtv: z.number(), weightThreshold: z.number() }),
});
export type ScoreRequest = z.infer<typeof ScoreRequest>;
export const ValuationRequest = z.object({ assetType: z.string(), attributes: z.record(z.unknown()), productId: z.string() });
export const KycFetchRequest = z.object({ customerId: z.string(), registerNo: z.string(), sources: z.array(z.string()) });
// BSA → origination (docs/02 §7 INT-4)
export const BsaSummary = z.object({
  analysisId: z.string(), loanApplicationId: z.string(), borrowerId: z.string(), status: z.enum(['DRAFT','ANALYZED']), version: z.number(),
  periodMonths: z.number(), periodFrom: z.string(), periodTo: z.string(), transactionCount: z.number(),
  totalMonthlyIncome: z.number(), verifiedMonthlyIncome: z.number(), dtiIncome: z.number(),
  businessIncomeMonthly: z.number(), businessExpenseMonthly: z.number(), netCashFlowMonthly: z.number(),
  existingDebtServiceMonthly: z.number(), incomeReliability: z.number(), dtiPercent: z.number(),
  dtiLevel: z.enum(['LOW','MEDIUM','HIGH']), pendingSuspiciousCount: z.number(), reportPdfUrl: z.string().nullable(),
});
export type BsaSummary = z.infer<typeof BsaSummary>;
export * from './pricing';
