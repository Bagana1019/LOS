// BSA-FR-5.3 / INT-4 `pendingSuspiciousCount`: хүлээгдэж буй сэжигтэй дохионы тоо. Порт: RecalculationService / FinalizeService зөвхөн үүнийг мэднэ.
//  - `countPending`: `repo` өгвөл (транзакц дотор) тэр repo-оор, үгүй бол үндсэн repo-оор.
//  - `refresh` (заавал биш): ангиллын дараа 8 дохиог дахин илрүүлж хадгална, хүлээгдэж буй тоог буцаана. NullSuspicionCounter нь энэ хоёрыг хийхгүй.
import { Injectable } from '@nestjs/common';
import type { BsaAnalysisRecord, BsaRepository } from '../common/persistence';
import type { BsaSettings } from '../common/infra.ports';
import type { SuspicionTxn } from '../suspicion/detectors';

export interface SuspicionCounter {
  /** Шинжилгээний `PENDING` төлөвтэй сэжигтэй дохионы тоо (≥ 0) */
  countPending(orgId: string, analysisId: string, repo?: BsaRepository): Promise<number>;
  refresh?(repo: BsaRepository, analysis: BsaAnalysisRecord, txns: readonly SuspicionTxn[], settings: BsaSettings): Promise<number>;
}
export const SUSPICION_COUNTER = Symbol('SUSPICION_COUNTER');

@Injectable()
export class NullSuspicionCounter implements SuspicionCounter {
  async countPending(): Promise<number> {
    return 0;
  }
}
