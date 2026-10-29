// BSA-FR-5.3 / INT-4 `pendingSuspiciousCount`: хүлээгдэж буй сэжигтэй дохионы тоо. Сэжигтэй гүйлгээний (suspicion) модуль тусдаа unit — энд
// зөвхөн порт. Тэр модуль бэлэн болтол NullSuspicionCounter (0) ашиглана: НЭМЭХ ЭРСДЭЛ — сэжигтэй дохио огт үүсэхгүй тул
// pushPolicyWhenPendingSuspicious=BLOCK ч юуг ч хориглохгүй. Suspicion модуль SUSPICION_COUNTER-ийг өөрийн хэрэгжүүлэлтээр дарна.
import { Injectable } from '@nestjs/common';

export interface SuspicionCounter {
  /** Шинжилгээний `PENDING` төлөвтэй сэжигтэй дохионы тоо (≥ 0) */
  countPending(orgId: string, analysisId: string): Promise<number>;
}
export const SUSPICION_COUNTER = Symbol('SUSPICION_COUNTER');

@Injectable()
export class NullSuspicionCounter implements SuspicionCounter {
  async countPending(): Promise<number> {
    return 0;
  }
}
