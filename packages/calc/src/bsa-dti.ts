// BSA DTI тооцоолол (docs/02 §4, BSA-FR-4, BSA-BR-1…4). Цэвэр функц — I/O байхгүй; BR утгууд параметрээр ирнэ.
// Хуучин `dti.ts` (weightedIncome / dtiIncome / dti) хэвээр; энд тэдгээрийг ашиглан бүтэн шинжилгээг тооцно.
import type { BsaScoringInput } from '@los/contracts';
import type { ScoreRequest } from '@los/contracts';
import type { SoscoInput } from './sosco-score';

export type BsaDtiRole = 'INCOME' | 'DEBT_SERVICE' | 'HOUSEHOLD' | 'BUSINESS_EXPENSE' | 'EXCLUDE' | 'INFO';
export type BsaDtiLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** dtiPercent-ийг JSON-д сериалчлахын тулд хязгаарлах дээд утга (DTI орлого ≤ 0 үед Infinity болдог) */
export const DTI_PERCENT_CAP = 999.9;

/** Ангилал тус бүрийн сарын нийлбэр. Өөрийн данс хоорондын шилжүүлгийг (isOwnTransfer) эндээс өмнө нь хассан байна. */
export interface BsaCategoryMonthly {
  code: string;
  name: string;
  direction: 'INCOME' | 'EXPENSE';
  groupCode: string;
  /** Дайчлах хувь 0..1 (зарлагад 1) */
  weight: number;
  dtiRole: BsaDtiRole;
  /** 'YYYY-MM' → тухайн сарын нийлбэр дүн (эерэг) */
  monthly: Record<string, number>;
  txnCount: number;
}

export interface BsaDtiParams {
  /** YYYY-MM-DD, хоёулаа оролцоно */
  periodFrom: string;
  periodTo: string;
  /** Санал болгосон сарын төлбөр (LOS ЭТХ-ээс, BSA-FR-4.8) */
  proposedMonthlyPayment: number;
  /** ББӨ 0..1 (BSA-BR-1) */
  costOfGoodsRate: number;
  /** ӨОХ-ийн дээд хязгаар 0..1 (BSA-BR-2, анхдагч 0.55) */
  maxDti: number;
  /** ratio ≤ lowMax → LOW; ≤ mediumMax → MEDIUM; бусад HIGH */
  levelThresholds: { lowMax: number; mediumMax: number };
  /** ЦМУ-д орох бизнесийн орлогын ангиллын кодууд */
  businessIncomeCodes: string[];
  /** Орлогын найдварыг бууруулах (хэвийн бус/тогтмол бус/сэжигтэй) ангиллын кодууд (BSA-BR-4) */
  irregularIncomeCodes: string[];
  /** Найдварын 3 бүрдлийн жин (нийлбэр 1) */
  reliabilityWeights: { frequency: number; consistency: number; cleanliness: number };
}

export interface BsaCategorySummary {
  code: string;
  name: string;
  direction: 'INCOME' | 'EXPENSE';
  groupCode: string;
  weight: number;
  dtiRole: BsaDtiRole;
  totalAmount: number;
  monthlyAvg: number;
  /** monthlyAvg × weight (зарлагад monthlyAvg) */
  weightedMonthly: number;
  /** Орлого/зарлага гарсан сарын тоо */
  monthsPresent: number;
  txnCount: number;
  /** Чиглэлийнхээ нийт дүнд эзлэх хувь 0..1 */
  share: number;
}

/** BSA-FR-4.3: тооцооллын аргачлал алхам бүрээр ил (audit trail) */
export interface BsaMethodologyStep {
  step: number;
  key: string;
  label: string;
  formula: string;
  inputs: Record<string, number | string>;
  value: number;
}

