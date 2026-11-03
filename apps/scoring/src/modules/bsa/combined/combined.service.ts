// BSA-BR-9 / BSA-FR-4.10: хүсэлтийн түвшний нэгтгэл. Зээлдэгч бүрийн ИДЭВХТЭЙ (хамгийн сүүлийн хувилбар) шинжилгээний хадгалсан хураангуйг
// @los/calc `combineBsa`-аар нэгтгэнэ. Санал болгосон төлбөр нь хүсэлтийн нэг утга (гишүүн бүрд давхардуулахгүй).
import { Inject, Injectable } from '@nestjs/common';
import { classifyDtiLevel, combineBsa } from '@los/calc';
import type { BsaCombinedSummary } from '@los/contracts';
import { BSA_REPOSITORY, type BsaRepository } from '../common/persistence';
import { BSA_SETTINGS, type BsaSettingsProvider, type RequestContext } from '../common/infra.ports';
import { loadAnalysis } from '../import/access';
import { notFound } from '../import/import.errors';

@Injectable()
export class CombinedService {
  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
  ) {}

  async forApplication(ctx: RequestContext, applicationId: string): Promise<BsaCombinedSummary> {
    const latest = await this.repo.analyses.listLatestByApplication(ctx.orgId, applicationId);
    if (latest.length === 0) throw notFound('COMBINED_NOT_AVAILABLE');
    // Эрхгүй шинжилгээ байвал 403/404 (loadAnalysis) — нэгтгэлд хэсэгчилсэн өгөгдөл гаргахгүй
    const analyses = [];
    for (const a of latest) analyses.push(await loadAnalysis(this.repo, ctx, a.id, 'read'));

    const settings = await this.settingsProvider.get(ctx.orgId);
    const withSummary = analyses.filter((a) => a.summary !== null);
    const proposed = analyses.find((a) => a.proposedMonthlyPayment !== null)?.proposedMonthlyPayment ?? 0;
    const c = combineBsa(
      withSummary.map((a) => ({
        dtiIncome: a.summary!.dtiIncome,
        existingDebtServiceMonthly: a.summary!.existingDebtServiceMonthly,
        businessIncomeMonthly: a.summary!.businessIncomeMonthly,
        businessExpenseMonthly: a.summary!.businessExpenseMonthly,
        incomeReliability: a.summary!.incomeReliability,
        pendingSuspiciousCount: a.summary!.pendingSuspiciousCount,
      })),
      proposed,
    );
    return {
      applicationId,
      analysisCount: analyses.length,
      allAnalyzed: analyses.every((a) => a.status === 'ANALYZED' && a.summary !== null),
      ...c,
      dtiLevel: classifyDtiLevel(c.dtiPercent / 100, settings.dtiLevelThresholds),
      members: withSummary.map((a) => ({
        analysisId: a.id, borrowerId: a.borrowerId ?? a.customerId, status: a.status, dtiIncome: a.summary!.dtiIncome, existingDebtServiceMonthly: a.summary!.existingDebtServiceMonthly,
      })),
    };
  }
}
