// BSA-FR-4: ангилагдсан гүйлгээ → ангилал × сар → computeBsaDti. Stateless, I/O-гүй (тооцоолол @los/calc-д).
import { Injectable } from '@nestjs/common';
import { computeBsaDti, type BsaCategoryMonthly, type BsaDtiParams, type BsaDtiResult } from '@los/calc';
import type { BsaCategoryDef, ClassifiedTxn, OtherShareReport } from '../classify/classify.types';
import { computeOtherShare } from '../classify/other-share';
import { aggregateCategoryMonthly, filterByPeriod } from './aggregate';

export interface DtiAnalysisInput {
  classified: readonly ClassifiedTxn[];
  categories: readonly BsaCategoryDef[];
  params: BsaDtiParams;
  /** BSA-BR-7: өгвөл "Бусад"-ын хувийг мөн тооцоолно (0..1) */
  otherShareThreshold?: number;
}

export interface DtiAnalysisResult {
  dti: BsaDtiResult;
  /** computeBsaDti-д өгсөн ангилал × сарын нийлбэр (UI-ийн задаргаа, аудит) */
  categoryMonthly: BsaCategoryMonthly[];
  /** Шинжилгээний хугацаанд орсон бүх гүйлгээ (өөрийн шилжүүлэг орно) — INT-4 transactionCount */
  transactionCount: number;
  /** Үүнээс өөрийн данс хоорондын шилжүүлэг (хасагдсан) */
  ownTransferCount: number;
  /** Хугацаанаас гадуур тул тооцоонд ороогүй */
  outOfPeriodCount: number;
  otherShare: OtherShareReport[] | null;
}

@Injectable()
export class DtiAnalysisService {
  /**
   * Хугацаагаар шүүж (BSA-BR-3) → aggregate (өөрийн шилжүүлэг хасна, BSA-BR-5) → computeBsaDti.
   * Өгөгдлийн алдаа (үл мэдэгдэх ангилал…) BsaAggregationError, буруу параметр RangeError — дуудагч мэдээлнэ.
   */
  analyze(input: DtiAnalysisInput): DtiAnalysisResult {
    const inPeriod = filterByPeriod(input.classified, input.params.periodFrom, input.params.periodTo);
    const categoryMonthly = aggregateCategoryMonthly(inPeriod, input.categories);
    const dti = computeBsaDti(categoryMonthly, input.params);
    return {
      dti,
      categoryMonthly,
      transactionCount: inPeriod.length,
      ownTransferCount: inPeriod.filter((c) => c.result.isOwnTransfer).length,
      outOfPeriodCount: input.classified.length - inPeriod.length,
      otherShare: input.otherShareThreshold === undefined ? null : computeOtherShare(inPeriod, input.categories, input.otherShareThreshold),
    };
  }
}
