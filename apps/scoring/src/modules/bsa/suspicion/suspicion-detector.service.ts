// SUSPICION_COUNTER порт-ын бодит хэрэгжүүлэлт (BSA-FR-5.1/5.3): ангиллын дараа 8 дохиог илрүүлж bsa_suspicion-д тулгана,
// хүлээгдэж буй тоог буцаана. Шийдвэрлэсэн дохио дахин илрүүлэхэд өөрчлөгдөхгүй (repo.suspicions.sync).
import { Inject, Injectable } from '@nestjs/common';
import { BSA_REPOSITORY, type BsaAnalysisRecord, type BsaRepository } from '../common/persistence';
import type { BsaSettings } from '../common/infra.ports';
import type { SuspicionCounter } from '../import/suspicion.counter';
import { detectSuspicions, type SuspicionTxn } from './detectors';

/** Нэг шинжилгээнд хадгалах дохионы дээд тоо (гажиг хуулгаар хүснэгт тэлэхээс хамгаална) */
export const MAX_SUSPICIONS_PER_ANALYSIS = 2_000;

@Injectable()
export class SuspicionDetectorService implements SuspicionCounter {
  constructor(@Inject(BSA_REPOSITORY) private readonly repo: BsaRepository) {}

  countPending(_orgId: string, analysisId: string, repo: BsaRepository = this.repo): Promise<number> {
    return repo.suspicions.countPending(analysisId);
  }

  async refresh(repo: BsaRepository, analysis: BsaAnalysisRecord, txns: readonly SuspicionTxn[], settings: BsaSettings): Promise<number> {
    const detected = detectSuspicions(txns, settings.suspicion).slice(0, MAX_SUSPICIONS_PER_ANALYSIS);
    const res = await repo.suspicions.sync(
      analysis.id,
      detected.map((d) => ({
        detectKey: d.key, flag: d.flag, transactionIds: d.transactionIds, confidence: d.confidence, autoResolved: d.autoResolved,
        ...(d.autoResolved ? { comment: 'Өөрийн данс хоорондын шилжүүлэг — автоматаар хасагдсан (BSA-BR-5)' } : {}),
      })),
    );
    return res.pending;
  }
}
