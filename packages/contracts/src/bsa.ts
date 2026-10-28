import { z } from 'zod';
import { BsaStatus } from './enums';

// BSA (docs/02-bsa-requirements.md) — enum болон service хоорондын гэрээ. Enum-ийг өөр газар давтахгүй.

/** BSA-BR-6: заавал дэмжих 7 банк */
export const BankCode = ['KHAN', 'GOLOMT', 'TDB', 'XAC', 'CAPITRON', 'STATE', 'MBANK'] as const;
export type BankCode = typeof BankCode[number];

export const TxnDirection = ['INCOME', 'EXPENSE'] as const;
export type TxnDirection = typeof TxnDirection[number];

/** docs/03 bsa_transaction.channel */
export const TxnChannel = ['QPAY', 'POS', 'ATM', 'TRANSFER', 'OTHER'] as const;
export type TxnChannel = typeof TxnChannel[number];

/** docs/03 bsa_category.dti_role */
export const BsaDtiRole = ['INCOME', 'DEBT_SERVICE', 'HOUSEHOLD', 'BUSINESS_EXPENSE', 'EXCLUDE', 'INFO'] as const;
export type BsaDtiRole = typeof BsaDtiRole[number];

/** BSA-FR-4.2: Бага/Дунд/Өндөр (завсар admin-д) */
export const DtiLevel = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DtiLevel = typeof DtiLevel[number];

/** docs/03 bsa_rule.match_type / source */
export const BsaRuleMatchType = ['KEYWORD', 'COUNTERPARTY', 'REGEX'] as const;
export type BsaRuleMatchType = typeof BsaRuleMatchType[number];
export const BsaRuleSource = ['ADMIN', 'FEEDBACK'] as const;
export type BsaRuleSource = typeof BsaRuleSource[number];

/**
 * BSA → Тооцоолол (scoring) руу өгөх оролт. `ScoreRequest` (businessNcfMonthly, existingDebtServiceMonthly,
 * householdExpenseMonthly) ба `SoscoInput` (dtiPercent, incomeReliability, pendingSuspiciousCount)-ийг
 * бөглөхөд хэрэглэнэ. docs/02 INT-4 / INT-5.
 */
export const BsaScoringInput = z.object({
  analysisId: z.string(),
  loanApplicationId: z.string(),
  borrowerId: z.string(),
  version: z.number().int(),
  status: z.enum(BsaStatus),
  periodMonths: z.number(),
  transactionCount: z.number().int(),
  /** Дайчилсан (жинлэсэн) бизнесийн орлого, сарын дундаж */
  businessIncomeMonthly: z.number(),
  businessExpenseMonthly: z.number(),
  /** ЦМУ = businessIncomeMonthly − businessExpenseMonthly (ScoreRequest.businessNcfMonthly) */
  businessNcfMonthly: z.number(),
  householdExpenseMonthly: z.number(),
  existingDebtServiceMonthly: z.number(),
  verifiedMonthlyIncome: z.number(),
  dtiIncomeMonthly: z.number(),
  /** % (6.8 = 6.8%) — BsaSummary.dtiPercent-тэй ижил нэгж */
  dtiPercent: z.number(),
  incomeReliability: z.number(),
  pendingSuspiciousCount: z.number().int(),
});
export type BsaScoringInput = z.infer<typeof BsaScoringInput>;
