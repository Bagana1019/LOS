// INT-4 / BSA-BR-9 · цэвэр дүрмүүд (I/O байхгүй): scoring-ийн хураангуй + нэгтгэлээс `loan_application.bsa_summary_json`-ийг бүрдүүлэх.
import type { BsaCombinedSummary, BsaSummary } from '@los/contracts';

/** Нийт шинжилгээ ANALYZED биш бол status='DRAFT' — `readBsaFacts` DTI/найдвар/сэжигтэйг зөвхөн ANALYZED үед ашиглана (консерватив) */
export interface LosBsaSummary extends Omit<BsaSummary, 'status'> {
  status: 'DRAFT' | 'ANALYZED';
  /** Нэгтгэл: хамтран зээлдэгч хамрагдсан эсэх (analysisCount > 1) */
  combined: boolean;
  analysisCount: number;
  allAnalyzed: boolean;
  members: BsaCombinedSummary['members'];
  pushedAt: string;
  warnings: string[];
}

/**
 * `pushed` = одоо татсан шинжилгээний хураангуй (хугацаа, гүйлгээний тоо, хувилбарыг эндээс), `combined` = хүсэлтийн нэгтгэл (орлого/өр/DTI-г эндээс).
 * Нэг зээлдэгчтэй бол нэгтгэл нь тэр зээлдэгчийнхтэй ижил тул утгууд хэвээр.
 */
export function buildLosSummary(pushed: BsaSummary, combined: BsaCombinedSummary, warnings: string[], pushedAt: Date, reportPdfUrl: string | null): LosBsaSummary {
  const multi = combined.analysisCount > 1;
  return {
    ...pushed,
    status: combined.allAnalyzed ? 'ANALYZED' : 'DRAFT',
    dtiIncome: combined.dtiIncome,
    existingDebtServiceMonthly: combined.existingDebtServiceMonthly,
    businessIncomeMonthly: combined.businessIncomeMonthly,
    businessExpenseMonthly: combined.businessExpenseMonthly,
    netCashFlowMonthly: combined.netCashFlowMonthly,
    incomeReliability: combined.incomeReliability,
    pendingSuspiciousCount: combined.pendingSuspiciousCount,
    dtiPercent: combined.dtiPercent,
    dtiLevel: combined.dtiLevel,
    reportPdfUrl,
    combined: multi,
    analysisCount: combined.analysisCount,
    allAnalyzed: combined.allAnalyzed,
    members: combined.members,
    pushedAt: pushedAt.toISOString(),
    warnings,
  };
}

/** INT-6: санал болгосон төлбөр өөрчлөгдсөн эсэх (₮1-ээс бага зөрүүг үл тоомсорлоно) */
export const paymentChanged = (current: number | null | undefined, next: number): boolean => current === null || current === undefined || Math.abs(current - next) >= 1;
