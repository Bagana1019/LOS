// BsaSettings (admin тохиргоо, NFR-6) → @los/calc-ийн BsaDtiParams. Бизнесийн утга (ББӨ, босго, жин) ЭНД БАЙХГҮЙ — settings-ээс ирнэ.
import type { BsaDtiParams } from '@los/calc';
import type { BsaSettings } from '../common/infra.ports';

export interface DtiRunInput {
  /** YYYY-MM-DD, хоёулаа оролцоно (BSA-BR-3) */
  periodFrom: string;
  periodTo: string;
  /** BSA-FR-4.8: LOS-ын ЭТХ-ээс ирсэн санал болгосон сарын төлбөр */
  proposedMonthlyPayment: number;
  /** BSA-BR-1: бүтээгдэхүүнээс ирвэл тохиргооны ББӨ-г давна */
  costOfGoodsRate?: number;
}

export function toDtiParams(settings: BsaSettings, run: DtiRunInput): BsaDtiParams {
  return {
    periodFrom: run.periodFrom,
    periodTo: run.periodTo,
    proposedMonthlyPayment: run.proposedMonthlyPayment,
    costOfGoodsRate: run.costOfGoodsRate ?? settings.costOfGoodsRate,
    maxDti: settings.maxDti,
    levelThresholds: { ...settings.dtiLevelThresholds },
    businessIncomeCodes: [...settings.businessIncomeCodes],
    irregularIncomeCodes: [...settings.irregularIncomeCodes],
    reliabilityWeights: { ...settings.reliabilityWeights },
  };
}
