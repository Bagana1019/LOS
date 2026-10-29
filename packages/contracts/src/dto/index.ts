import { z } from 'zod';
// REST DTO (sync) — сервис хоорондын гэрээ; OpenAPI-г эндээс үүсгэнэ
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
export * from './borrower';
export * from './payment';
export * from './notification';
export * from './report';
export * from './esign';
export * from './valuation';
