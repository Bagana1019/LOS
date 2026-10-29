// BSA-FR-5.3 / INT-4 / INT-5: «Системрүү татах» — шинжилгээг ANALYZED болгож, LOS руу өгөх `BsaSummary`-г буцаана. Тооцоолол/Sosco-д өгөх
// `BsaScoringInput` + `toScoringPatch` урьдчилан харах.
//
// Дүрэм:
//  - Дор хаяж 1 COMPLETED импорт, дуусаагүй (PENDING/PROCESSING) ажилгүй, гүйлгээтэй байх ёстой.
//  - settings.pushPolicyWhenPendingSuspicious: WARN ⇒ анхааруулга нэмнэ; BLOCK ⇒ pendingSuspiciousCount > 0 үед татгалзана.
//  - ДАХИН татаж болно (re-finalize): ANALYZED шинжилгээнд параметр/ангилал өөрчлөгдсөний дараа. `analyzedAt` анхны удаа л тавигдана,
//    `pushedToLosAt` татах бүрт шинэчлэгдэнэ. Хураангуйг хадгалсан ангиллаар тооцно (хэрэглэгчийн харсантай ижил, шинэ дүрмээр дахин ангилахгүй).
//  - LOS руу бичих (origination.bsa_summary_json) нь энэ unit-ийн гадна: энэ service зөвхөн хураангуйг буцаана.
import { Inject, Injectable } from '@nestjs/common';
import { toScoringPatch, type BsaScoringPatch } from '@los/calc';
import type { BsaAnalysisWarning, BsaScoringInput, BsaSummary } from '@los/contracts';
import { BSA_SETTINGS, type BsaSettingsProvider, type RequestContext } from '../common/infra.ports';
import { BSA_REPOSITORY, type BsaRepository } from '../common/persistence';
import { loadAnalysis } from './access';
import { BSA_CLOCK, type Clock } from './import.defaults';
import { BSA_EVENT } from './import.events';
import { conflict, unprocessable } from './import.errors';
import { RecalculationService } from './recalculation.service';
import { SUSPICION_COUNTER, type SuspicionCounter } from './suspicion.counter';

export interface FinalizeResult {
  /** INT-4: LOS-ын loan_application.bsa_summary_json-д бичих хураангуй (status = ANALYZED) */
  summary: BsaSummary;
  warnings: BsaAnalysisWarning[];
  pushedToLosAt: Date;
  /** true: анхны удаа ANALYZED болсон; false: дахин татсан */
  firstTime: boolean;
}

export interface ScoringPreview {
  input: BsaScoringInput;
  patch: BsaScoringPatch;
}

@Injectable()
export class FinalizeService {
  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
    @Inject(SUSPICION_COUNTER) private readonly suspicion: SuspicionCounter,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  /** «Системрүү татах» (INT-4). Бүх шалгалт, төлөв, хураангуй НЭГ транзакцид: аль нэг нь унавал DRAFT хэвээр */
  async finalize(ctx: RequestContext, analysisId: string): Promise<FinalizeResult> {
    return this.repo.runInTransaction(async (r) => {
      const analysis = await loadAnalysis(r, ctx, analysisId, 'write');
      const settings = await this.settingsProvider.get(analysis.orgId);

      const counts = await r.importJobs.countByStatus({ analysisId });
      if (counts.PENDING + counts.PROCESSING > 0) throw conflict('JOBS_IN_PROGRESS', { pending: counts.PENDING, processing: counts.PROCESSING });
      if (counts.COMPLETED === 0) throw unprocessable('NO_COMPLETED_IMPORT');

      const pending = await this.suspicion.countPending(analysis.orgId, analysisId);
      if (pending > 0 && settings.pushPolicyWhenPendingSuspicious === 'BLOCK') {
        throw unprocessable('PENDING_SUSPICIOUS_BLOCK', { pendingSuspiciousCount: pending });
      }

      const now = this.clock.now();
      const firstTime = analysis.analyzedAt === null;
      // Төлөвийг ӨМНӨ тавина: хураангуйн `status` ANALYZED болж гарна
      await r.analyses.update(analysisId, { status: 'ANALYZED', analyzedAt: analysis.analyzedAt ?? now, pushedToLosAt: now }, ctx.userId);
      const result = await this.recalc.run(r, { analysisId, actorId: ctx.userId, reason: 'FINALIZE', refreshClassification: false });
      if (result.summary === null || result.details === null) throw unprocessable('NO_TRANSACTIONS'); // транзакц буцаана ⇒ DRAFT хэвээр

      const warnings = [...result.details.warnings];
      if (pending > 0) {
        warnings.push({ code: 'PENDING_SUSPICIOUS', message: `Шийдвэрлэгдээгүй ${pending} сэжигтэй дохио байна. Шалгаад татахыг зөвлөж байна.` });
      }
      await r.events.append({
        analysisId,
        action: BSA_EVENT.FINALIZED,
        actorId: ctx.userId,
        at: now,
        detail: {
          version: analysis.version,
          firstTime,
          pendingSuspicious: pending,
          dtiPercent: result.summary.dtiPercent,
          dtiLevel: result.summary.dtiLevel,
          warnings: warnings.map((w) => w.code),
        },
      });
      return { summary: result.summary, warnings, pushedToLosAt: now, firstTime };
    });
  }

  /** INT-5: ANALYZED шинжилгээний `BsaScoringInput` (шинээр тооцсон). ANALYZED биш бол татгалзана */
  async toScoringInput(ctx: RequestContext, analysisId: string): Promise<BsaScoringInput> {
    const analysis = await loadAnalysis(this.repo, ctx, analysisId, 'read');
    if (analysis.status !== 'ANALYZED') throw conflict('NOT_ANALYZED');
    const input = await this.recalc.scoringInput(ctx, analysisId);
    if (input === null) throw unprocessable('NO_TRANSACTIONS');
    return input;
  }

  /** INT-5: `toScoringPatch` — ScoreRequest / SoscoInput-д орох утгууд (урьдчилан харах) */
  async scoringPreview(ctx: RequestContext, analysisId: string): Promise<ScoringPreview> {
    const input = await this.toScoringInput(ctx, analysisId);
    return { input, patch: toScoringPatch(input) };
  }
}
