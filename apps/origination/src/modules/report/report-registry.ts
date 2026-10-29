import { Injectable } from '@nestjs/common';
import type { ReportKey } from '@los/contracts';
import type { ReportDefinition } from './report-types';
import { closedLoans } from './reports/closed-loans.report';
import { collateralAssets } from './reports/collateral-assets.report';
import { depositBalances } from './reports/deposit-balances.report';
import { disbursedLoans } from './reports/disbursed-loans.report';
import { interestPayments } from './reports/interest-payments.report';
import { outstandingBalance } from './reports/outstanding-balance.report';
import { overdueLoans } from './reports/overdue-loans.report';
import { pipelineProgress } from './reports/pipeline-progress.report';
import { upcomingRepayments } from './reports/upcoming-repayments.report';

/** Тайлан нэмэх = `reports/<key>.report.ts` үүсгээд энд нэг мөр нэмэх (ReportKey enum-д түлхүүр байх ёстой). Дараалал = цэсний дараалал (docs/01 §2.1). */
export const REPORT_DEFINITIONS: ReportDefinition[] = [
  upcomingRepayments, overdueLoans, outstandingBalance, closedLoans, disbursedLoans, interestPayments, collateralAssets, pipelineProgress, depositBalances,
];

@Injectable()
export class ReportRegistry {
  private readonly byKey = new Map<string, ReportDefinition>(REPORT_DEFINITIONS.map((d) => [d.key, d]));
  all(): ReportDefinition[] { return REPORT_DEFINITIONS; }
  get(key: string): ReportDefinition | undefined { return this.byKey.get(key); }
  has(key: string): key is ReportKey { return this.byKey.has(key); }
}