export interface BsaDtiResult {
  /** Дундажлах хуваагч: round(өдрийн тоо / 30.4375), доод тал нь 1 */
  periodMonths: number;
  /** Хугацаанд хамрагдсан хуанлийн сарууд 'YYYY-MM' */
  monthKeys: string[];
  /** Бүх INCOME-role ангиллын сарын дундаж нийлбэр (жингүй) */
  totalMonthlyIncome: number;
  /** Жинлэсэн орлого = Σ(monthlyAvg × weight) (docs/02: "баталгаажсан орлого") */
  verifiedMonthlyIncome: number;
  /** verifiedMonthlyIncome × (1 − ББӨ) */
  dtiIncome: number;
  /** Дайчилсан бизнесийн орлого (businessIncomeCodes) */
  businessIncomeMonthly: number;
  /** BUSINESS_EXPENSE role-ын сарын дундаж */
  businessExpenseMonthly: number;
  /** ЦМУ = businessIncomeMonthly − businessExpenseMonthly */
  netCashFlowMonthly: number;
  /** DEBT_SERVICE role-ын сарын дундаж */
  existingDebtServiceMonthly: number;
  /** HOUSEHOLD role-ын сарын дундаж */
  householdExpenseMonthly: number;
  /** 0..100, 1 орон (BSA-BR-4) */
  incomeReliability: number;
  /** (proposed + existingDebtService) / dtiIncome; dtiIncome ≤ 0 үед Infinity */
  dtiRatio: number;
  /** dtiRatio × 100, 1 оронд, DTI_PERCENT_CAP-аар хязгаарлагдсан */
  dtiPercent: number;
  dtiLevel: BsaDtiLevel;
  /** dtiRatio ≤ maxDti */
  meetsLimit: boolean;
  categories: BsaCategorySummary[];
  methodology: BsaMethodologyStep[];
}

/** Хоёр огнооны хоорондох хуанлийн сарууд ('YYYY-MM'), хоёр үзүүр оролцоно. */
export function monthKeysBetween(_from: string, _to: string): string[] {
  throw new Error('TODO(M12b)');
}

/** round(өдөр(from..to хоёул оролцоно) / 30.4375), доод тал нь 1. 2026-03-10..2026-09-10 → 6 */
export function periodMonthsBetween(_from: string, _to: string): number {
  throw new Error('TODO(M12b)');
}

export function classifyDtiLevel(_ratio: number, _t: { lowMax: number; mediumMax: number }): BsaDtiLevel {
  throw new Error('TODO(M12b)');
}

/**
 * BSA-BR-4: найдвар % = 100 × (wF·frequency + wC·consistency + wK·cleanliness)
 *  - frequency   = баталгаажсан орлого (weight>0) гарсан сар / хугацааны сарын тоо
 *  - consistency = clamp(1 − CV, 0, 1); CV = σ/μ (сар бүрийн жинлэсэн баталгаажсан орлого, 0-тэй сар оролцоно)
 *  - cleanliness = 1 − irregular / (verifiedGross + irregular); irregularIncomeCodes-ын нийт дүн
 * Баталгаажсан орлого байхгүй бол 0.
 */
export function incomeReliability(_categories: BsaCategoryMonthly[], _params: BsaDtiParams, _monthKeys: string[]): number {
  throw new Error('TODO(M12b)');
}

export function computeBsaDti(_categories: BsaCategoryMonthly[], _params: BsaDtiParams): BsaDtiResult {
  throw new Error('TODO(M12b)');
}

/** BSA-ийн үр дүн → Тооцоолол/Sosco Score-ийн оролтын хэсэг (INT-5: LOS дээр гараар засахгүй) */
export interface BsaScoringPatch {
  scoreRequest: Pick<ScoreRequest, 'businessNcfMonthly' | 'existingDebtServiceMonthly' | 'householdExpenseMonthly'>;
  sosco: Pick<SoscoInput, 'dtiPercent' | 'incomeReliability' | 'pendingSuspiciousCount'>;
}

export function toScoringPatch(_input: BsaScoringInput): BsaScoringPatch {
  throw new Error('TODO(M12b)');
}
